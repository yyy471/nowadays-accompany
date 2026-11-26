import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AutonomyService } from "../application/conversation/autonomy-service.js";
import { runSkillScriptProcess } from "../application/conversation/agent-tools.js";
import type { RoleAccess } from "../application/role/role-access.js";
import { taskToolResources } from "../application/resources/task-tool-resources.js";
import { isAdminSeat } from "../domain/admin-seat.js";
import { AppError, PiAdminSeatRequiredError } from "../domain/errors.js";
import { isManagedPiResource, mcpConfigSchema } from "../domain/resource.js";
import { readJsonBody } from "../http/body.js";
import { SkillLibrary } from "../skills/skill-library.js";
import type { AppStore } from "../storage/core/app-store.js";
import { McpToolClient, type McpToolInfo } from "./client.js";
import type { PiModelProxy } from "./model-proxy.js";

type Job = { jobId: string; roleId: string; taskId: string; executionId: string; cwd: string; autonomous: boolean };
type Skill = { id: string; resourceId: string; directory: string; name: string; description: string; source: string; realRoot: string };
type Outcome = { status: "failed" | "unknown" | "success"; result: unknown };
type Dispatch = (start: () => void) => Promise<Outcome>;
type ExternalTool = { resourceId: string; original: string; spec: McpToolInfo };
const revokedLease = () => new AppError(403, "PI_LEASE_REVOKED", "工程租约已失效");
const unavailable = () => new AppError(404, "PI_TOOL_UNAVAILABLE", "工程没有此项能力");
const unavailableMcp = () => new AppError(502, "PI_MCP_UNAVAILABLE", "外部 MCP 无法连接");
const idFor = (id: string, name: string) => createHash("sha256").update(JSON.stringify([id, name])).digest("hex").slice(0, 24);
const callSchema = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict();
const readSkill = z.object({ id: z.string(), path: z.string().min(1).default("SKILL.md") }).strict();
const runSkill = z.object({ id: z.string(), path: z.string().min(1), args: z.array(z.string()).max(100).default([]) }).strict();

// 以 stdio 握手身份和原始能力名判定；角色可编辑的资源显示名称不参与授权。
function external(client: McpToolClient) {
  return !!client.serverName && !["nowadays-pi", "nowadays-local-tools", "admin-tools", "nowadays-desktop-takeover"].includes(client.serverName.toLowerCase());
}
function permitted(name: string) {
  return !/^(?:pi_task_|admin[_-]|app_|ext_|extension_|desktop_|computer_|takeover_|(?:command_run|shell_exec|run_command|exec_command|run_shell_command|shell|bash|powershell)$)/i.test(name);
}

// 工具提供方可能在描述、schema、回执或错误里照抄启动环境；命中即不转发该载荷。
const sensitiveName = /(?:key|token|secret|password|passwd|pwd|auth|bearer|cookie|credential|private)/i;
const publicOption = /^--(?:max-tokens|token-limit|tokens|auth-mode|sort-key)$/i;
function credentialValue(value: string | undefined): value is string {
  return !!value && value.trim().length >= 6 && !/^(?:true|false|none|null|off|on|enabled|disabled|default)$/i.test(value.trim());
}
function containsPrivate(value: unknown, privateValues: string[]): boolean {
  if (typeof value === "string") return privateValues.some(secret => secret && value.includes(secret));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => containsPrivate(key, privateValues) || containsPrivate(item, privateValues));
}

export class PiJobTools {
  private readonly skills = new Map<string, Skill>();
  private readonly resources: string[] = [];
  private catalog?: Promise<Map<string, ExternalTool>>;
  constructor(private app: AppStore, private access: RoleAccess, private autonomy: AutonomyService,
    private appRoot: string, private job: Job, private onSettled: (roleId: string, taskId: string) => void) {
    if (!isAdminSeat(access.requireReady(job.roleId).builtinKey)) throw new PiAdminSeatRequiredError();
    const resources = access.withStore(job.roleId, ({ business }) => {
      const retained = new Set(business.listResourceContinuations(job.roleId, job.taskId).filter(r => !r.endedAt).map(r => r.resourceId));
      const selected = taskToolResources(app, business.listRoleBindings(job.roleId), retained);
      for (const { resourceId } of selected) {
        if (!retained.has(resourceId)) business.grantResourceContinuation({ roleId: job.roleId, taskId: job.taskId, resourceId });
      }
      return selected;
    });
    for (const resource of resources) {
      const { resourceId } = resource;
      if (resource.kind === "mcp" && !isManagedPiResource(resource)) this.resources.push(resourceId);
      if (resource.kind !== "skill") continue;
      const source = path.resolve(appRoot, String(resource.config.sourcePath));
      if (!fs.existsSync(source)) continue;
      const realRoot = fs.realpathSync(source);
      for (const { sourcePath, name, description, directory } of new SkillLibrary(realRoot).discover()) {
        const packageKey = sourcePath === realRoot ? "" : directory;
        const id = idFor(resourceId, packageKey);
        this.skills.set(id, { id, name, description, resourceId, directory: packageKey, source, realRoot });
      }
    }
  }
  briefs() { return Array.from(this.skills.values(), ({ id, name, description }) => ({ id, name, description })); }

