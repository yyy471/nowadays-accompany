import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EngineeringJobs, type EngineeringJob, type EngineeringTerminal } from "../storage/conversation/engineering-jobs.js";
import type { RoleAccess } from "../application/role/role-access.js";
import { AppError, PiAdminSeatRequiredError } from "../domain/errors.js";
import type { ExtensionFiles } from "../application/extensions/extension-files.js";
import type { EngineeringPool } from "./engineering-pool.js";
import type { ConversationTool, ConversationToolContext } from "../domain/conversation.js";
import { McpToolClient, managedPiCommand } from "./client.js";
import { piApiFlavor, type PiModelProxy } from "./model-proxy.js";

import type { PiToolProxy } from "./tool-proxy.js";

export interface EngineeringStep {
  at: string; tool: string; target?: string; isError: boolean;
  durationMs?: number; exitCode?: number; tail?: string;
}
export interface EngineeringRecentJob {
  jobId: string; roleId: string; taskId: string; windowId: string; origin: "user" | "autonomous";
  extId: string; title: string; modelName: string | null;
  status: "running" | EngineeringTerminal; startedAt: string; finishedAt: string | null;
  durationMs: number | null; summary: string; steps: EngineeringStep[];
}

export class ManagedPi {
  private readonly clients = new Map<string, Promise<McpToolClient>>();
  private readonly jobs = new Map<string, { roleId: string; taskId: string; owner: McpToolClient; connection: Promise<McpToolClient>; token: string; timer: NodeJS.Timeout; failureCode?: string }>();
  private readonly stopping = new Set<Promise<void>>();
  private closing = false;
  private listeners = new Set<() => void>();
  constructor(private proxy: PiModelProxy, private toolsProxy: PiToolProxy, private pool: EngineeringPool, private work: ExtensionFiles,
    private port: () => number, private active: (roleId: string) => boolean,
    private adminSeat: (roleId: string) => boolean, private access: RoleAccess,
    private readySeats: () => string[], private schedule: (roleId: string) => void, private ttlMs = 15 * 60_000) {}

