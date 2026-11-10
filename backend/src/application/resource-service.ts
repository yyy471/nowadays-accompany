import { randomUUID } from "node:crypto";
import {
  BindingConflictError,
  InvalidBindingError,
  InvalidResourceConfigError,
  ResourceCredentialConflictError,
  ResourceCredentialStaleError,
  ResourceKindMismatchError,
} from "../domain/errors.js";
import {
  modelConfigSchema,
  parseResourceConfig,
  type ResourceKind,
} from "../domain/resource.js";
import type {
  AppStore,
  ResourceRecord,
} from "../storage/app-store.js";
import type {
  BindingCapability,
  RoleBindingInput,
  RoleBindingRecord,
} from "../storage/role-store.js";
import type { CredentialSummary, CredentialResolver } from "./credential-resolver.js";
import {
  summarizeModelTest,
  type ModelTestSummary,
} from "./model-service.js";
import { RoleAccess } from "./role-access.js";

export interface CreateResourceInput {
  kind: ResourceKind;
  name: string;
  enabled?: boolean | undefined;
  config: unknown;
  /** 只写的模型服务密钥；创建时与资源同一事务落库。 */
  secret?: string | undefined;
}

export interface UpdateResourceInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  config?: unknown;
  /** undefined 保留、null 清除、字符串替换。 */
  secret?: string | null | undefined;
}

export interface BindingInput {
  capability: BindingCapability;
  resourceId: string;
  modelName?: string | undefined;
  enabled?: boolean | undefined;
}

/** 资源读视图：只暴露凭据状态和最近测试，不含任何密钥明文。 */
export interface ResourceView extends ResourceRecord {
  credential: CredentialSummary;
  lastTest: ModelTestSummary | null;
}

export interface ResourceServiceOptions {
  credentialResolver: CredentialResolver;
  now?: () => Date;
}

const capabilityKind: Record<BindingCapability, ResourceKind> = {
  chat_model: "model",
  memory_model: "model",
  mcp: "mcp",
  skill: "skill",
};

export class ResourceService {
  private readonly credentials: CredentialResolver;
  private readonly now: () => Date;

  constructor(
    private readonly appStore: AppStore,
    private readonly access: RoleAccess,
    options: ResourceServiceOptions,
  ) {
    this.credentials = options.credentialResolver;
    this.now = options.now ?? (() => new Date());
  }

  create(input: CreateResourceInput): ResourceView {
    const config = parseResourceConfig(input.kind, input.config);
    if (input.secret !== undefined) {
      this.assertSecretAllowed(input.kind, config);
    }
    const resourceId = randomUUID();
    const now = this.now().toISOString();
    this.appStore.db.transaction(() => {
      this.appStore.createResource({
        resourceId,
        kind: input.kind,
        name: input.name,
        enabled: input.enabled ?? true,
        config,
      });
      if (input.secret !== undefined) {
        this.credentials.setSecret(resourceId, input.secret, now);
      }
    })();
    return this.view(resourceId);
  }

  get(resourceId: string): ResourceRecord {
    return this.appStore.getResource(resourceId);
  }

  getView(resourceId: string): ResourceView {
    return this.view(resourceId);
  }

  list(kind?: ResourceKind): ResourceView[] {
    return this.appStore
      .listResources(kind)
      .map((record) => this.toView(record));
  }

  update(resourceId: string, input: UpdateResourceInput): ResourceView {
    const current = this.appStore.getResource(resourceId);
    const config =
      input.config === undefined
        ? undefined
        : parseResourceConfig(current.kind, input.config);
    const replacingSecret =
      typeof input.secret === "string" ? input.secret : undefined;
    if (replacingSecret !== undefined) {
      this.assertSecretAllowed(current.kind, config ?? current.config);
    }
    const now = this.now().toISOString();
    const nextConfig = config ?? current.config;
    const keepsStoredSecret =
      input.secret === undefined &&
      this.credentials.hasStoredSecret(resourceId);
    if (
      current.kind === "model" &&
      (replacingSecret !== undefined || keepsStoredSecret) &&
      nextConfig.credentialRef !== undefined
    ) {
      // 直填密钥与引用二选一；先清除密钥再改用引用，避免两套凭据并存。
      throw new ResourceCredentialConflictError();
    }
    if (current.kind === "model") {
      const from = serviceIdentityOf(current.config);
      const to = serviceIdentityOf(nextConfig);
      if (from !== to) {
        // 换站点或换协议后，旧凭据会被发到未确认的新服务。
        // 直填密钥与 env:/file: 引用都要重新确认，不能只拦其中一种。
        const referenceUnchanged =
          nextConfig.credentialRef !== undefined &&
          nextConfig.credentialRef === current.config.credentialRef;
        const keepsReference =
          replacingSecret === undefined && referenceUnchanged;
        if (keepsStoredSecret || keepsReference) {
          throw new ResourceCredentialStaleError({ from, to });
        }
      }
    }
    this.appStore.db.transaction(() => {
      this.appStore.updateResource({
        resourceId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(config === undefined ? {} : { config }),
      });
      if (replacingSecret !== undefined) {
        this.credentials.setSecret(resourceId, replacingSecret, now);
      } else if (input.secret === null) {
        this.credentials.clearSecret(resourceId);
      }
      if (
        current.kind === "model" &&
        (nextConfig.protocol !== current.config.protocol ||
          nextConfig.baseUrl !== current.config.baseUrl)
      ) {
        // 地址或协议变了，旧测试结果不再对应当前服务。
        this.appStore.deleteModelTestCalls(resourceId);
      }
    })();
    return this.view(resourceId);
  }

