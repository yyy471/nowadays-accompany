import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import type { ModelUsage } from "../../domain/model.js";
import type { TokenUsageCallEvent } from "../../domain/token-usage.js";
import type { AppStore, ResourceRecord } from "../../storage/core/app-store.js";
import type { CredentialResolver } from "../resources/credential-resolver.js";
import {
  HttpOpenAiEmbeddingPort,
  embeddingSpaceKey,
  isEmbeddingCompatibleProtocol,
  validateEmbeddingBaseUrl,
  type EmbeddingPort,
} from "./memory-hybrid-search.js";

/**
 * 全局可选 Embedding 配置（409 ARCH-03 / DL-51 方案 A）。
 * 默认关闭；未配置时记忆检索 100% 走既有 FTS5，不产生任何外部调用。
 */
export interface MemoryEmbeddingSettings {
  enabled: boolean;
  resourceId: string | null;
  modelName: string | null;
}

export interface MemoryEmbeddingSettingsView extends MemoryEmbeddingSettings {
  ready: boolean;
}

export const memoryEmbeddingSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    resourceId: z.string().trim().min(1).nullable().optional(),
    modelName: z.string().trim().min(1).nullable().optional(),
  })
  .strict();

export type MemoryEmbeddingSettingsUpdate = z.infer<
  typeof memoryEmbeddingSettingsUpdateSchema
>;

export const memoryEmbeddingTestSchema = z
  .object({
    resourceId: z.string().trim().min(1),
    modelName: z.string().trim().min(1),
  })
  .strict();

export type MemoryEmbeddingTestInput = z.infer<
  typeof memoryEmbeddingTestSchema
>;

export interface MemoryEmbeddingSettingsServiceOptions {
  appStore: AppStore;
  credentials: CredentialResolver;
  now?: () => Date;
  /** 离线测试注入的确定性端口，优先于持久化配置。 */
  overridePort?: EmbeddingPort | null;
  /** 维护守卫：领取一次模型调用；未接纳时不得发出任何请求。 */
  claimModelCall?: (
    roleId: string,
    resourceId: string,
  ) => { admitted: boolean; release: () => void };
  /** 维护窗口检查；维护期间直接视为不可用。 */
  isUnderMaintenance?: (resourceId: string) => boolean;
  /** Token 账本上报（DL-183）。 */
  onModelCallFinished?: (event: TokenUsageCallEvent) => void;
}

const SETTINGS_META_KEY = "memory_embedding_settings";

const DEFAULT_SETTINGS: MemoryEmbeddingSettings = {
  enabled: false,
  resourceId: null,
  modelName: null,
};

const SYSTEM_MEMORY_EMBEDDING_ROLE_ID = "system:memory_embedding";
const SYSTEM_EMBEDDING_TEST_ROLE_ID = "system:embedding_test";

export class MemoryEmbeddingSettingsService {
  private readonly appStore: AppStore;
  private readonly credentials: CredentialResolver;
  private readonly overridePort: EmbeddingPort | null;
  private readonly now: () => Date;
  private readonly claimModelCall:
    | ((
        roleId: string,
        resourceId: string,
      ) => { admitted: boolean; release: () => void })
    | undefined;
  private readonly isUnderMaintenance:
    | ((resourceId: string) => boolean)
    | undefined;
  private readonly onModelCallFinished:
    | ((event: TokenUsageCallEvent) => void)
    | undefined;

  constructor(options: MemoryEmbeddingSettingsServiceOptions) {
    this.appStore = options.appStore;
    this.credentials = options.credentials;
    this.overridePort = options.overridePort ?? null;
    this.now = options.now ?? (() => new Date());
    this.claimModelCall = options.claimModelCall;
    this.isUnderMaintenance = options.isUnderMaintenance;
    this.onModelCallFinished = options.onModelCallFinished;
  }

  get(): MemoryEmbeddingSettingsView {
    const settings = this.read();
    const resource = settings.resourceId === null
      ? null
      : this.tryGetResource(settings.resourceId);
    const ready = this.overridePort !== null || Boolean(
      settings.enabled &&
      settings.resourceId !== null &&
      settings.modelName !== null &&
      resource !== null &&
      resource.kind === "model" &&
      resource.enabled &&
      isEmbeddingCompatibleProtocol(resource.config.protocol) &&
      isValidEmbeddingBaseUrl(resource.config.baseUrl),
    );
    return { ...settings, ready };
  }

