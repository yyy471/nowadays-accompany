import type { RoleActivityService } from "../application/role-activity-service.js";
import type { JsonResponse } from "./errors.js";
import type { Router } from "./router.js";

/**
 * 活动状态与配置写入保护的接口（252 第一包）。
 * 初始化状态与活动状态分别返回，界面开关不能替代后端确认（DL-148）。
 */
export function registerRoleActivityRoutes(
  router: Router,
  activity: RoleActivityService,
): Router {
  router.add("GET", "/v1/activities", (): JsonResponse => ({
    status: 200,
    body: { items: activity.list() },
  }));

  router.add("GET", "/v1/roles/:roleId/activity", ({ params }): JsonResponse => ({
    status: 200,
    body: { activity: activity.view(params.roleId ?? "") },
  }));

  router.add(
    "POST",
    "/v1/roles/:roleId/activity/stop",
    ({ params }): JsonResponse => {
      const result = activity.requestStop(params.roleId ?? "");
      return { status: 200, body: result };
    },
  );

  router.add(
    "POST",
    "/v1/roles/:roleId/activity/resume",
    ({ params }): JsonResponse => ({
      status: 200,
      body: { activity: activity.resume(params.roleId ?? "") },
    }),
  );

  return router;
}
