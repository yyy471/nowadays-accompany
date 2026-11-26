import { randomUUID } from "node:crypto";
import type { ExtensionFiles } from "../application/extensions/extension-files.js";
import type { ModelBindingResolver } from "../application/resources/model-binding-resolver.js";
import type { ConversationTool, ConversationToolContext } from "../domain/conversation.js";
import { McpToolClient, managedPiCommand } from "./client.js";
import type { PiModelProxy } from "./model-proxy.js";

export class ManagedPi {
  private readonly clients = new Map<string, Promise<McpToolClient>>();
  private readonly jobs = new Map<string, { roleId: string; taskId: string | null; token: string; timer: NodeJS.Timeout }>();
  private readonly stopping = new Set<Promise<void>>();
  private closing = false;
  constructor(private proxy: PiModelProxy, private bindings: ModelBindingResolver, private work: ExtensionFiles,
    private port: () => number, private active: (roleId: string) => boolean, private ttlMs = 15 * 60_000) {}

  private connection(roleId: string) {
    if (!this.active(roleId)) throw new Error("PI_ROLE_STOPPED");
    if (this.closing) throw new Error("PI_CLOSING");
    let pending = this.clients.get(roleId);
    if (!pending) {
      pending = McpToolClient.connect({ command: managedPiCommand, args: [], env: {} }, {
        onClose: () => {
          if (this.clients.get(roleId) === pending) {
            this.clients.delete(roleId);
            this.revokeRole(roleId);
          }
        },
      });
      this.clients.set(roleId, pending);
      void pending.catch(() => { if (this.clients.get(roleId) === pending) this.clients.delete(roleId); });
    }
    return pending;
  }
  async tools(roleId: string): Promise<ConversationTool[]> {
    const discovery = await this.connection(roleId);
    return (await discovery.listTools()).map(tool => ({ name: tool.name, description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>, source: "mcp",
      execute: async (args, context) => {
        const pending = this.connection(roleId);
        const client = await pending;
        context.checkDispatch?.();
        if (context.signal.aborted || this.clients.get(roleId) !== pending) throw new Error("PI_ROLE_STOPPED");
        context.onDispatch?.();
        const result = tool.name === "pi_task_start" ? await this.start(client, args, context) :
          await this.call(client, roleId, tool.name, args);
        return { status: result.isError ? "failed" : "success", adaptedResult: result.structuredContent ?? result.content };
      } }));
  }
  private async start(client: McpToolClient, args: Record<string, unknown>, context: ConversationToolContext) {
    const { roleId, taskId } = context;
    if (typeof args.extId !== "string" || typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("PI_ARGUMENTS_INVALID");
    const binding = (taskId && this.bindings.resolveChatForTask(roleId, taskId)) || this.bindings.resolveChat(roleId);
    const cwd = this.work.workspace(args.extId);
    const jobId = randomUUID();
    const baseUrl = "http://127.0.0.1:" + this.port() + "/v1/internal/model-proxy";
    const expiresAt = Date.now() + this.ttlMs;
    const token = this.proxy.issue(roleId, binding, !!context.autonomous, expiresAt);
    const timer = setTimeout(() => this.forget(jobId), this.ttlMs).unref();
    this.jobs.set(jobId, { roleId, taskId, token, timer });
    try {
      const result = await client.callTool("pi_task_start", { extId: args.extId, prompt: args.prompt }, { meta: { nowadays: {
        jobId, cwd, baseUrl, lease: token, expiresAt, modelName: binding.modelName, protocol: binding.config.protocol,
      } } });
      if (result.isError) this.forget(jobId);
      return result;
    } catch (error) { this.forget(jobId); throw error; }
  }
  private forget(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.proxy.revoke(job.token);
    clearTimeout(job.timer);
    this.jobs.delete(jobId);
  }
  private call(client: McpToolClient, roleId: string, name: string, args: Record<string, unknown>) {
    const id = String(args.jobId);
    if (name === "pi_task_cancel" && this.jobs.get(id)?.roleId === roleId) this.forget(id);
    return client.callTool(name, { jobId: id });
  }
  cancelTask(roleId: string, taskId: string) {
    for (const [id, job] of this.jobs) if (job.roleId === roleId && job.taskId === taskId) {
      this.forget(id);
      void this.clients.get(roleId)?.then(c => c.callTool("pi_task_cancel", { jobId: id })).catch(() => {});
    }
  }
  private revokeRole(roleId: string) {
    for (const [id, job] of this.jobs) if (job.roleId === roleId) this.forget(id);
  }
  async stop(roleId: string) {
    this.revokeRole(roleId);
    const pending = this.clients.get(roleId);
    this.clients.delete(roleId);
    if (!pending) return;
    const cleanup = pending.then(client => client.close()).catch(() => {});
    this.stopping.add(cleanup);
    try { await cleanup; } finally { this.stopping.delete(cleanup); }
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.stopping, ...[...this.clients.keys()].map(roleId => this.stop(roleId))]);
  }
}
