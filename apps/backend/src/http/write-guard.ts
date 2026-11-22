import type { RoleActivityService } from "../application/role-activity-service.js";
import type { ResourceKind } from "../domain/resource.js";
import { setBodyReadHook } from "./body.js";
import type { RouteHandler } from "./router.js";

/** 把配置写入包进活动状态租约：校验、写入与恢复不会交错（DL-148）。 */
export function roleWrite(
  activity: RoleActivityService,
  handler: RouteHandler,
): RouteHandler {
  return (context) => {
    const roleId = context.params.roleId ?? "";
    // 角色已被删除（例如继续清理的删除重试）时交给处理器给出正式响应。
    if (!activity.roleExists(roleId)) {
      return handler(context);
    }
    return activity.guardRole(roleId, () => {
      // 读请求体期间角色可能被恢复；读完体、真正写入前再验一次。
      setBodyReadHook(context.request, () => activity.assertStopped(roleId));
      return handler(context);
    });
  };
}

/**
 * 全局模型／服务写入要求所有角色都已停止。
 *
 * 入口校验之后还要读请求体，期间新建的角色默认 active。这里在读完体、
 * 真正写入前重验，避免新增角色绕过「所有角色已停止」条件（RA-R03）。
 */
export function globalWrite(
  activity: RoleActivityService,
  handler: RouteHandler,
): RouteHandler {
  return (context) =>
    activity.guardAll(() => {
      setBodyReadHook(context.request, () => activity.assertAllStopped());
      return handler(context);
    });
}

/**
 * 资源写入按目标资源类型分流（DL-148、RP-R01）。
 *
 * 模型服务的修改与删除要求所有角色已停止；MCP／Skill 的修改、全局关闭与
 * 删除由服务层按目标资源的开启绑定和未结束任务链判断，无关角色仍在活动时
 * 不拦维护。资源不存在或暂不可读时交给处理器返回正式错误响应。
 */
export function resourceWrite(
  activity: RoleActivityService,
  kindOf: (resourceId: string) => ResourceKind,
  handler: RouteHandler,
): RouteHandler {
  const guarded = globalWrite(activity, handler);
  return (context) => {
    const resourceId = context.params.resourceId ?? "";
    let kind: ResourceKind;
    try {
      kind = kindOf(resourceId);
    } catch {
      return handler(context);
    }
    return kind === "model" ? guarded(context) : handler(context);
  };
}
