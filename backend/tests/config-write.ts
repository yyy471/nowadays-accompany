import assert from "node:assert/strict";
import { classifyConfigWrite } from "../src/http/config-writes.js";

/**
 * 配置写入测试客户端（252 第一包）。
 *
 * 后端统一强制「配置写入前角色必须由后端确认停止」，因此既有功能测试在
 * 写配置时也要走真实流程：先经 /v1/roles/:id/activity/stop 确认停止，
 * 写完再按写入前的状态恢复。这里不绕过路由守卫，也不改产品代码状态，
 * 只是把桌面端将来要做的「停止 → 编辑 → 恢复」在测试里显式做一遍。
 *
 * 全局服务写入要求所有角色都已停止：用 /v1/activities 列出角色，逐个停止，
 * 结束后只恢复原本为 active 的角色，原本已停止的保持停止。资源写入按类型
 * 分流：模型资源同样要求全角色停止，MCP／Skill 交给服务层占用检查，不加作用域。
 */

interface ActivityView {
  roleId: string;
  state: "active" | "stopping" | "stopped";
  running: boolean;
}

interface StopResult {
  activity: ActivityView;
  confirmed: boolean;
}

interface ScopeSession {
  /** 写入前为 active 的角色；写入结束后恢复这些角色。 */
  resumeRoleIds: string[];
}

async function readBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  return raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
}

async function getActivity(origin: string, roleId: string): Promise<ActivityView> {
  const response = await fetch(`${origin}/v1/roles/${roleId}/activity`);
  const body = await readBody(response);
  assert.equal(response.status, 200, `查询角色活动失败：${JSON.stringify(body)}`);
  return (body as { activity: ActivityView }).activity;
}

async function listActivities(origin: string): Promise<ActivityView[]> {
  const response = await fetch(`${origin}/v1/activities`);
  const body = await readBody(response);
  assert.equal(response.status, 200, `列出角色活动失败：${JSON.stringify(body)}`);
  return (body as { items: ActivityView[] }).items;
}

async function stopRole(origin: string, roleId: string): Promise<void> {
  const response = await fetch(
    `${origin}/v1/roles/${roleId}/activity/stop`,
    { method: "POST" },
  );
  const body = await readBody(response);
  assert.equal(response.status, 200, `停止角色活动失败：${JSON.stringify(body)}`);
  const result = body as StopResult;
  assert.equal(
    result.activity.state,
    "stopped",
    `角色活动尚未由后端确认停止：${roleId}（${result.activity.state}）`,
  );
}

async function resumeRole(origin: string, roleId: string): Promise<void> {
  const response = await fetch(
    `${origin}/v1/roles/${roleId}/activity/resume`,
    { method: "POST" },
  );
  const body = await readBody(response);
  // 角色删除是受保护的配置写入，作用域结束时角色已不存在。
  if (
    response.status === 404 &&
    (body as { error?: { code?: string } }).error?.code === "ROLE_NOT_FOUND"
  ) {
    return;
  }
  assert.equal(response.status, 200, `恢复角色活动失败：${JSON.stringify(body)}`);
  assert.equal((body as { activity: ActivityView }).activity.state, "active");
}

async function openScope(
  origin: string,
  scope: NonNullable<ReturnType<typeof classifyConfigWrite>>,
): Promise<ScopeSession> {
  if (scope.kind === "role") {
    const roleId = scope.roleId;
    assert.ok(roleId, "角色级配置写入必须能解析出角色标识");
    const before = await getActivity(origin, roleId);
    if (before.state !== "stopped") await stopRole(origin, roleId);
    return { resumeRoleIds: before.state === "active" ? [roleId] : [] };
  }
  // 资源写入按类型分流：只有模型资源要求所有角色停止；
  // MCP／Skill 由服务层占用检查把关，无关角色活动时不需停止（DL-148）。
  if (scope.kind === "resource") {
    const resourceId = scope.resourceId;
    assert.ok(resourceId, "资源级配置写入必须能解析出资源标识");
    const response = await fetch(`${origin}/v1/resources/${resourceId}`);
    const body = await readBody(response);
    if (
      response.status !== 200 ||
      (body as { kind?: string }).kind !== "model"
    ) {
      return { resumeRoleIds: [] };
    }
  }
  const items = await listActivities(origin);
  const resumeRoleIds: string[] = [];
  for (const item of items) {
    if (item.state === "active") resumeRoleIds.push(item.roleId);
    if (item.state !== "stopped") await stopRole(origin, item.roleId);
  }
  return { resumeRoleIds };
}

async function closeScope(origin: string, session: ScopeSession): Promise<void> {
  for (const roleId of session.resumeRoleIds) {
    await resumeRole(origin, roleId);
  }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method;
  return input instanceof Request ? input.method : "GET";
}

/**
 * fetch 的测试替身：受保护的配置写入自动套上停止/恢复作用域，
 * 其余请求原样转发。可以直接替换测试文件里的所有 fetch 调用。
 */
export async function configFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(urlOf(input));
  } catch {
    return fetch(input, init);
  }
  const scope = classifyConfigWrite(methodOf(input, init), url.pathname);
  if (scope === null) return fetch(input, init);
  const origin = url.origin;
  const session = await openScope(origin, scope);
  try {
    return await fetch(input, init);
  } finally {
    await closeScope(origin, session);
  }
}