  private connection(roleId: string) {
    if (!this.adminSeat(roleId)) throw new PiAdminSeatRequiredError();
    if (!this.active(roleId)) throw new Error("PI_ROLE_STOPPED");
    if (this.closing) throw new Error("PI_CLOSING");
    let pending = this.clients.get(roleId);
    if (!pending) {
      pending = McpToolClient.connect({ command: managedPiCommand, args: [], env: {} }, {
        onPiTerminal: receipt => {
          const job = this.jobs.get(receipt.jobId);
          if (job && job.connection === pending && job.roleId === roleId) {
            this.finish(receipt.jobId, receipt.state, receipt.summary);
          }
        },
        onClose: () => {
          if (this.clients.get(roleId) === pending) this.clients.delete(roleId);
          if (pending) this.interruptConnection(pending);
        },
      });
      this.clients.set(roleId, pending);
      void pending.catch(() => { if (this.clients.get(roleId) === pending) this.clients.delete(roleId); });
    }
    return pending;
  }
  async tools(roleId: string, taskId?: string | null): Promise<ConversationTool[]> {
    if (!this.adminSeat(roleId)) throw new PiAdminSeatRequiredError();
    if (!this.pool.discover(roleId, taskId)) return [];
    const discovery = await this.connection(roleId);
    return (await discovery.listTools()).map(tool => ({ name: tool.name, description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>, source: "mcp",
      execute: async (args, context) => {
        if (context.roleId !== roleId) throw new PiAdminSeatRequiredError();
        const pending = this.connection(roleId);
        const client = await pending;
        context.checkDispatch?.();
        if (context.signal.aborted || this.clients.get(roleId) !== pending) throw new Error("PI_ROLE_STOPPED");
        try {
          const result = tool.name === "pi_task_start" ? await this.start(client, pending, args, context) :
            await this.call(client, roleId, tool.name, args, context);
          return { status: result.isError ? "failed" : "success", adaptedResult: result.structuredContent ?? result.content };
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          const diagnostic = { code: error.code, message: error.message, details: error.details };
          return { status: "failed", diagnosticCode: error.code, error: diagnostic, adaptedResult: { error: diagnostic } };
        }
      } }));
  }
  private async start(client: McpToolClient, connection: Promise<McpToolClient>, args: Record<string, unknown>, context: ConversationToolContext) {
    const { roleId, taskId } = context;
    if (typeof args.extId !== "string" || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("PI_ARGUMENTS_INVALID");
    if (!taskId) throw new Error("PI_PARENT_TASK_REQUIRED");
    this.access.withStore(roleId, ({ business }) => business.getTask(roleId, taskId));
    const binding = this.pool.allocate(roleId, taskId);
    const jobId = randomUUID();
    const baseUrl = "http://127.0.0.1:" + this.port() + "/v1/internal/model-proxy";
    const expiresAt = Date.now() + this.ttlMs;
    const cwd = this.work.workspacePath(args.extId, jobId);
    const shared = this.toolsProxy.forJob({ jobId, roleId, taskId, cwd, executionId: context.executionId, autonomous: !!context.autonomous });
    const token = this.proxy.issue(roleId, binding, !!context.autonomous, expiresAt, shared, code => {
      const job = this.jobs.get(jobId);
      if (job) job.failureCode = code;
    });
    try {
      this.work.workspace(args.extId, jobId);
      this.store(roleId, jobs => jobs.register({ jobId, roleId, taskId, windowId: context.windowId,
        origin: context.autonomous ? "autonomous" : "user", extId: String(args.extId), title: String(args.prompt).trim().slice(0, 80),
        modelResourceId: binding.resourceId, modelName: binding.modelName, workDir: cwd, startedAt: new Date().toISOString() }));
    } catch (error) {
      this.proxy.revoke(token);
      this.work.discardJob(jobId);
      throw error;
    }
    const timer = setTimeout(() => this.proxy.revoke(token), this.ttlMs).unref();
    this.jobs.set(jobId, { roleId, taskId, token, timer, owner: client, connection });
    this.notify();
    try {
      context.onDispatch?.();
      const result = await client.callTool("pi_task_start", { extId: args.extId, prompt: args.prompt }, { meta: { nowadays: {
        jobId, cwd, baseUrl, allowShell: binding.allowShell, sharedTools: true, skills: shared.briefs(), lease: token, expiresAt, modelName: binding.modelName, apiFlavor: piApiFlavor(binding.config),
        ...(binding.maxTokens === undefined ? {} : { maxTokens: binding.maxTokens }),
        ...(binding.contextWindow === undefined ? {} : { contextWindow: binding.contextWindow }),
        ...(binding.thinkingLevel === undefined ? {} : { thinkingLevel: binding.thinkingLevel }),
      } } });
      if (result.isError) {
        this.finish(jobId, "failed", "Pi 拒绝启动工程");
        this.work.discardJob(jobId);
      }
      return result;
    } catch (error) { this.finish(jobId, "interrupted_unknown", "启动回执未确认，结果待核查"); throw error; }
  }
  private store<T>(roleId: string, action: (jobs: EngineeringJobs) => T) {
    return this.access.withStore(roleId, s => action(new EngineeringJobs(s.business.db)));
  }
  publishTarget(roleId: string, jobId: string, extId?: string) {
    const job = this.store(roleId, jobs => jobs.find(jobId));
    if (!job || job.roleId !== roleId || (extId !== undefined && job.extId !== extId)) throw new AppError(400, "PI_JOB_TARGET_INVALID", "工程与目标扩展不匹配");
    return job.extId;
  }
  running() {
    return this.readySeats().flatMap(id => this.store(id, jobs => jobs.listRunning())).map(
      ({ jobId, roleId, extId, title, startedAt, status }) => ({ jobId, roleId, extId, title, startedAt, status }));
  }
  recent(limit = 20): EngineeringRecentJob[] {
    return this.readySeats()
      .flatMap(id => this.store(id, jobs => jobs.listRecent(limit)))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.jobId.localeCompare(a.jobId))
      .slice(0, limit)
      .map(job => ({
        jobId: job.jobId, roleId: job.roleId, taskId: job.taskId, windowId: job.windowId, origin: job.origin,
        extId: job.extId, title: job.title, modelName: job.modelName, status: job.status, summary: job.summary,
        startedAt: job.startedAt, finishedAt: job.finishedAt,
        durationMs: job.finishedAt ? Math.max(0, Date.parse(job.finishedAt) - Date.parse(job.startedAt)) : null,
        steps: this.steps(job),
      }));
  }
  // 步骤日志位于草稿目录的上一级；缺失、损坏或不属于本工程时一律视为无记录。
  private steps(job: EngineeringJob): EngineeringStep[] {
    if (!job.workDir) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(path.dirname(job.workDir), "steps.json"), "utf8")) as
        { jobId?: unknown; steps?: unknown } | null;
      if (!parsed || parsed.jobId !== job.jobId || !Array.isArray(parsed.steps)) return [];
      return parsed.steps.slice(-50).flatMap(raw => {
        if (!raw || typeof raw !== "object") return [];
        const step = raw as Record<string, unknown>;
        if (typeof step.at !== "string" || typeof step.tool !== "string") return [];
        return [{
          at: step.at, tool: step.tool,
          ...(typeof step.target === "string" ? { target: step.target.slice(0, 160) } : {}),
          isError: step.isError === true,
          ...(typeof step.durationMs === "number" && Number.isFinite(step.durationMs)
            ? { durationMs: Math.max(0, Math.round(step.durationMs)) } : {}),
          ...(typeof step.exitCode === "number" && Number.isInteger(step.exitCode) ? { exitCode: step.exitCode } : {}),
          ...(typeof step.tail === "string" ? { tail: step.tail.slice(-240) } : {}),
        }];
      });
    } catch { return []; }
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 单个订阅者（例如已断开的 SSE 响应）异常不影响其他订阅者；
        // `finish()` 仍会继续执行后续的 `schedule()`，避免工程排队停滞。
      }
    }
  }
  private finish(id: string, status: EngineeringTerminal, summary: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    const modelError = (status === "completed" || status === "failed") && job.failureCode;
    this.store(job.roleId, jobs => jobs.settle(id, modelError ? "failed" : status, modelError || summary, new Date().toISOString()));
    this.proxy.revoke(job.token);
    clearTimeout(job.timer);
    this.jobs.delete(id);
    this.notify();
    if (!this.closing) this.schedule(job.roleId);
  }
  private async call(client: McpToolClient, roleId: string, name: string, args: Record<string, unknown>, context: ConversationToolContext) {
    const id = String(args.jobId);
    const job = this.store(roleId, jobs => jobs.find(id));
    if (!job) throw new AppError(404, "PI_JOB_NOT_FOUND", "找不到工程");
    if (!this.pool.discover(roleId) && (job.taskId !== context.taskId || !this.pool.discover(roleId, context.taskId)))
      throw new AppError(403, "PI_JOB_UNAVAILABLE", "当前任务没有此工程的续用记录");
    context.onDispatch?.();
    if (job.status !== "running") {
      const view = { jobId: id, state: job.status, result: job.summary };
      return { isError: false, structuredContent: view, content: view };
    }
    if (name === "pi_task_cancel") return this.cancel(id);
    return client.callTool(name, { jobId: id });
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError(409, "PI_JOB_NOT_RUNNING", "工程已结束");
    this.proxy.revoke(job.token);
    return job.owner.callTool("pi_task_cancel", { jobId: id });
  }
  cancelTask(roleId: string, taskId: string) {
    for (const [id, job] of this.jobs) if (job.roleId === roleId && job.taskId === taskId)
      void this.cancel(id).catch(error => console.warn("PI_CANCEL_FAILED", id, error));
  }
  private interruptConnection(connection: Promise<McpToolClient>) {
    for (const [id, job] of this.jobs) if (job.connection === connection)
      this.finish(id, "interrupted_unknown", "工程连接已断开，结果待核查");
  }
  async stop(roleId: string) {
    const pending = this.clients.get(roleId);
    if (!pending) return;
    this.clients.delete(roleId);
    const ids = [...this.jobs].filter(([, job]) => job.connection === pending).map(([id]) => id);
    const cancellations = ids.map(id => this.cancel(id));
    const cleanup = (async () => {
      const results = await Promise.allSettled(cancellations);
      for (const r of results) if (r.status === "rejected") console.warn("PI_STOP_CANCEL_FAILED", r.reason);
      const client = await pending;
      try { await client.close(); } finally { this.interruptConnection(pending); }
    })();
    this.stopping.add(cleanup);
    try { await cleanup; } finally { this.stopping.delete(cleanup); }
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.stopping, ...[...this.clients.keys()].map(roleId => this.stop(roleId))]);
  }
}
