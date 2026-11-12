import { createHash } from "node:crypto";
import {
  AppError,
  InvalidResourceConfigError,
  ModelRequestFailedError,
  ResourceCredentialStaleError,
  ResourceKindMismatchError,
} from "../domain/errors.js";
import { isIncompleteCompletion } from "../domain/model.js";
import { modelConfigSchema } from "../domain/resource.js";
import type {
  ModelEvent,
  ModelListResult,
  ModelServiceConfig,
  ModelServiceProbe,
  ModelServiceTest,
  ModelTestResult,
} from "../domain/model.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
import type { AppStore, ModelTestCallRecord } from "../storage/app-store.js";
import type { CredentialResolver } from "./credential-resolver.js";

export interface ModelServiceOptions {
  now?: () => Date;
  credentialResolver?: CredentialResolver;
  /** 主动连接测试的等待上限；超时按可追溯的失败记录。 */
  testTimeoutMs?: number;
}

export interface ModelTestSummary {
  ok: boolean;
  status: "succeeded" | "failed";
  modelName: string;
  protocol: ModelServiceConfig["protocol"];
  errorCode: string | null;
  finishedAt: string;
  elapsedMs: number;
  /** 当前配置或密钥与这次测试不一致时为 true，界面应提示重新测试。 */
  stale: boolean;
}

// 连接测试的内部输出预算；避免思考模型把 16 token 全部用在思考上而无正文。
const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;

export class ModelService {
  private readonly now: () => Date;
  private readonly credentials: CredentialResolver | null;
  private readonly testTimeoutMs: number;

