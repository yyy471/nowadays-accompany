import { randomUUID } from "node:crypto";
import {
  ImageServiceNotFoundError,
  InvalidImageServiceConfigError,
  ResourceCredentialConflictError,
  ResourceCredentialStaleError,
} from "../domain/errors.js";
import {
  imageServiceConfigSchema,
  imageServiceSiteIdentity,
  type ImageServiceConfig,
  type ImageServiceProbeResult,
  type ImageServiceRecord,
  type ImageServiceView,
} from "../domain/image-service.js";
import { ImageServiceStore } from "../storage/image-service-store.js";
import type { AppStore } from "../storage/app-store.js";
import { ComfyUiClient } from "../scene/comfyui-client.js";
import {
  defaultComfyWorkflow,
  validateComfyWorkflow,
  type ComfyWorkflow,
} from "../scene/comfyui-workflow.js";
import type { CredentialResolver } from "./credential-resolver.js";

export interface ImageServiceServiceOptions {
  credentialResolver: CredentialResolver;
  now?: () => Date;
  /** 探测的整体等待上限。 */
  probeTimeoutMs?: number;
}

export interface CreateImageServiceInput {
  name: string;
  config: unknown;
  enabled?: boolean | undefined;
  /** 只写密钥；创建时与配置同一事务落库。 */
  secret?: string | undefined;
}

export interface UpdateImageServiceInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  config?: unknown;
  /** undefined 保留、null 清除、字符串替换。 */
  secret?: string | null | undefined;
}

export interface ImageServiceDraftInput {
  serviceId?: string | undefined;
  config: unknown;
  secret?: string | undefined;
}

export interface ProbeDraftImageServiceInput extends ImageServiceDraftInput {
  workflow?: Record<string, unknown> | null | undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

/**
 * 全局生图服务。ComfyUI 一个地址可以跑多种模型，所以连接与模型分开：
 * 这里只存地址和凭据，角色配置里再选模型与工作流。
 */
export class ImageServiceService {
  private readonly credentials: CredentialResolver;
  private readonly now: () => Date;
  private readonly probeTimeoutMs: number;

