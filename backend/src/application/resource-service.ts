import { createHash, randomUUID } from "node:crypto";
import {
  BindingConflictError,
  BindingRevisionConflictError,
  InvalidBindingError,
  InvalidResourceConfigError,
  ResourceCredentialConflictError,
  ResourceCredentialStaleError,
  ResourceInUseError,
  ResourceKindMismatchError,
  type ResourceReferenceDetail,
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
import type { RoleStorage } from "../storage/role-storage.js";
import { runWithDecisionCommit } from "../storage/transaction-group.js";
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
  /** MCP 环境变量值已脱敏；配置里的其他字段保持原样。 */
  redacted: boolean;
}

/** 资源引用报告：删除／修改／全局关闭前的可定位拦截依据。 */
export interface ResourceReferenceReport {
  resourceId: string;
  kind: ResourceKind;
  references: ResourceReferenceDetail[];
  canUpdate: boolean;
  canDisable: boolean;
  canDelete: boolean;
}

/** 绑定整表读取：附一个内容摘要作为乐观并发版本。 */
export interface RoleBindingsView {
  items: RoleBindingRecord[];
  revision: string;
}

const REDACTED_VALUE = "***";

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
        : parseResourceConfig(
            current.kind,
            current.kind === "mcp"
              ? mergeRedactedMcpEnv(current.config, input.config)
              : input.config,
          );
    // 全局关闭与 MCP／Skill 修改要避开角色选择与未结束任务链（DL-148、DL-71／73）。
    if (input.enabled === false && current.enabled) {
      this.assertNotInUse(resourceId, "DISABLE");
    } else if (current.kind !== "model") {
      this.assertNotInUse(resourceId, "UPDATE");
    }
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
    // 已删除但尚未清理完的角色绑定按删除状态过滤（RP-R05）。
    const pending = new Set(this.appStore.listResourceDeletions());
    return this.access
      .withStore(roleId, (storage) =>
        storage.business.listRoleBindings(roleId),
      )
      .filter((binding) => !pending.has(binding.resourceId));
  }

  bindingsView(roleId: string): RoleBindingsView {
    const items = this.listBindings(roleId);
    return { items, revision: revisionOf(items) };
  }

  /**
   * 整表替换绑定。`expectedRevision` 可选：页面并行编辑时带上读取到的
   * revision，过期就返回 409，避免两个页面互相覆盖其他能力的绑定。
   */
  replaceBindings(
    roleId: string,
    bindings: readonly BindingInput[],
    expectedRevision?: string,
  ): RoleBindingsView {
    this.access.requireReady(roleId);
    const current = this.listBindings(roleId);
    const actual = revisionOf(current);
    if (expectedRevision !== undefined && expectedRevision !== actual) {
      throw new BindingRevisionConflictError(roleId, expectedRevision, actual);
    }
    const normalized = this.validateBindings(bindings);
    const items = this.access.withStore(roleId, (storage) =>
      storage.business.replaceRoleBindings(roleId, normalized),
    );
    return { items, revision: revisionOf(items) };
  }

  /**
   * 资源引用报告：角色选择（任意绑定）与未结束任务链的占用。
   * 供页面在删除、修改、全局关闭前定位到具体角色与任务。
   *
   * 任一角色库不可读时直接报出存储错误（RP-R02）：把读不到的库当作「没有
   * 引用」会让后续写入依据不完整的报告放行，必须让调用方明确失败。
   */
  references(resourceId: string): ResourceReferenceReport {
    const resource = this.appStore.getResource(resourceId);
    const references: ResourceReferenceDetail[] = [];
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") continue;
      this.access.withStore(index.roleId, (storage) => {
        for (const binding of storage.business.listRoleBindings(index.roleId)) {
          if (binding.resourceId !== resourceId) continue;
          references.push({
            roleId: index.roleId,
            capability: binding.capability,
            bindingEnabled: binding.enabled,
            reason: "ROLE_BINDING",
          });
        }
        for (const task of storage.business.listOpenResourceContinuations(
          resourceId,
        )) {
          references.push({
            roleId: index.roleId,
            capability: null,
            bindingEnabled: null,
            reason: "TASK_CHAIN",
            taskId: task.taskId,
            taskStatus: task.taskStatus,
          });
        }
      });
    }
    const bindings = references.filter(
      (item) => item.reason === "ROLE_BINDING",
    );
    const chains = references.filter((item) => item.reason === "TASK_CHAIN");
    const scoped = resource.kind === "mcp" || resource.kind === "skill";
    const enabledBinding = bindings.some(
      (item) => item.bindingEnabled === true,
    );
    // MCP／Skill：启用中的角色开关或未结束任务链都拦修改与全局关闭；
    // 模型服务的修改由「所有角色已停止」守卫负责。
    const canUpdate = scoped ? !enabledBinding && chains.length === 0 : true;
    return {
      resourceId,
      kind: resource.kind,
      references,
      canUpdate,
      canDisable: canUpdate,
      // 删除：启用中的角色开关与未结束任务链拦删除；关闭的绑定不拦（236 §8），
      // 删除时由 remove() 一并清理，避免留下指向已删资源的绑定行。
      canDelete: !enabledBinding && chains.length === 0,
    };
  }

  /**
   * 删除全局资源（RP-R03～RP-R07）。
   *
   * 引用检查与角色库预检在改动数据之前完成。真正的删除决策放在 app 库的
   * 一次事务里：资源删除与待清理记录同时提交。角色库的绑定清理只是可重做
   * 的部分：
   * - 任一绑定删除或决策库提交失败：全部回滚，资源与原有绑定完整保留；
   * - 决策库提交后角色库提交失败：删除已被接受，待清理记录保留，读侧过滤
   *   残留绑定，启动恢复或重试继续清理。
   * - 删除已被接受、只是清理未完成时，重试同一 DELETE 会继续清理并幂等成功。
   */
  remove(resourceId: string): { resourceId: string } {
    // 决策已提交但清理未完成的资源：重试同一 DELETE 继续清理（RP-R07）。
    if (this.appStore.isResourceDeletionPending(resourceId)) {
      this.cleanupPendingDeletion(resourceId);
      return { resourceId };
    }
    const report = this.references(resourceId);
    if (!report.canDelete) {
      throw new ResourceInUseError(resourceId, "DELETE", report.references);
    }
    const roleIds = this.appStore
      .listRoleIndexes()
      .filter((index) => index.initStatus === "ready")
      .map((index) => index.roleId);
    const stores = this.access.openReadyStores(roleIds);
    try {
      const at = this.now().toISOString();
      const { followersCommitted } = runWithDecisionCommit(
        this.appStore.db,
        stores.map((storage) => storage.business.db),
        () => {
          for (const storage of stores) {
            storage.business.deleteBindingsForResource(resourceId);
          }
          // 决策库：资源删除与待清理记录在同一事务里提交。
          this.appStore.recordResourceDeletion(resourceId, at);
          this.credentials.clearSecret(resourceId);
          this.appStore.deleteResource(resourceId);
        },
      );
      if (followersCommitted) {
        try {
          this.appStore.clearResourceDeletion(resourceId);
        } catch {
          // 决策已提交：记录留待启动恢复或下次删除重试，删除仍算成功（RP-R06）。
        }
      }
    } finally {
      for (const storage of stores) storage.close();
    }
    return { resourceId };
  }

  /**
   * 继续清理已删除资源的残留绑定（RP-R05）。启动恢复时调用，也用于删除
   * 重试（RP-R07）。返回本次清理完成的资源数量。
   *
   * 单条记录的打开、清理或标记删除失败都只保留该记录，不让异常中断启动
   * （RP-R06）；角色库暂不可读时同样保留，等下一次启动或重试继续。
   */
  reconcilePendingDeletions(): number {
    let pending: string[];
    try {
      pending = this.appStore.listResourceDeletions();
    } catch {
      return 0;
    }
    let cleared = 0;
    for (const resourceId of pending) {
      try {
        if (this.cleanupPendingDeletion(resourceId)) {
          cleared += 1;
        }
      } catch {
        // 单条清理失败：保留待清理记录，继续处理其余记录并允许后端启动。
      }
    }
    return cleared;
  }

  /** 清理单个已删除资源的残留绑定；全部角色库清理成功后才移除待清理记录。 */
  private cleanupPendingDeletion(resourceId: string): boolean {
    const roleIds = this.appStore
      .listRoleIndexes()
      .filter((index) => index.initStatus === "ready")
      .map((index) => index.roleId);
    let stores: RoleStorage[];
    try {
      stores = this.access.openReadyStores(roleIds);
    } catch {
      return false;
    }
    try {
      let cleaned = true;
      for (const storage of stores) {
        try {
          storage.business.deleteBindingsForResource(resourceId);
        } catch {
          cleaned = false;
        }
      }
      if (!cleaned) {
        return false;
      }
      try {
        this.appStore.clearResourceDeletion(resourceId);
        return true;
      } catch {
        return false;
      }
    } finally {
      for (const storage of stores) {
        storage.close();
      }
    }
  }

  private assertNotInUse(
    resourceId: string,
    action: "UPDATE" | "DISABLE",
  ): void {
    const report = this.references(resourceId);
    const allowed = action === "DISABLE" ? report.canDisable : report.canUpdate;
    if (allowed) return;
    throw new ResourceInUseError(resourceId, action, report.references);
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
    const redacted =
      record.kind === "mcp"
        ? redactMcpEnv(record.config)
        : { config: record.config, redacted: false };
    return {
      ...record,
      config: redacted.config,
      credential,
      lastTest,
      redacted: redacted.redacted,
    };
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

/** MCP 环境变量值不进入列表与选择器，只保留键名。 */
function redactMcpEnv(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  redacted: boolean;
} {
  const env = config.env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return { config, redacted: false };
  }
  const masked: Record<string, string> = {};
  for (const key of Object.keys(env as Record<string, unknown>)) {
    masked[key] = REDACTED_VALUE;
  }
  return {
    config: { ...config, env: masked },
    redacted: Object.keys(masked).length > 0,
  };
}

