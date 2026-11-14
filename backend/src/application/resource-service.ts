import { createHash, randomUUID } from "node:crypto";
import {
  BindingConflictError,
  BindingRevisionConflictError,
  InvalidBindingError,
  InvalidResourceConfigError,
  ModelCredentialUnavailableError,
  ResourceCredentialConflictError,
  ResourceCredentialStaleError,
  ResourceInUseError,
  ResourceKindMismatchError,
  ResourceMaintenanceError,
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
import type { ModelBindingResolver } from "./model-binding-resolver.js";
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

export interface ResourceImpactRole {
  roleId: string;
  displayName: string;
  usages: Array<"chat" | "memory" | "task">;
  taskIds: string[];
  state: string;
  running: boolean;
}

export interface ResourceImpactView {
  resourceId: string;
  kind: ResourceKind;
  roles: ResourceImpactRole[];
  /** 删除前会阻塞的角色／任务数量（与引用报告同一规则）。 */
  blockingTasks: number;
}

export interface ResourceServiceOptions {
  credentialResolver: CredentialResolver;
  /** 与运行时共用同一份模型解析规则（283 R04）。 */
  bindings: ModelBindingResolver;
  now?: () => Date;
  /** 读取角色活动状态；用于影响范围与维护前暂停。 */
  activityOf?: (roleId: string) => { state: string; running: boolean };
  /** 暂停实际依赖目标的角色并等待后端确认停止（278 §2）。 */
  pauseRoles?: (roleIds: readonly string[]) => Promise<{ pausedRoleIds: string[] }>;
  /** 维护结束或绑定变化后唤醒原待处理工作（R02）。 */
  wakePendingWork?: (roleId?: string) => void;
  /** 目标服务上仍在途的后台调用角色；维护等待要覆盖已停止角色（283 §6 R01）。 */
  externalInflightRoleIds?: (resourceId: string) => string[];
}

const capabilityKind: Record<BindingCapability, ResourceKind> = {
  chat_model: "model",
  memory_model: "model",
  mcp: "mcp",
  skill: "skill",
};

export class ResourceService {
  private readonly credentials: CredentialResolver;
  private readonly bindings: ModelBindingResolver;
  private readonly now: () => Date;
  private readonly activityOf: (roleId: string) => { state: string; running: boolean };
  readonly pauseRoles: ((roleIds: readonly string[]) => Promise<{ pausedRoleIds: string[] }>) | null;
  /** 正在维护的资源：相关绑定变更、恢复活动与调用领取需要等待。 */
  private readonly maintenanceResources = new Set<string>();
  /** 等待维护结束的后台调用（标注、过场图规划）；结束后统一唤醒（278 §2.1）。 */
  private readonly maintenanceWaiters = new Set<{
    resourceId: string;
    resolve: () => void;
  }>();
  private readonly wakePendingWork: (roleId?: string) => void;
  private readonly externalInflightRoleIds: (resourceId: string) => string[];
  /** 已领取的模型调用（标注、规划），按实际服务登记（283 §13 R01）。 */
  private readonly inflightClaims = new Map<
    number,
    { roleId: string; resourceId: string }
  >();
  private inflightClaimSeq = 0;

  constructor(
    private readonly appStore: AppStore,
    private readonly access: RoleAccess,
    options: ResourceServiceOptions,
  ) {
    this.credentials = options.credentialResolver;
    this.bindings = options.bindings;
    this.now = options.now ?? (() => new Date());
    this.activityOf = options.activityOf ?? (() => ({ state: "stopped", running: false }));
    this.pauseRoles = options.pauseRoles ?? null;
    this.wakePendingWork = options.wakePendingWork ?? (() => undefined);
    this.externalInflightRoleIds = options.externalInflightRoleIds ?? (() => []);
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

  /**
   * 仅在用户主动点击「显示」时读取当前模型服务的凭据原文或引用内容；
   * 常规资源列表与详情接口仍保持只写不回显。
   */
  revealSecret(resourceId: string): {
    status: "stored" | "reference" | "missing";
    secret?: string;
    reference?: string;
  } {
    const record = this.appStore.getResource(resourceId);
    if (record.kind !== "model") {
      throw new ResourceKindMismatchError(resourceId, "model", record.kind);
    }
    const parsed = modelConfigSchema.safeParse(record.config);
    const reference = parsed.success ? parsed.data.credentialRef : undefined;
    const state = this.credentials.inspect(resourceId, reference);
    if (state.kind === "stored") {
      return { status: "stored", secret: state.value };
    }
    if (state.kind === "unavailable") {
      throw new ModelCredentialUnavailableError(
        `stored:${resourceId}`,
        "已保存的密钥在当前环境无法解密，请重新输入新密钥覆盖",
      );
    }
    if (state.kind === "reference") {
      return {
        status: "reference",
        reference: state.reference,
        ...(state.value !== undefined ? { secret: state.value } : {}),
      };
    }
    return { status: "missing" };
  }

  /**
   * 修改前的本地校验（283 R05）：所有可预判的错误都在暂停角色之前报出，
   * 避免「角色已经停止、保存却被拒绝」的半成品状态。update() 会用同一份
   * 规则再校验一次，防止校验与写入之间状态变化。
   */
  validateUpdate(resourceId: string, input: UpdateResourceInput): void {
    this.prepareUpdate(resourceId, input);
  }

  update(resourceId: string, input: UpdateResourceInput): ResourceView {
    const { current, config, replacingSecret, nextConfig } =
      this.prepareUpdate(resourceId, input);
    const now = this.now().toISOString();
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
    // 模型服务的启用、连接或凭据变化都可能让原先等待的消息重新可调度（R02）。
    if (current.kind === "model") {
      this.wakePendingWork();
    }
    return this.view(resourceId);
  }

  /** update() 与 validateUpdate() 共用的校验与归一化，不写存储。 */
  private prepareUpdate(
    resourceId: string,
    input: UpdateResourceInput,
  ): {
    current: ResourceRecord;
    config: Record<string, unknown> | undefined;
    replacingSecret: string | undefined;
    nextConfig: Record<string, unknown>;
  } {
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
    // MCP／Skill：单独切换启用状态立即生效（新任务不再选择，旧任务继续，278 §3）；
    // 同时修改运行配置或名称时按占用检查整笔处理。
    if (current.kind !== "model") {
      const nameChanged = input.name !== undefined && input.name !== current.name;
      const configChanged =
        config !== undefined &&
        JSON.stringify(config) !== JSON.stringify(current.config);
      const onlyToggle =
        input.enabled !== undefined &&
        input.secret === undefined &&
        !nameChanged &&
        !configChanged;
      if (!onlyToggle) {
        this.assertNotInUse(resourceId, "UPDATE");
      }
    }
    const replacingSecret =
      typeof input.secret === "string" ? input.secret : undefined;
    if (replacingSecret !== undefined) {
      this.assertSecretAllowed(current.kind, config ?? current.config);
    }
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
    return { current, config, replacingSecret, nextConfig };
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
   * 进入目标服务的维护窗口（283 R01）。
   *
   * 维护期间：新增启用绑定、恢复仍依赖该服务的角色、以及新执行领取调用
   * 都会被拒绝或暂缓，避免它们抢在写入前加入。同一服务不允许并发维护。
   */
  beginMaintenance(resourceId: string): void {
    if (this.maintenanceResources.has(resourceId)) {
      throw new ResourceMaintenanceError(resourceId, "UPDATE");
    }
    this.maintenanceResources.add(resourceId);
  }

  /** 操作结束（成功、失败或取消）后释放维护窗口并唤醒可运行的工作。 */
  endMaintenance(resourceId: string): void {
    if (!this.maintenanceResources.delete(resourceId)) {
      return;
    }
    for (const waiter of [...this.maintenanceWaiters]) {
      if (waiter.resourceId === resourceId) waiter.resolve();
    }
    this.wakePendingWork();
  }

  isUnderMaintenance(resourceId: string): boolean {
    return this.maintenanceResources.has(resourceId);
  }

  /**
   * 领取一次模型调用：维护检查与在途登记在同一个同步步骤完成，
   * 避免检查之后、登记之前被新的维护窗口插入（283 §13 R01）。
   * 未被接纳时调用方应等待维护结束再重试。
   */
  claimModelCall(
    roleId: string,
    resourceId: string,
  ): { admitted: boolean; release: () => void } {
    if (this.maintenanceResources.has(resourceId)) {
      return { admitted: false, release: () => undefined };
    }
    const token = ++this.inflightClaimSeq;
    this.inflightClaims.set(token, { roleId, resourceId });
    return {
      admitted: true,
      release: () => {
        this.inflightClaims.delete(token);
      },
    };
  }

  /** 目标服务的在途角色：外部（记忆、对话执行）与已领取的后台调用合并。 */
  inflightRoleIds(resourceId: string): string[] {
    const roles = new Set(this.externalInflightRoleIds(resourceId));
    for (const entry of this.inflightClaims.values()) {
      if (entry.resourceId === resourceId) roles.add(entry.roleId);
    }
    return [...roles].sort();
  }

  /**
   * 等待该角色已领取的后台调用真正结算（283 §15 R03）。
   * 取消只结束外层等待；这里等到领取释放，删除才能在模型收尾后移除角色。
   * 超时返回 false，由删除流程返回可重试的失败并保留角色。
   */
  async waitForRoleInflightIdle(
    roleId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.hasClaimForRole(roleId)) {
      if (Date.now() >= deadline) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  private hasClaimForRole(roleId: string): boolean {
    for (const entry of this.inflightClaims.values()) {
      if (entry.roleId === roleId) return true;
    }
    return false;
  }

  /**
   * 后台调用在维护窗口内的领取协调（278 §2.1）：
   * 目标服务维护中时等待结束；调用方醒来后要重新解析绑定，使用已保存配置。
   * 中止信号只会让等待提前返回，真正的请求仍由调用方的信号处理。
   */
  waitForMaintenanceEnd(
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.maintenanceResources.has(resourceId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = { resourceId, resolve: () => undefined as void };
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.maintenanceWaiters.delete(waiter);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      waiter.resolve = finish;
      this.maintenanceWaiters.add(waiter);
      if (signal !== undefined) {
        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener("abort", finish, { once: true });
      }
    });
  }

  /**
   * 恢复活动前的维护检查：按运行时实际解析的对话与记忆目标判断
   * （283 §13 R04）。失效或停用的独立记忆绑定会回退到对话模型，
   * 不应因为它指向维护中的服务而阻止恢复。
   * 旧任务链的续行按任务在调度入口暂缓，也不阻止恢复。
   */
  assertResumeAllowed(roleId: string): void {
    if (this.maintenanceResources.size === 0) {
      return;
    }
    const targets = this.bindings.usageTargets(roleId);
    for (const resourceId of [
      targets.chatResourceId,
      targets.memoryResourceId,
    ]) {
      if (resourceId !== null && this.maintenanceResources.has(resourceId)) {
        throw new ResourceMaintenanceError(resourceId, "RESUME");
      }
    }
  }

  /** 整表替换绑定。`expectedRevision` 可选：页面并行编辑时带上读取到的
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
    // 维护中的服务不接受新增的启用绑定：先保存绑定再恢复角色会抢在
    // 模型写入之前加入新依赖（283 R01）。
    if (this.maintenanceResources.size > 0) {
      const alreadyEnabled = new Set(
        current
          .filter((binding) => binding.enabled)
          .map((binding) => binding.resourceId),
      );
      for (const binding of normalized) {
        if (
          binding.enabled &&
          !alreadyEnabled.has(binding.resourceId) &&
          this.maintenanceResources.has(binding.resourceId)
        ) {
          throw new ResourceMaintenanceError(binding.resourceId, "BINDINGS");
        }
      }
    }
    const items = this.access.withStore(roleId, (storage) =>
      storage.business.replaceRoleBindings(roleId, normalized),
    );
    this.wakePendingWork(roleId);
    return { items, revision: revisionOf(items) };
  }

  /**
   * 影响范围（278 §2、283 R04）：与运行时使用同一份模型解析规则。
   * 全局停用且无续用的资源不再被列为依赖；独立记忆模型不可用时按回退
   * 到对话模型计入实际目标；只有旧任务依赖时只记任务用途。
   */
  impact(resourceId: string): ResourceImpactView {
    const resource = this.appStore.getResource(resourceId);
    const roles: ResourceImpactRole[] = [];
    let blockingTasks = 0;
    for (const index of this.appStore.listRoleIndexes()) {
      if (index.initStatus !== "ready") continue;
      const targets = this.bindings.usageTargets(index.roleId);
      const { displayName, taskIds } = this.access.withStore(
        index.roleId,
        (storage) => ({
          displayName: storage.business.getRole(index.roleId).displayName,
          taskIds: storage.business
            .listOpenResourceContinuations(resourceId)
            .map((task) => task.taskId),
        }),
      );
      const usages = new Set<"chat" | "memory" | "task">();
      if (targets.chatResourceId === resourceId) usages.add("chat");
      if (targets.memoryResourceId === resourceId) usages.add("memory");
      if (taskIds.length > 0) usages.add("task");
      if (usages.size === 0) continue;
      if (usages.has("task")) blockingTasks += taskIds.length;
      const activity = this.activityOf(index.roleId);
      roles.push({
        roleId: index.roleId,
        displayName,
        usages: [...usages],
        taskIds,
        state: activity.state,
        running: activity.running,
      });
    }
    return {
      resourceId,
      kind: resource.kind,
      roles,
      blockingTasks,
    };
  }

  /**
   * 维护计划：模型连接参数或密钥变化时，返回需要暂停的依赖角色。
   * 只暂停对话／记忆实际解析到该服务的角色；只有旧任务依赖时不暂停角色，
   * 由调度在任务领取与续行入口按任务暂缓（283 R04）。只改名或只切换
   * 启用状态不需要暂停。
   */
  maintenancePlan(
    resourceId: string,
    input: UpdateResourceInput,
  ): {
    connectionChanged: boolean;
    pauseRoleIds: string[];
    /** 已停止但仍在目标服务上有在途后台调用：只等待，不加入恢复名单。 */
    waitRoleIds: string[];
  } {
    const current = this.appStore.getResource(resourceId);
    if (current.kind !== "model") {
      return { connectionChanged: false, pauseRoleIds: [], waitRoleIds: [] };
    }
    const nextConfig =
      input.config === undefined
        ? current.config
        : parseResourceConfig("model", input.config);
    const connectionChanged =
      String(nextConfig.protocol) !== String(current.config.protocol) ||
      String(nextConfig.baseUrl) !== String(current.config.baseUrl) ||
      nextConfig.credentialRef !== current.config.credentialRef ||
      input.secret !== undefined;
    if (!connectionChanged) {
      return { connectionChanged: false, pauseRoleIds: [], waitRoleIds: [] };
    }
    const roles = this.impact(resourceId).roles;
    const pauseRoleIds = roles
      .filter(
        (role) =>
          role.state !== "stopped" &&
          (role.usages.includes("chat") || role.usages.includes("memory")),
      )
      .map((role) => role.roleId);
    // 等待直接依据目标服务的在途调用，不跟当前影响范围取交集：
    // 服务停用或角色改绑后旧调用仍属于该服务（283 §7 R01）。
    // 已停止角色只等待，不进入恢复名单。
    const waitRoleIds = [...new Set(this.inflightRoleIds(resourceId))].sort();
    return { connectionChanged: true, pauseRoleIds, waitRoleIds };
  }

  /**
   * 等待已停止角色在目标服务上的在途后台调用结算（283 §6 R01）。
   * 返回超时后仍在途的角色；这些角色不加入本次维护的恢复名单。
   */
  async waitForInflightIdle(
    resourceId: string,
    roleIds: readonly string[],
    timeoutMs: number,
  ): Promise<string[]> {
    if (roleIds.length === 0) {
      return [];
    }
    const deadline = Date.now() + timeoutMs;
    let busy = this.inflightRoleIds(resourceId).filter((roleId) =>
      roleIds.includes(roleId),
    );
    while (busy.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      busy = this.inflightRoleIds(resourceId).filter((roleId) =>
        roleIds.includes(roleId),
      );
    }
    return busy;
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
    // 目标服务上仍有在途模型调用：即使绑定已改走或任务已终结，删除也要等结算
    // （283 §8 R01）。等待名单直接按目标服务判断，不受当前影响范围影响。
    for (const roleId of this.inflightRoleIds(resourceId)) {
      references.push({
        roleId,
        capability: null,
        bindingEnabled: null,
        reason: "INFLIGHT_CALL",
      });
    }
    const bindings = references.filter(
      (item) => item.reason === "ROLE_BINDING",
    );
    const chains = references.filter((item) => item.reason === "TASK_CHAIN");
    const inflight = references.filter(
      (item) => item.reason === "INFLIGHT_CALL",
    );
    const scoped = resource.kind === "mcp" || resource.kind === "skill";
    const enabledBinding = bindings.some(
      (item) => item.bindingEnabled === true,
    );
    // MCP／Skill：启用中的角色开关或未结束任务链都拦修改与全局关闭；
    // 模型服务的修改由维护协调负责。
    const canUpdate = scoped ? !enabledBinding && chains.length === 0 : true;
    return {
      resourceId,
      kind: resource.kind,
      references,
      canUpdate,
      // 全局停用立即阻止新任务，原任务按 DL-71／73 继续（278 §3）。
      canDisable: true,
      // 删除：启用中的角色开关、未结束任务链与在途调用都拦删除（236 §8、283 §8）。
      canDelete:
        !enabledBinding && chains.length === 0 && inflight.length === 0,
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
