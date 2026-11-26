import type { AppStore, ResourceRecord } from "../../storage/core/app-store.js";
import type { RoleStore } from "../../storage/role/role-store.js";

/** 对话与工程共用当前角色绑定，停用资源只对持有续用记录的任务开放。 */
export function taskToolResources(app: AppStore, bindings: ReturnType<RoleStore["listRoleBindings"]>,
  continuationIds: Iterable<string>) {
  const retained = new Set(continuationIds);
  const selected = new Set<string>();
  for (const binding of bindings) {
    if ((binding.capability === "mcp" || binding.capability === "skill") &&
      (binding.enabled || retained.has(binding.resourceId)))
      selected.add(binding.resourceId);
  }
  for (const id of retained) selected.add(id);
  const resources: ResourceRecord[] = [];
  for (const id of selected) {
    let resource;
    try { resource = app.getResource(id); } catch { continue; }
    if ((resource.kind === "skill" || resource.kind === "mcp") && (resource.enabled || retained.has(id))) resources.push(resource);
  }
  return resources;
}
