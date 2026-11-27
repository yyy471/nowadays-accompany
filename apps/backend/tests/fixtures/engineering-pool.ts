import type { BackendApp } from "../../src/bootstrap/app.js";

/** 工程用例显式配置自己的上游。普通对话夹具始终从空池开始。 */
export function seedEngineeringPool(app: BackendApp, resourceId: string, modelName = "offline") {
  return app.services.engineeringPool.update({ members: [{ resourceId, modelName, enabled: true }] });
}