  update(input: MemoryEmbeddingSettingsUpdate): MemoryEmbeddingSettingsView {
    const current = this.read();
    const next: MemoryEmbeddingSettings = {
      enabled: input.enabled,
      resourceId: input.resourceId === undefined ? current.resourceId : input.resourceId,
      modelName: input.modelName === undefined ? current.modelName : input.modelName,
    };
    if (next.enabled) {
      if (
        next.resourceId === null ||
        next.modelName === null ||
        next.resourceId.trim().length === 0 ||
        next.modelName.trim().length === 0
      ) {
        throw invalidSettings("开启混合检索需要选择 Embedding 模型资源与模型名称");
      }
      const resource = this.tryGetResource(next.resourceId);
      if (resource === null || resource.kind !== "model") {
        throw invalidSettings("Embedding 资源配置不存在或不是模型资源");
      }
      if (!isEmbeddingCompatibleProtocol(resource.config.protocol)) {
        throw invalidSettings("当前仅支持 OpenAI 兼容协议的模型服务用于记忆语义检索");
      }
      try {
        validateEmbeddingBaseUrl(resource.config.baseUrl);
      } catch {
        throw invalidSettings("Embedding 模型服务地址无效，仅支持 http/https");
      }
    }
    this.appStore.setMeta(SETTINGS_META_KEY, JSON.stringify(next));
    return this.get();
  }