  constructor(
    private readonly appStore: AppStore,
    private readonly appRoot: string,
    options: ModelServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.credentials = options.credentialResolver ?? null;
    this.testTimeoutMs = options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  async listModels(
    config: ModelServiceProbe,
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelListResult> {
    const adapter = this.probeAdapter(config);
    return {
      models: await adapter.listModels(options.signal),
    };
  }

  async test(config: ModelServiceTest): Promise<ModelTestResult> {
    const fingerprint = fingerprintOf(config, this.probeSaltOf(config));
    return this.runTest({
      config,
      model: config.model,
      createAdapter: () => this.probeAdapter(config),
      resourceId: null,
      fingerprint,
    });
  }

  /** 按已保存资源列模型：使用该资源的配置和统一凭据解析。 */
  async listModelsForResource(
    resourceId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ModelListResult> {
    const { config } = this.requireModelResource(resourceId);
    const adapter = this.savedAdapter(resourceId, config);
    return {
      models: await adapter.listModels(options.signal),
    };
  }

  /** 按已保存资源测试连接：记录归属该资源，并带上当前配置指纹。 */
  async testForResource(
    resourceId: string,
    model: string,
  ): Promise<ModelTestResult> {
    const { config } = this.requireModelResource(resourceId);
    const fingerprint = fingerprintOf(
      config,
      this.saltForSaved(resourceId, config),
    );
    return this.runTest({
      config,
      model,
      createAdapter: () => this.savedAdapter(resourceId, config),
      resourceId,
      fingerprint,
    });
  }

  /** 资源详情里的最近一次测试摘要；没有记录时返回 null。 */
  latestTestSummary(
    resourceId: string,
    config: ModelServiceConfig,
  ): ModelTestSummary | null {
    const record = this.appStore.latestModelTestCall(resourceId);
    if (record === null) {
      return null;
    }
    return summarizeModelTest(
      record,
      config,
      this.saltForSaved(resourceId, config),
    );
  }

  private async runTest(input: {
    config: ModelServiceProbe;
    model: string;
    createAdapter: () => HttpModelAdapter;
    resourceId: string | null;
    fingerprint: string;
  }): Promise<ModelTestResult> {
    const startedAt = this.now();
    const startedMs = startedAt.getTime();
    let status: "succeeded" | "failed" = "failed";
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let usageJson: string | null = null;
    const testTimeout = AbortSignal.timeout(this.testTimeoutMs);
    try {
      const adapter = input.createAdapter();
      let usage: { inputTokens?: number; outputTokens?: number } | null = null;
      let sawOutput = false;
      let completed = false;
      let incomplete = false;
      for await (const event of adapter.stream({
        modelName: input.model,
        system: "Reply with the single word pong.",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
        signal: testTimeout,
      })) {
        if (
          (event.type === "text_delta" && event.text.length > 0) ||
          event.type === "tool_call"
        ) {
          sawOutput = true;
        }
        if (event.type === "usage") {
          usage = {
            ...(event.inputTokens === undefined
              ? {}
              : { inputTokens: event.inputTokens }),
            ...(event.outputTokens === undefined
              ? {}
              : { outputTokens: event.outputTokens }),
          };
        }
        if (event.type === "completed") {
          completed = true;
          incomplete = isIncompleteCompletion(event);
          break;
        }
      }
      if (!completed) {
        throw new ModelRequestFailedError("模型连接测试未收到完整终态", {
          reason: "STREAM_TRUNCATED",
        });
      }
      if (!sawOutput && !incomplete) {
        throw new ModelRequestFailedError("模型连接测试未收到有效输出", {
          reason: "EMPTY_RESPONSE",
        });
      }
      status = "succeeded";
      usageJson = usage === null ? null : JSON.stringify(usage);
    } catch (error) {
      if (testTimeout.aborted) {
        errorCode = "MODEL_REQUEST_TIMEOUT";
        errorMessage = `模型连接测试超过 ${this.testTimeoutMs}ms 未完成`;
      } else {
        errorCode =
          error instanceof AppError ? error.code : "MODEL_REQUEST_FAILED";
        errorMessage =
          error instanceof Error ? error.message : "模型请求失败";
      }
    }
    const finishedAt = this.now();
    this.appStore.saveModelTestCall({
      resourceId: input.resourceId,
      modelName: input.model,
      protocol: input.config.protocol,
      status,
      errorCode,
      configFingerprint: input.fingerprint,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      usageJson,
    });
    if (status === "succeeded") {
      return {
        ok: true,
        elapsedMs: finishedAt.getTime() - startedMs,
        fingerprint: input.fingerprint,
      };
    }
    return {
      ok: false,
      elapsedMs: finishedAt.getTime() - startedMs,
      fingerprint: input.fingerprint,
      error: {
        code: errorCode ?? "MODEL_REQUEST_FAILED",
        message: errorMessage ?? "模型请求失败",
      },
    };
  }

  /**
   * 候选配置的适配器。带 `resourceId` 且未另填密钥时以已保存资源为基准
   * 解析密钥；协议与 origin 不一致时拒绝复用（268 §2）。
   */
  private probeAdapter(config: ModelServiceProbe): HttpModelAdapter {
    if (config.resourceId !== undefined && config.secret === undefined) {
      const { config: saved } = this.requireModelResource(config.resourceId);
      const from = serviceIdentity(saved);
      const to = serviceIdentity(config);
      if (from !== to) {
        throw new ResourceCredentialStaleError({ from, to });
      }
      const credential =
        this.credentials === null
          ? resolveCredential(this.appRoot, saved.credentialRef)
          : this.credentials.resolve(config.resourceId, saved.credentialRef);
      return new HttpModelAdapter(config, credential);
    }
    const credential =
      config.secret ?? resolveCredential(this.appRoot, config.credentialRef);
    return new HttpModelAdapter(config, credential);
  }

  /** 候选配置的指纹盐：复用已保存密钥时随资源的密钥版本失效。 */
  private probeSaltOf(config: ModelServiceProbe): string {
    if (config.resourceId !== undefined && config.secret === undefined) {
      const { config: saved } = this.requireModelResource(config.resourceId);
      return this.saltForSaved(config.resourceId, saved);
    }
    return probeSalt(config);
  }

  private savedAdapter(
    resourceId: string,
    config: ModelServiceConfig,
  ): HttpModelAdapter {
    if (this.credentials === null) {
      return new HttpModelAdapter(
        config,
        resolveCredential(this.appRoot, config.credentialRef),
      );
    }
    return new HttpModelAdapter(
      config,
      this.credentials.resolve(resourceId, config.credentialRef),
    );
  }

  private saltForSaved(
    resourceId: string,
    config: ModelServiceConfig,
  ): string {
    if (this.credentials === null) {
      return `reference:${config.credentialRef ?? "none"}`;
    }
    return this.credentials.fingerprintSalt(
      resourceId,
      config.credentialRef,
    );
  }

  private requireModelResource(resourceId: string): {
    config: ModelServiceConfig;
  } {
    const resource = this.appStore.getResource(resourceId);
    if (resource.kind !== "model") {
      throw new ResourceKindMismatchError(
        "model_probe",
        "model",
        resource.kind,
      );
    }
    const parsed = modelConfigSchema.safeParse(resource.config);
    if (!parsed.success) {
      throw new InvalidResourceConfigError(
        "model",
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      );
    }
    return { config: parsed.data };
  }
}

/** 协议相同且 origin 相同视为同一个服务；同站点换路径允许复用已存密钥。 */
function serviceIdentity(config: ModelServiceConfig): string {
  try {
    return `${config.protocol} ${new URL(config.baseUrl).origin}`;
  } catch {
    return `${config.protocol} ${config.baseUrl}`;
  }
}

function probeSalt(config: ModelServiceProbe): string {  if (config.secret !== undefined) {
    return `probe-secret:${createHash("sha256").update(config.secret).digest("hex").slice(0, 16)}`;
  }
  return config.credentialRef === undefined
    ? "probe-none"
    : `probe-reference:${config.credentialRef}`;
}

export function fingerprintOf(
  config: ModelServiceConfig,
  salt: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        salt,
      }),
    )
    .digest("hex")
    .slice(0, 32);
}

/** 把测试记录转换成资源视图里的摘要，并按当前配置判断是否过期。 */
export function summarizeModelTest(
  record: ModelTestCallRecord,
  config: ModelServiceConfig,
  salt: string,
): ModelTestSummary {
  return {
    ok: record.status === "succeeded",
    status: record.status,
    modelName: record.modelName,
    protocol: record.protocol,
    errorCode: record.errorCode,
    finishedAt: record.finishedAt,
    elapsedMs: Math.max(
      0,
      Date.parse(record.finishedAt) - Date.parse(record.startedAt),
    ),
    stale: record.configFingerprint !== fingerprintOf(config, salt),
  };
}

export type { ModelEvent };