/**
 * 页面把脱敏后的配置原样提交时，`***` 代表「保持原值」，
 * 避免一次未编辑的保存把 MCP 环境变量覆盖成占位符。
 */
function mergeRedactedMcpEnv(
  current: Record<string, unknown>,
  next: unknown,
): unknown {
  if (next === null || typeof next !== "object" || Array.isArray(next)) {
    return next;
  }
  const currentEnv = current.env;
  const nextEnv = (next as Record<string, unknown>).env;
  if (
    currentEnv === null ||
    typeof currentEnv !== "object" ||
    Array.isArray(currentEnv) ||
    nextEnv === null ||
    typeof nextEnv !== "object" ||
    Array.isArray(nextEnv)
  ) {
    return next;
  }
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    nextEnv as Record<string, unknown>,
  )) {
    const previous = (currentEnv as Record<string, unknown>)[key];
    merged[key] =
      value === REDACTED_VALUE && typeof previous === "string"
        ? previous
        : value;
  }
  return { ...(next as Record<string, unknown>), env: merged };
}

function revisionOf(bindings: readonly RoleBindingRecord[]): string {
  const canonical = bindings
    .map((binding) =>
      [
        binding.capability,
        binding.resourceId,
        binding.modelName ?? "",
        binding.enabled ? "1" : "0",
      ].join("\u0000"),
    )
    .sort()
    .join("\u0001");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