  listBindings(roleId: string): RoleBindingRecord[] {
    return this.access.withStore(roleId, (storage) =>
      storage.business.listRoleBindings(roleId),
    );
  }

  replaceBindings(
    roleId: string,
    bindings: readonly BindingInput[],
  ): RoleBindingRecord[] {
    this.access.requireReady(roleId);
    const normalized = this.validateBindings(bindings);
    return this.access.withStore(roleId, (storage) =>
      storage.business.replaceRoleBindings(roleId, normalized),
    );
  }

  private view(resourceId: string): ResourceView {
    return this.toView(this.appStore.getResource(resourceId));
  }

  private toView(record: ResourceRecord): ResourceView {
    const parsed =
      record.kind === "model"
        ? modelConfigSchema.safeParse(record.config)
        : null;
    const config = parsed?.success === true ? parsed.data : null;
    const reference = config?.credentialRef;
    const credential = this.credentials.summary(record.resourceId, reference);
    const testCall =
      config === null
        ? null
        : this.appStore.latestModelTestCall(record.resourceId);
    const lastTest =
      config === null || testCall === null
        ? null
        : summarizeModelTest(
            testCall,
            config,
            this.credentials.fingerprintSalt(record.resourceId, reference),
          );
    return { ...record, credential, lastTest };
  }

  private assertSecretAllowed(
    kind: ResourceKind,
    config: Record<string, unknown>,
  ): void {
    if (kind !== "model") {
      throw new InvalidResourceConfigError(kind, [
        { path: "secret", message: "只有模型资源支持直填密钥" },
      ]);
    }
    if (config.credentialRef !== undefined) {
      throw new ResourceCredentialConflictError();
    }
  }

  private validateBindings(
    bindings: readonly BindingInput[],
  ): RoleBindingInput[] {
    const seen = new Set<string>();
    let chatModels = 0;
    let memoryModels = 0;
    return bindings.map((binding) => {
      const pairKey = `${binding.capability}:${binding.resourceId}`;
      if (seen.has(pairKey)) {
        throw new BindingConflictError("同一能力重复绑定了同一资源", {
          capability: binding.capability,
          resourceId: binding.resourceId,
        });
      }
      seen.add(pairKey);

      const resource = this.appStore.getResource(binding.resourceId);
      const expectedKind = capabilityKind[binding.capability];
      if (resource.kind !== expectedKind) {
        throw new ResourceKindMismatchError(
          binding.capability,
          expectedKind,
          resource.kind,
        );
      }

      const isModel =
        binding.capability === "chat_model" ||
        binding.capability === "memory_model";
      const modelName = binding.modelName?.trim() ?? null;
      if (isModel) {
        if (!modelName) {
          throw new InvalidBindingError("模型能力必须提供 modelName", {
            capability: binding.capability,
          });
        }
        if (binding.capability === "chat_model") {
          chatModels += 1;
          if (chatModels > 1) {
            throw new BindingConflictError("每个角色最多绑定一个对话模型");
          }
        } else {
          memoryModels += 1;
          if (memoryModels > 1) {
            throw new BindingConflictError("每个角色最多绑定一个记忆模型");
          }
        }
      } else if (modelName !== null) {
        throw new InvalidBindingError("非模型能力不能提供 modelName", {
          capability: binding.capability,
        });
      }

      return {
        capability: binding.capability,
        resourceId: binding.resourceId,
        modelName: isModel ? modelName : null,
        enabled: binding.enabled ?? true,
      };
    });
  }
}

/**
 * 判断资源是否仍指向同一个服务：协议相同且 origin 相同。
 * 同站点换路径（例如换 API 版本前缀）算同一个服务，允许保留已存密钥；
 * 换域名、端口或协议都算换服务，需要用户重新确认凭据。
 */
function serviceIdentityOf(config: Record<string, unknown>): string {
  const protocol = typeof config.protocol === "string" ? config.protocol : "";
  const baseUrl = typeof config.baseUrl === "string" ? config.baseUrl : "";
  try {
    return `${protocol} ${new URL(baseUrl).origin}`;
  } catch {
    return `${protocol} ${baseUrl}`;
  }
}