  /**
   * 解析当前可用的 Embedding 端口。配置不完整、资源失效、协议不兼容、
   * 地址非法、凭据不可解或服务维护中时返回 null，由检索层静默退回纯 FTS5。
   */
  resolvePort(roleId?: string): EmbeddingPort | null {
    if (this.overridePort !== null) {
      return this.overridePort;
    }
    const settings = this.read();
    if (
      !settings.enabled ||
      settings.resourceId === null ||
      settings.modelName === null
    ) {
      return null;
    }
    const resourceId = settings.resourceId;
    const modelName = settings.modelName;
    try {
      const resource = this.appStore.getResource(resourceId);
      if (resource.kind !== "model" || !resource.enabled) {
        return null;
      }
      const protocol = resource.config.protocol;
      if (!isEmbeddingCompatibleProtocol(protocol)) {
        return null;
      }
      let baseUrl: string;
      try {
        baseUrl = validateEmbeddingBaseUrl(resource.config.baseUrl);
      } catch {
        return null;
      }
      // 维护期间绝不发出请求：连端口都不创建，检索层直接退回 FTS5。
      if (this.isUnderMaintenance?.(resourceId) === true) {
        return null;
      }
      const credentialRef = typeof resource.config.credentialRef === "string"
        ? resource.config.credentialRef
        : undefined;
      const apiKey = this.credentials.resolve(resourceId, credentialRef);
      const modelKey = embeddingSpaceKey({
        resourceId,
        baseUrl,
        protocol,
        provider: providerOf(resource),
        modelName,
      });
      const inner = new HttpOpenAiEmbeddingPort({
        modelKey,
        resourceId,
        baseUrl,
        modelName,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
      return this.guardPort(inner, resource, modelName, protocol, roleId);
    } catch {
      return null;
    }
  }

  /**
   * 主动测试 Embedding 连接（仅限 OpenAI 兼容协议）。
   * 失败信息只暴露可安全展示的错误类别，绝不回显密钥或上游正文。
   */
  async testConnection(
    input: MemoryEmbeddingTestInput,
    signal?: AbortSignal,
  ): Promise<{ ok: true; dimensions: number; modelName: string }> {
    const resource = this.tryGetResource(input.resourceId);
    if (resource === null || resource.kind !== "model") {
      throw invalidSettings("Embedding 资源配置不存在或不是模型资源");
    }
    if (!resource.enabled) {
      throw invalidSettings("Embedding 模型服务已停用");
    }
    const protocol = resource.config.protocol;
    if (!isEmbeddingCompatibleProtocol(protocol)) {
      throw invalidSettings("当前仅支持 OpenAI 兼容协议的模型服务用于记忆语义检索");
    }
    let baseUrl: string;
    try {
      baseUrl = validateEmbeddingBaseUrl(resource.config.baseUrl);
    } catch {
      throw invalidSettings("Embedding 模型服务地址无效，仅支持 http/https");
    }
    if (this.isUnderMaintenance?.(resource.resourceId) === true) {
      throw new AppError(
        409,
        "RESOURCE_UNDER_MAINTENANCE",
        "该模型服务正在维护中，请稍后再试",
      );
    }
    const credentialRef = typeof resource.config.credentialRef === "string"
      ? resource.config.credentialRef
      : undefined;
    const apiKey = this.credentials.resolve(resource.resourceId, credentialRef);
    const port = new HttpOpenAiEmbeddingPort({
      modelKey: embeddingSpaceKey({
        resourceId: resource.resourceId,
        baseUrl,
        protocol,
        provider: providerOf(resource),
        modelName: input.modelName,
      }),
      resourceId: resource.resourceId,
      baseUrl,
      modelName: input.modelName,
      ...(apiKey === undefined ? {} : { apiKey }),
    });
    const claim = this.claimModelCall?.(
      SYSTEM_EMBEDDING_TEST_ROLE_ID,
      resource.resourceId,
    );
    if (claim !== undefined && !claim.admitted) {
      throw new AppError(
        409,
        "RESOURCE_UNDER_MAINTENANCE",
        "该模型服务正在维护中，请稍后再试",
      );
    }
    const occurredAt = this.now().toISOString();
    try {
      const result = await port.embedWithUsage(
        ["nowadays embedding check"],
        signal,
      );
      const vector = result.vectors[0];
      if (vector === undefined) {
        throw new Error("EMBEDDING_RESPONSE_INVALID");
      }
      this.onModelCallFinished?.({
        sourceCallId: randomUUID(),
        roleId: null,
        resourceId: resource.resourceId,
        resourceName: resource.name,
        provider: typeof resource.config.provider === "string"
          ? resource.config.provider
          : null,
        protocol,
        modelName: input.modelName,
        category: "connection_test",
        status: "succeeded",
        occurredAt,
        usage: result.usage,
      });
      return {
        ok: true,
        dimensions: vector.length,
        modelName: input.modelName,
      };
    } catch (error) {
      this.onModelCallFinished?.({
        sourceCallId: randomUUID(),
        roleId: null,
        resourceId: resource.resourceId,
        resourceName: resource.name,
        provider: typeof resource.config.provider === "string"
          ? resource.config.provider
          : null,
        protocol,
        modelName: input.modelName,
        category: "connection_test",
        status: "failed",
        occurredAt: this.now().toISOString(),
        usage: null,
      });
      throw toEmbeddingTestError(error);
    } finally {
      claim?.release();
    }
  }

  /**
   * 把 HTTP 端口包上维护领取与账本上报：
   * - 领取失败时在 fetch 之前抛出，绝不触网；
   * - 只有真正发起过请求的失败才记 failed，维护拒绝不产生调用记录；
   * - `release` 在 finally 中释放，确保在途登记不泄漏。
   */
  private guardPort(
    inner: EmbeddingPort,
    resource: ResourceRecord,
    modelName: string,
    protocol: "openai-chat" | "openai-responses",
    roleId: string | undefined,
  ): EmbeddingPort {
    const claimRoleId = roleId ?? SYSTEM_MEMORY_EMBEDDING_ROLE_ID;
    const service = this;
    const run = async (
      texts: readonly string[],
      signal?: AbortSignal,
    ): Promise<{ vectors: Float32Array[]; usage: ModelUsage | null }> => {
      const claim = service.claimModelCall?.(claimRoleId, resource.resourceId);
      if (claim !== undefined && !claim.admitted) {
        throw new Error("EMBEDDING_RESOURCE_UNDER_MAINTENANCE");
      }
      try {
        const result = (await inner.embedWithUsage?.(texts, signal)) ?? {
          vectors: await inner.embed(texts, signal),
          usage: null,
        };
        service.onModelCallFinished?.({
          sourceCallId: randomUUID(),
          roleId: roleId ?? null,
          resourceId: resource.resourceId,
          resourceName: resource.name,
          provider: typeof resource.config.provider === "string"
            ? resource.config.provider
            : null,
          protocol,
          modelName,
          category: "memory",
          status: "succeeded",
          occurredAt: service.now().toISOString(),
          usage: result.usage,
        });
        return result;
      } catch (error) {
        service.onModelCallFinished?.({
          sourceCallId: randomUUID(),
          roleId: roleId ?? null,
          resourceId: resource.resourceId,
          resourceName: resource.name,
          provider: typeof resource.config.provider === "string"
            ? resource.config.provider
            : null,
          protocol,
          modelName,
          category: "memory",
          status: "failed",
          occurredAt: service.now().toISOString(),
          usage: null,
        });
        throw error;
      } finally {
        claim?.release();
      }
    };
    return {
      modelKey: inner.modelKey,
      ...(inner.resourceId === undefined ? {} : { resourceId: inner.resourceId }),
      embed: async (texts, signal) => (await run(texts, signal)).vectors,
      embedWithUsage: run,
    };
  }

  /**
   * 运行时实际启用的全局 Embedding 资源；未配置、停用或配置无法发起新调用时为 null。
   * 资源影响与维护计划用它判断「所有角色记忆检索都依赖该模型服务」；
   * 已停用／协议不兼容／地址非法的选择不计入依赖，不会因此暂停角色。
   */
  activeResourceId(): string | null {
    const settings = this.read();
    if (
      !settings.enabled ||
      settings.resourceId === null ||
      settings.modelName === null
    ) {
      return null;
    }
    const resource = this.tryGetResource(settings.resourceId);
    if (
      resource === null ||
      resource.kind !== "model" ||
      !resource.enabled ||
      !isEmbeddingCompatibleProtocol(resource.config.protocol) ||
      !isValidEmbeddingBaseUrl(resource.config.baseUrl)
    ) {
      return null;
    }
    return resource.resourceId;
  }

  /**
   * 资源删除时清理指向它的全局配置（无论当前是否启用），避免悬挂。
   * 只清理同一资源的选择；指向其他资源的设置原样保留。
   */
  clearResource(resourceId: string): boolean {
    const settings = this.read();
    if (settings.resourceId !== resourceId) {
      return false;
    }
    this.appStore.setMeta(SETTINGS_META_KEY, JSON.stringify(DEFAULT_SETTINGS));
    return true;
  }

  private read(): MemoryEmbeddingSettings {
    const raw = this.appStore.getMeta(SETTINGS_META_KEY);
    if (raw === null) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const parsed = z
        .object({
          enabled: z.boolean(),
          resourceId: z.string().nullable(),
          modelName: z.string().nullable(),
        })
        .parse(JSON.parse(raw));
      return {
        enabled: parsed.enabled,
        resourceId: parsed.resourceId,
        modelName: parsed.modelName,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private tryGetResource(resourceId: string): ResourceRecord | null {
    try {
      return this.appStore.getResource(resourceId);
    } catch {
      return null;
    }
  }
}

function isValidEmbeddingBaseUrl(baseUrl: unknown): boolean {
  try {
    validateEmbeddingBaseUrl(baseUrl);
    return true;
  } catch {
    return false;
  }
}

function providerOf(resource: ResourceRecord): string | null {
  return typeof resource.config.provider === "string"
    ? resource.config.provider
    : null;
}

function invalidSettings(message: string): AppError {
  return new AppError(400, "EMBEDDING_SETTINGS_INVALID", message);
}

/** 把外部失败收敛成不泄漏凭据/正文的安全错误。 */
function toEmbeddingTestError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : "";
  if (message === "EMBEDDING_REDIRECT_BLOCKED") {
    return new AppError(
      502,
      "EMBEDDING_TEST_FAILED",
      "模型服务返回重定向，已拒绝跟随",
    );
  }
  const httpStatus = /^EMBEDDING_HTTP_(\d{3})$/.exec(message);
  if (httpStatus !== null) {
    return new AppError(
      502,
      "EMBEDDING_TEST_FAILED",
      `Embedding 接口返回 HTTP ${httpStatus[1]}`,
    );
  }
  if (
    message === "EMBEDDING_TIMEOUT" ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new AppError(502, "EMBEDDING_TEST_FAILED", "Embedding 连接测试超时");
  }
  if (message === "EMBEDDING_RESPONSE_TOO_LARGE") {
    return new AppError(
      502,
      "EMBEDDING_TEST_FAILED",
      "Embedding 响应超过大小上限",
    );
  }
  return new AppError(502, "EMBEDDING_TEST_FAILED", "Embedding 连接测试失败");
}