  private config(id: string) {
    const resource = this.app.getResource(id);
    if (resource.kind !== "mcp" || isManagedPiResource(resource)) throw unavailable();
    return mcpConfigSchema.parse(resource.config);
  }
  private checkWorkspace() {
    if (fs.realpathSync.native(this.job.cwd) !== this.job.cwd) throw unavailable();
  }
  taskOpen() {
    const { roleId, taskId } = this.job;
    const status = this.access.withStore(roleId, ({ business }) => business.getTask(roleId, taskId).status);
    return status === "active" || status === "paused";
  }
  private async connect(resourceId: string) {
    const config = this.config(resourceId);
    const privateValues = Object.entries(config.env)
      .filter(([key, value]) => sensitiveName.test(key) && credentialValue(value)).map(([, value]) => value);
    for (const [index, arg] of config.args.entries()) {
      const [name = "", ...rest] = arg.split("=");
      if (publicOption.test(name)) continue;
      const sensitive = sensitiveName.test(name);
      const flag = name === "-k" || (name.startsWith("--") && sensitive);
      const value = rest.length && (flag || sensitive) ? rest.join("=")
        : flag ? config.args[index + 1] : /^-k(.+)$/.exec(arg)?.[1];
      if (credentialValue(value) && !/^\d+$/.test(value.trim())) privateValues.push(value);
    }
    this.checkWorkspace();
    const client = await McpToolClient.connect({ ...config, env: { ...config.env, NOWADAYS_WORKSPACE: this.job.cwd } }, { cwd: this.job.cwd, isolatedEnv: true });
    return { client, privateValues };
  }
  private async discover(check: () => void) {
    const catalog = new Map<string, ExternalTool>();
    for (const resourceId of this.resources) {
      check();
      let client;
      try {
        const connection = await this.connect(resourceId);
        client = connection.client;
        check();
        if (!external(client)) continue;
        for (const info of await client.listTools()) {
          if (!permitted(info.name) || containsPrivate(info.name, connection.privateValues)) continue;
          const name = "mcp_" + idFor(resourceId, info.name) + "_" + info.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
          const spec = { ...info, name, description: "[" + this.app.getResource(resourceId).name + "] " + info.description };
          if (!containsPrivate(spec, connection.privateValues)) catalog.set(name, { resourceId, original: info.name, spec });
        }
      } catch { check(); } finally { await client?.close(); }
    }
    check();
    return catalog;
  }

  async handle(route: string, body: unknown, check: () => void, onDispatch: () => void) {
    check();
    if (route === "skill/read" || route === "skill/run") {
      try {
        const input = route === "skill/read" ? { ...readSkill.parse(body), action: "read" as const }
          : { ...runSkill.parse(body), action: "run" as const };
        const skill = this.skills.get(input.id);
        if (!skill) throw unavailable();
        const source = path.resolve(this.appRoot, String(this.app.getResource(skill.resourceId).config.sourcePath));
        const real = fs.realpathSync(source);
        if (skill.source === source && skill.realRoot !== real) throw unavailable();
        skill.source = source;
        skill.realRoot = real;
        const directory = skill.directory || path.basename(real);
        const library = new SkillLibrary(real);
        if (input.action === "read") return { content: library.readFile(directory, input.path).content };
        const script = library.resolveScript(directory, input.path);
        this.checkWorkspace();
        return this.record("skill_run", input, check, onDispatch, async start => {
          start();
          const outcome = await runSkillScriptProcess(script.absolutePath, this.job.cwd, this.job.cwd, input.args, 30_000, script.directory);
          const output = outcome.rawResponse as { stdout?: string; stderr?: string } | undefined;
          const mask = (s = "") => s.replaceAll(pathToFileURL(script.directory).href, "[skill]").replaceAll(script.directory, "[skill]").replaceAll(script.directory.split(path.sep).join("/"), "[skill]").slice(0, 8000);
          return { status: outcome.status, result: { stdout: mask(output?.stdout), stderr: mask(output?.stderr) } };
        });
      } catch { check(); throw unavailable(); }
    }
    const catalog = await (this.catalog ??= this.discover(check));
    check();
    if (route === "list") return { tools: Array.from(catalog.values(), tool => tool.spec) };
    const parsed = callSchema.safeParse(body);
    if (!parsed.success) throw new AppError(400, "PI_TOOL_ARGUMENTS_INVALID", "工具请求格式错误");
    const { name, arguments: args } = parsed.data;
    const tool = catalog.get(name);
    if (!tool) throw unavailable();
    return this.record(name, args, check, onDispatch, async start => {
      const { client, privateValues } = await this.connect(tool.resourceId);
      try {
        if (!external(client) || !permitted(tool.original)) throw unavailable();
        start();
        const response = await client.callTool(tool.original, args);
        if (response.isError) return { status: "failed", result: { code: "MCP_TOOL_ERROR" } };
        return { status: "success", result: containsPrivate(response, privateValues)
          ? { code: "PI_MCP_PRIVATE_OUTPUT" } : response.structuredContent ?? response.content };
      } finally { await client.close().catch(() => {}); }
    });
  }

