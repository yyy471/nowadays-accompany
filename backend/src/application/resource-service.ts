import { randomUUID } from "node:crypto";
import {
  BindingConflictError,
  InvalidBindingError,
  ResourceKindMismatchError,
} from "../domain/errors.js";
import {
  parseResourceConfig,
  type ResourceKind,
} from "../domain/resource.js";
import type { AppStore, ResourceRecord } from "../storage/app-store.js";
import type {
  BindingCapability,
  RoleBindingInput,
  RoleBindingRecord,
} from "../storage/role-store.js";
import { RoleAccess } from "./role-access.js";

export interface CreateResourceInput {
  kind: ResourceKind;
  name: string;
  enabled?: boolean | undefined;
  config: unknown;
}

export interface UpdateResourceInput {
  name?: string | undefined;
  enabled?: boolean | undefined;
  config?: unknown;
}

export interface BindingInput {
  capability: BindingCapability;
  resourceId: string;
  modelName?: string | undefined;
  enabled?: boolean | undefined;
}

const capabilityKind: Record<BindingCapability, ResourceKind> = {
  chat_model: "model",
  memory_model: "model",
  mcp: "mcp",
  skill: "skill",
};

export class ResourceService {
  constructor(
    private readonly appStore: AppStore,
    private readonly access: RoleAccess,
  ) {}

  create(input: CreateResourceInput): ResourceRecord {
    const config = parseResourceConfig(input.kind, input.config);
    return this.appStore.createResource({
      resourceId: randomUUID(),
      kind: input.kind,
      name: input.name,
      enabled: input.enabled ?? true,
      config,
    });
  }

  get(resourceId: string): ResourceRecord {
    return this.appStore.getResource(resourceId);
  }

  list(kind?: ResourceKind): ResourceRecord[] {
    return this.appStore.listResources(kind);
  }

  update(resourceId: string, input: UpdateResourceInput): ResourceRecord {
    const current = this.appStore.getResource(resourceId);
    const config =
      input.config === undefined
        ? undefined
        : parseResourceConfig(current.kind, input.config);
    return this.appStore.updateResource({
      resourceId,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(config === undefined ? {} : { config }),
    });
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
