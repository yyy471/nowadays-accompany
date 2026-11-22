import {
  ModelBindingMissingError,
  ResourceKindMismatchError,
} from "../domain/errors.js";
import { modelConfigSchema } from "../domain/resource.js";
import type { ModelServiceConfig } from "../domain/model.js";
import type { RoleAccess } from "./role-access.js";
import type { AppStore, ResourceRecord } from "../storage/app-store.js";

export interface ResolvedModelBinding {
  capability: "chat_model" | "memory_model";
  resourceId: string;
  modelName: string;
  config: ModelServiceConfig;
}

export class ModelBindingResolver {
  constructor(
    private readonly appStore: AppStore,
    private readonly access: RoleAccess,
  ) {}

  resolveChat(roleId: string): ResolvedModelBinding {
    return this.resolve(roleId, "chat_model");
  }

  hasChatBinding(roleId: string): boolean {
    try {
      return this.tryResolve(roleId, "chat_model") !== null;
    } catch {
      return false;
    }
  }

  hasChatForTask(roleId: string, taskId: string): boolean {
    try {
      return this.resolveChatForTask(roleId, taskId) !== null;
    } catch {
      return false;
    }
  }

  resolveChatForTask(
    roleId: string,
    taskId: string,
  ): ResolvedModelBinding | null {
    const { bindings, continuationIds } = this.access.withStore(
      roleId,
      (storage) => ({
        bindings: storage.business.listRoleBindings(roleId),
        continuationIds: storage.business
          .listResourceContinuations(roleId, taskId)
          .filter((item) => item.endedAt === null)
          .map((item) => item.resourceId),
      }),
    );
    for (const resourceId of continuationIds) {
      let resource: ResourceRecord;
      try {
        resource = this.appStore.getResource(resourceId);
      } catch {
        continue;
      }
      if (resource.kind !== "model") {
        continue;
      }
      const binding = bindings.find(
        (item) =>
          item.resourceId === resourceId && item.capability === "chat_model",
      );
      if (binding === undefined && !this.modelUsedByTask(roleId, taskId, resourceId)) {
        continue;
      }
      const modelName =
        binding?.modelName ??
        this.latestTaskModelName(roleId, taskId, resourceId);
      if (modelName === null) {
        continue;
      }
      const config = parseModelConfig(resource);
      if (config === null) {
        continue;
      }
      return {
        capability: "chat_model",
        resourceId,
        modelName,
        config,
      };
    }
    return null;
  }

  resolveMemory(roleId: string): ResolvedModelBinding {
    const memory = this.tryResolve(roleId, "memory_model");
    return memory ?? this.resolve(roleId, "chat_model");
  }

  /**
   * 实际使用目标（278 §2、283 R04）：与运行时解析共用同一份规则。
   * 对话取启用且资源可用的对话绑定；记忆先取可用的独立记忆绑定，
   * 不可用时回退到对话模型。返回 null 表示当前没有可用目标。
   */
  usageTargets(roleId: string): {
    chatResourceId: string | null;
    memoryResourceId: string | null;
  } {
    const chat = this.safeResourceId(roleId, "chat_model");
    const memory = this.safeResourceId(roleId, "memory_model");
    return { chatResourceId: chat, memoryResourceId: memory ?? chat };
  }

  /** 原任务链固定的对话模型目标；旧任务可能早于当前绑定变化（278 §2.1）。 */
  taskChatResourceId(roleId: string, taskId: string): string | null {
    try {
      return this.resolveChatForTask(roleId, taskId)?.resourceId ?? null;
    } catch {
      return null;
    }
  }

  chatResourceId(roleId: string): string | null {
    return this.safeResourceId(roleId, "chat_model");
  }

  private safeResourceId(
    roleId: string,
    capability: "chat_model" | "memory_model",
  ): string | null {
    try {
      return this.tryResolve(roleId, capability)?.resourceId ?? null;
    } catch {
      return null;
    }
  }

  refresh(binding: ResolvedModelBinding, roleId: string): ResolvedModelBinding {
    let latest: ResolvedModelBinding | null = null;
    try {
      latest = this.tryResolve(roleId, binding.capability);
    } catch {
      latest = null;
    }
    let resource: ResourceRecord;
    try {
      resource = this.appStore.getResource(binding.resourceId);
    } catch {
      return binding;
    }
    if (resource.kind !== "model") {
      return binding;
    }
    const config = parseModelConfig(resource) ?? binding.config;
    return {
      capability: binding.capability,
      resourceId: binding.resourceId,
      modelName:
        latest?.resourceId === binding.resourceId
          ? latest.modelName
          : binding.modelName,
      config,
    };
  }

  private resolve(
    roleId: string,
    capability: "chat_model" | "memory_model",
  ): ResolvedModelBinding {
    const resolved = this.tryResolve(roleId, capability);
    if (!resolved) {
      throw new ModelBindingMissingError(roleId, capability);
    }
    return resolved;
  }

  private modelUsedByTask(
    roleId: string,
    taskId: string,
    resourceId: string,
  ): boolean {
    return this.access.withStore(roleId, (storage) => {
      const row = storage.business.db
        .prepare(
          `SELECT 1 FROM model_calls mc
             JOIN executions e ON e.execution_id = mc.execution_id
             JOIN execution_tasks et ON et.execution_id = e.execution_id
            WHERE et.task_id = ? AND e.role_id = ? AND mc.resource_id = ?
              AND mc.purpose IN ('user_chat', 'user_task', 'autonomous')
            LIMIT 1`,
        )
        .get(taskId, roleId, resourceId);
      return row !== undefined;
    });
  }

  private latestTaskModelName(
    roleId: string,
    taskId: string,
    resourceId: string,
  ): string | null {
    return this.access.withStore(roleId, (storage) => {
      const row = storage.business.db
        .prepare(
          `SELECT mc.model_name FROM model_calls mc
             JOIN executions e ON e.execution_id = mc.execution_id
             JOIN execution_tasks et ON et.execution_id = e.execution_id
            WHERE et.task_id = ? AND e.role_id = ? AND mc.resource_id = ?
              AND mc.purpose IN ('user_chat', 'user_task', 'autonomous')
            ORDER BY mc.started_at DESC, mc.rowid DESC
            LIMIT 1`,
        )
        .get(taskId, roleId, resourceId) as
        | { model_name: string }
        | undefined;
      return row?.model_name ?? null;
    });
  }

  private tryResolve(
    roleId: string,
    capability: "chat_model" | "memory_model",
  ): ResolvedModelBinding | null {
    const bindings = this.access.withStore(roleId, (storage) =>
      storage.business.listRoleBindings(roleId),
    );
    const binding = bindings.find(
      (item) => item.capability === capability && item.enabled,
    );
    if (!binding || !binding.modelName) {
      return null;
    }
    let resource: ResourceRecord;
    try {
      resource = this.appStore.getResource(binding.resourceId);
    } catch {
      // 资源已删除但绑定尚未清理完（RP-R05）：按未绑定处理。
      return null;
    }
    if (!resource.enabled) {
      return null;
    }
    if (resource.kind !== "model") {
      throw new ResourceKindMismatchError(capability, "model", resource.kind);
    }
    const config = parseModelConfig(resource);
    if (!config) {
      throw new ModelBindingMissingError(roleId, capability);
    }
    return {
      capability,
      resourceId: resource.resourceId,
      modelName: binding.modelName,
      config,
    };
  }
}

function parseModelConfig(resource: ResourceRecord): ModelServiceConfig | null {
  const result = modelConfigSchema.safeParse(resource.config);
  if (!result.success) {
    return null;
  }
  return result.data;
}