  // 预留可以跨越握手等待。只有真正派发才计次，已派发的晚到回执始终结算到原调用。
  private async record(name: string, args: Record<string, unknown>, check: () => void, onDispatch: () => void, run: Dispatch) {
    const { roleId, taskId, executionId, jobId, autonomous } = this.job;
    const callId = this.access.withStore(roleId, ({ business }) => business.beginToolCall({
      roleId, taskId, executionId, stepKey: jobId + ":" + randomUUID(), toolName: name, args,
    }).toolCall.toolCallId);
    let dispatched = false;
    let reserved = false;
    let outcome: Outcome = { status: "failed", result: { code: "PI_MCP_UNAVAILABLE" } };
    try {
      if (autonomous) {
        this.autonomy.reserveToolPoint(roleId, callId);
        reserved = true;
      }
      outcome = await run(() => {
        this.access.withStore(roleId, ({ business }) => business.markToolCallRunning(roleId, callId));
        check();
        if (reserved) this.autonomy.commitToolReservation(roleId, callId);
        dispatched = true;
        onDispatch();
      });
    } catch (error) {
      if (!dispatched) {
        try { check(); } catch (revoked) { error = revoked; }
        const failure = error instanceof AppError ? error : unavailableMcp();
        outcome = { status: "failed", result: { code: failure.code } };
        throw failure;
      }
      outcome = { status: "unknown", result: { code: "MCP_TOOL_OUTCOME_UNKNOWN" } };
    } finally {
      if (reserved && !dispatched) this.autonomy.releaseToolReservation(roleId, callId);
      this.access.withStore(roleId, ({ business }) => business.saveToolResult({
        roleId, toolCallId: callId, status: outcome.status, adaptedResult: outcome.result,
      }));
      this.onSettled(roleId, taskId);
    }
    return outcome;
  }
}

export class PiToolProxy {
  private pending = new Set<Promise<unknown>>();
  constructor(private leases: PiModelProxy, private app: AppStore, private access: RoleAccess,
    private autonomy: AutonomyService, private appRoot: string, private onSettled: (roleId: string, taskId: string) => void) {}
  forJob(job: Job) { return new PiJobTools(this.app, this.access, this.autonomy, this.appRoot, job, this.onSettled); }
  async forward(request: IncomingMessage, route: string) {
    const { lease } = this.leases.resolve(request);
    if (!lease.tools) throw unavailable();
    const tools = lease.tools;
    const signal = lease.controller.signal;
    let rejectRevoked!: () => void;
    const revoked = new Promise<never>((_, reject) => {
      rejectRevoked = () => reject(revokedLease());
    });
    signal.addEventListener("abort", rejectRevoked, { once: true });
    const detach = () => signal.removeEventListener("abort", rejectRevoked);
    try {
      const body = await Promise.race([readJsonBody(request), revoked]);
      this.leases.resolve(request);
      if (route === "list" && !tools.taskOpen()) return { tools: [] };
      const check = () => {
        if (!tools.taskOpen()) throw revokedLease();
        this.leases.resolve(request);
      };
      const pending = tools.handle(route, body, check, detach).finally(() => this.pending.delete(pending));
      this.pending.add(pending);
      return await Promise.race([pending, revoked]);
    } finally { detach(); }
  }
  async drain() { await Promise.allSettled(this.pending); }
}
