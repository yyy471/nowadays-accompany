/**
 * 配置写入策略的唯一来源（DL-148 / 252 第一包）。
 *
 * 路由守卫用它决定哪些请求要挂活动状态租约；测试客户端用它决定哪些请求
 * 需要先经真实活动接口把角色切到后端确认的 stopped。两边共用一份清单，
 * 避免新增配置写入接口时守卫与测试规则漂移。
 */

/**
 * 角色级受保护写入（DL-148 方案 A）：目标角色须已由后端确认停止。
 *
 * 只保留会改变角色身份、运行绑定或删除既有素材的操作；素材新增、配置保存
 * 等可在运行中直接生效的写入见 {@link ROLE_HOT_CONFIG_WRITES}。
 */
export const ROLE_CONFIG_WRITES: ReadonlySet<string> = new Set([
  "DELETE /v1/roles/:roleId",
  "PATCH /v1/roles/:roleId/definition",
  "PUT /v1/roles/:roleId/bindings",
  "DELETE /v1/roles/:roleId/voice/references/:assetId",
  "DELETE /v1/roles/:roleId/appearance/outfits/:outfitId",
  "DELETE /v1/roles/:roleId/appearance/outfits/:outfitId/sprites/:assetId",
  "DELETE /v1/roles/:roleId/appearance/outfits/:outfitId/home/:assetId",
]);

/**
 * 角色级热生效写入（DL-148 方案 A）：运行中可直接保存，下一次执行读取新配置。
 *
 * 这里显式登记，便于与受保护写入对照审查；它们不挂停机租约，
 * 因此也不会进入 classifyConfigWrite 的受保护范围。
 */
export const ROLE_HOT_CONFIG_WRITES: ReadonlySet<string> = new Set([
  "PUT /v1/roles/:roleId/worldbooks",
  "PUT /v1/roles/:roleId/voice",
  "PUT /v1/roles/:roleId/voice/enabled",
  "POST /v1/roles/:roleId/voice/reference",
  "PUT /v1/roles/:roleId/autonomy/budget",
  "PUT /v1/roles/:roleId/scene-image",
  "PUT /v1/roles/:roleId/scene-image/outfits/:outfitId/reference",
  "DELETE /v1/roles/:roleId/scene-image/outfits/:outfitId/reference",
  "POST /v1/roles/:roleId/appearance/outfits",
  "PATCH /v1/roles/:roleId/appearance/outfits/:outfitId",
  "POST /v1/roles/:roleId/appearance/outfits/:outfitId/home",
  "POST /v1/roles/:roleId/appearance/outfits/:outfitId/sprites",
]);

/** 媒体服务写入由服务维护协调器按依赖角色处理，不再要求所有角色停止。 */
export const GLOBAL_CONFIG_WRITES: ReadonlySet<string> = new Set();

/**
 * 资源写入：模型服务的修改与删除要求所有角色已停止（DL-148）；
 * MCP／Skill 的写入由服务层按目标资源的开启绑定与未结束任务链判断，
 * 无关角色仍在活动时不拦维护。
 */
export const RESOURCE_CONFIG_WRITES: ReadonlySet<string> = new Set([
  "PATCH /v1/resources/:resourceId",
  "DELETE /v1/resources/:resourceId",
]);

export interface ConfigWriteScope {
  /** role：角色级；global：全局服务；resource：按资源类型决定是否全角色停止。 */
  kind: "role" | "global" | "resource";
  /** 角色级写入的目标角色（保留 URL 编码原样）；其余为 null。 */
  roleId: string | null;
  /** 资源级写入的目标资源；其余为 null。 */
  resourceId: string | null;
}

interface WriteRule {
  method: string;
  regex: RegExp;
  kind: ConfigWriteScope["kind"];
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(key: string, kind: ConfigWriteScope["kind"]): WriteRule {
  const separator = key.indexOf(" ");
  const method = key.slice(0, separator);
  const pattern = key.slice(separator + 1);
  const source = pattern
    .split("/")
    .map((part) => (part.startsWith(":") ? "([^/]+)" : escapeLiteral(part)))
    .join("/");
  return { method, regex: new RegExp(`^${source}$`), kind };
}

// 受保护写入才编译成租约规则；ROLE_HOT_CONFIG_WRITES 运行中直接生效，不在此列。
const WRITE_RULES: WriteRule[] = [
  ...[...ROLE_CONFIG_WRITES].map((key) => compile(key, "role")),
  ...[...GLOBAL_CONFIG_WRITES].map((key) => compile(key, "global")),
  ...[...RESOURCE_CONFIG_WRITES].map((key) => compile(key, "resource")),
];

/** 按方法与路径判断一次请求是否属于受保护的配置写入。 */
export function classifyConfigWrite(
  method: string,
  pathname: string,
): ConfigWriteScope | null {
  const normalized = method.toUpperCase();
  for (const rule of WRITE_RULES) {
    if (rule.method !== normalized) continue;
    const match = rule.regex.exec(pathname);
    if (match === null) continue;
    return {
      kind: rule.kind,
      // 角色级规则的第一个参数恒为 roleId，资源级恒为 resourceId。
      roleId: rule.kind === "role" ? (match[1] ?? null) : null,
      resourceId: rule.kind === "resource" ? (match[1] ?? null) : null,
    };
  }
  return null;
}
