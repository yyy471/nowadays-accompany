import {
  AppError,
  ModelRequestFailedError,
} from "../domain/errors.js";
import { isIncompleteCompletion } from "../domain/model.js";
import type {
  ModelEvent,
  ModelListResult,
  ModelServiceConfig,
  ModelServiceTest,
  ModelTestResult,
} from "../domain/model.js";
import { resolveCredential } from "../model/credentials.js";
import { HttpModelAdapter } from "../model/protocols.js";
import type { AppStore } from "../storage/app-store.js";

export interface ModelServiceOptions {
  now?: () => Date;
}

// 连接测试的内部输出预算；避免思考模型把 16 token 全部用在思考上而无正文。
const CONNECTION_TEST_MAX_OUTPUT_TOKENS = 1024;

export class ModelService {
  private readonly now: () => Date;

  constructor(
    private readonly appStore: AppStore,
    private readonly appRoot: string,
    options: ModelServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async listModels(config: ModelServiceConfig): Promise<ModelListResult> {
    const adapter = this.adapter(config);
    return { models: await adapter.listModels() };
  }

  async test(config: ModelServiceTest): Promise<ModelTestResult> {
    const startedAt = this.now();
    const startedMs = startedAt.getTime();
    let status: "succeeded" | "failed" = "failed";
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    let usageJson: string | null = null;
    try {
      const adapter = this.adapter(config);
      let usage: { inputTokens?: number; outputTokens?: number } | null = null;
      let sawOutput = false;
      let completed = false;
      let incomplete = false;
      for await (const event of adapter.stream({
        modelName: config.model,
        system: "Reply with the single word pong.",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        maxOutputTokens: CONNECTION_TEST_MAX_OUTPUT_TOKENS,
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
      errorCode =
        error instanceof AppError
          ? error.code
          : "MODEL_REQUEST_FAILED";
      errorMessage =
        error instanceof Error ? error.message : "模型请求失败";
    }
    const finishedAt = this.now();
    this.appStore.saveModelTestCall({
      resourceId: null,
      modelName: config.model,
      protocol: config.protocol,
      status,
      errorCode,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      usageJson,
    });
    if (status === "succeeded") {
      return {
        ok: true,
        elapsedMs: finishedAt.getTime() - startedMs,
      };
    }
    return {
      ok: false,
      elapsedMs: finishedAt.getTime() - startedMs,
      error: {
        code: errorCode ?? "MODEL_REQUEST_FAILED",
        message: errorMessage ?? "模型请求失败",
      },
    };
  }

  private adapter(config: ModelServiceConfig): HttpModelAdapter {
    return new HttpModelAdapter(
      config,
      resolveCredential(this.appRoot, config.credentialRef),
    );
  }
}

export type { ModelEvent };
