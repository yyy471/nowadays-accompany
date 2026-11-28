import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import type { AppStore, ResourceRecord } from "../../storage/core/app-store.js";
import type { CredentialResolver } from "../resources/credential-resolver.js";
import {
  HttpOpenAiEmbeddingPort,
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

export interface MemoryEmbeddingSettingsServiceOptions {
  appStore: AppStore;
  credentials: CredentialResolver;
  now?: () => Date;
  /** 离线测试注入的确定性端口，优先于持久化配置。 */
  overridePort?: EmbeddingPort | null;
}

const SETTINGS_META_KEY = "memory_embedding_settings";

const DEFAULT_SETTINGS: MemoryEmbeddingSettings = {
  enabled: false,
  resourceId: null,
  modelName: null,
};

export class MemoryEmbeddingSettingsService {
  private readonly appStore: AppStore;
  private readonly credentials: CredentialResolver;
  private readonly overridePort: EmbeddingPort | null;

  constructor(options: MemoryEmbeddingSettingsServiceOptions) {
    this.appStore = options.appStore;
    this.credentials = options.credentials;
    this.overridePort = options.overridePort ?? null;
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
      resource.enabled,
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
    }
    this.appStore.setMeta(SETTINGS_META_KEY, JSON.stringify(next));
    return this.get();
  }

  /**
   * 解析当前可用的 Embedding 端口。配置不完整、资源失效或凭据不可解时
   * 返回 null，由检索层静默退回纯 FTS5。
   */
  resolvePort(): EmbeddingPort | null {
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
    try {
      const resource = this.appStore.getResource(settings.resourceId);
      if (resource.kind !== "model" || !resource.enabled) {
        return null;
      }
      const baseUrl = resource.config.baseUrl;
      if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
        return null;
      }
      const credentialRef = typeof resource.config.credentialRef === "string"
        ? resource.config.credentialRef
        : undefined;
      const apiKey = this.credentials.resolve(settings.resourceId, credentialRef);
      return new HttpOpenAiEmbeddingPort({
        modelKey: `${settings.resourceId}:${settings.modelName}`,
        baseUrl,
        modelName: settings.modelName,
        ...(apiKey === undefined ? {} : { apiKey }),
      });
    } catch {
      return null;
    }
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

function invalidSettings(message: string): AppError {
  return new AppError(400, "EMBEDDING_SETTINGS_INVALID", message);
}