  constructor(
    private readonly appStore: AppStore,
    options: ImageServiceServiceOptions,
  ) {
    this.credentials = options.credentialResolver;
    this.now = options.now ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  private get store(): ImageServiceStore {
    return new ImageServiceStore(this.appStore.db);
  }

  list(): ImageServiceView[] {
    return this.store.list().map((record) => this.toView(record));
  }

  get(serviceId: string): ImageServiceView {
    return this.toView(this.store.get(serviceId));
  }

  create(input: CreateImageServiceInput): ImageServiceView {
    const config = this.parseConfig(input.config);
    if (input.secret !== undefined && config.credentialRef !== undefined) {
      throw new ResourceCredentialConflictError();
    }
    const serviceId = randomUUID();
    const now = this.now().toISOString();
    this.appStore.db.transaction(() => {
      this.store.create({
        serviceId,
        name: input.name,
        enabled: input.enabled ?? true,
        config,
        now,
      });
      if (input.secret !== undefined) {
        this.credentials.setSecret(serviceId, input.secret, now);
      }
    })();
    return this.get(serviceId);
  }

  update(serviceId: string, input: UpdateImageServiceInput): ImageServiceView {
    const current = this.store.get(serviceId);
    const config =
      input.config === undefined ? undefined : this.parseConfig(input.config);
    const replacingSecret =
      typeof input.secret === "string" ? input.secret : undefined;
    const nextConfig = config ?? current.config;
    const keepsStoredSecret =
      input.secret === undefined && this.credentials.hasStoredSecret(serviceId);
    if (
      (replacingSecret !== undefined || keepsStoredSecret) &&
      nextConfig.credentialRef !== undefined
    ) {
      // 直填密钥与 env:/file: 引用二选一，避免两套凭据并存。
      throw new ResourceCredentialConflictError();
    }
    const from = imageServiceSiteIdentity(current.config);
    const to = imageServiceSiteIdentity(nextConfig);
    if (from !== to) {
      const referenceUnchanged =
        nextConfig.credentialRef !== undefined &&
        nextConfig.credentialRef === current.config.credentialRef;
      if (keepsStoredSecret || (replacingSecret === undefined && referenceUnchanged)) {
        // 换站点后旧凭据会被发到未确认的新服务。
        throw new ResourceCredentialStaleError({ from, to });
      }
    }
    const now = this.now().toISOString();
    this.appStore.db.transaction(() => {
      this.store.update({
        serviceId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(config === undefined ? {} : { config }),
        now,
      });
      if (replacingSecret !== undefined) {
        this.credentials.setSecret(serviceId, replacingSecret, now);
      } else if (input.secret === null) {
        this.credentials.clearSecret(serviceId);
      }
    })();
    return this.get(serviceId);
  }

  delete(serviceId: string): { serviceId: string; deleted: true } {
    let removed = false;
    this.appStore.db.transaction(() => {
      this.store.get(serviceId);
      this.credentials.clearSecret(serviceId);
      removed = this.store.delete(serviceId);
    })();
    if (!removed) {
      throw new ImageServiceNotFoundError(serviceId);
    }
    return { serviceId, deleted: true };
  }

  /**
   * 临时解析候选连接（草稿探测／草稿测试生图），不写入库表。
   * 复用已保存密钥或旧引用时严格核对协议与 origin，防止把凭据发给未确认新站点。
   */
  resolveDraftConnection(input: ImageServiceDraftInput): {
    record: ImageServiceRecord;
    token: string | undefined;
  } {
    const config = this.parseConfig(input.config);
    if (input.secret !== undefined && config.credentialRef !== undefined) {
      throw new ResourceCredentialConflictError();
    }
    const saved =
      input.serviceId === undefined ? null : this.store.get(input.serviceId);
    let token: string | undefined;
    if (input.secret !== undefined) {
      token = input.secret;
    } else if (config.credentialRef !== undefined) {
      if (saved !== null && config.credentialRef === saved.config.credentialRef) {
        const from = imageServiceSiteIdentity(saved.config);
        const to = imageServiceSiteIdentity(config);
        if (from !== to) {
          throw new ResourceCredentialStaleError({ from, to });
        }
      }
      token = this.credentials.resolveReference(config.credentialRef);
    } else if (saved !== null) {
      const from = imageServiceSiteIdentity(saved.config);
      const to = imageServiceSiteIdentity(config);
      const keepsCredential =
        this.credentials.hasStoredSecret(saved.serviceId) ||
        saved.config.credentialRef !== undefined;
      if (from !== to && keepsCredential) {
        throw new ResourceCredentialStaleError({ from, to });
      }
      token = this.credentials.resolve(
        saved.serviceId,
        saved.config.credentialRef,
      );
    }
    const now = this.now().toISOString();
    return {
      record: {
        serviceId: saved?.serviceId ?? "__draft__",
        name: saved?.name ?? "草稿生图服务",
        enabled: saved?.enabled ?? true,
        config,
        createdAt: saved?.createdAt ?? now,
        updatedAt: now,
      },
      token,
    };
  }

  /** 探测已保存的服务：节点清单决定内置工作流能否直接跑。 */
  async probe(serviceId: string): Promise<ImageServiceProbeResult> {
    const connection = this.resolveConnection(serviceId);
    return this.probeConnection(connection, defaultComfyWorkflow());
  }

  /** 探测未保存的草稿生图服务连接，不修改已保存服务记录与密钥。 */
  async probeDraft(
    input: ProbeDraftImageServiceInput,
  ): Promise<ImageServiceProbeResult> {
    const connection = this.resolveDraftConnection(input);
    const workflow =
      input.workflow === undefined || input.workflow === null
        ? defaultComfyWorkflow()
        : validateComfyWorkflow(input.workflow);
    return this.probeConnection(connection, workflow);
  }

  async probeConnection(
    connection: { record: ImageServiceRecord; token: string | undefined },
    workflow: ComfyWorkflow,
  ): Promise<ImageServiceProbeResult> {
    const started = Date.now();
    const client = new ComfyUiClient({
      baseUrl: connection.record.config.baseUrl,
      token: connection.token,
      requestTimeoutMs: this.probeTimeoutMs,
      generationTimeoutMs: this.probeTimeoutMs,
    });
    const probe = await client.probe(workflow);
    return { probe, elapsedMs: Date.now() - started };
  }

  /**
   * 只取服务记录，不解析凭据。配置展示与关联校验不该因为
   * 密钥暂时缺失而失败；探测和生成再走 resolveConnection。
   */
  findRecord(serviceId: string): ImageServiceRecord | null {
    return this.store.find(serviceId);
  }

  /**
   * 取服务记录与解析后的令牌。密钥缺失不在这里报错：
   * ComfyUI 常常不带认证，等真正请求时再由服务端判定。
   */
  resolveConnection(serviceId: string): {
    record: ImageServiceRecord;
    token: string | undefined;
  } {
    const record = this.store.get(serviceId);
    const reference = record.config.credentialRef;
    const token = this.credentials.resolve(serviceId, reference);
    return { record, token };
  }

  findConnection(serviceId: string): {
    record: ImageServiceRecord;
    token: string | undefined;
  } | null {
    const record = this.store.find(serviceId);
    if (record === null) {
      return null;
    }
    return {
      record,
      token: this.credentials.resolve(serviceId, record.config.credentialRef),
    };
  }

  private toView(record: ImageServiceRecord): ImageServiceView {
    return {
      ...record,
      credential: this.credentials.summary(
        record.serviceId,
        record.config.credentialRef,
      ),
    };
  }

  private parseConfig(value: unknown): ImageServiceConfig {
    const result = imageServiceConfigSchema.safeParse(value);
    if (!result.success) {
      throw new InvalidImageServiceConfigError(
        result.error.issues.map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
