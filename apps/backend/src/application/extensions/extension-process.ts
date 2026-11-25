import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import { toolSpec, type ToolSpec } from "./extension-files.js";

const inventory = z.object({
  tools: z.array(toolSpec), events: z.array(z.enum(["dialogue_batch", "role_exchange"])),
});
export type PlatformEvent = z.infer<typeof inventory>["events"][number];
const service = z.discriminatedUnion("method", [
  z.object({ method: z.literal("get"), args: z.object({ key: z.string().min(1) }) }),
  z.object({ method: z.literal("set"), args: z.object({ key: z.string().min(1), value: z.json() }) }),
  z.object({ method: z.literal("notify"), args: z.object({ message: z.string().min(1), data: z.json().optional() }) }),
]);
export type ServiceCall = z.infer<typeof service>;
interface Hooks {
  service(call: ServiceCall): unknown;
  inventory(tools: ToolSpec[]): void;
  failed(error: AppError): void;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class ExtensionProcess {
  readonly child: ChildProcess;
  readonly ready = deferred<void>();
  readonly exited = deferred<void>();
  private readonly calls = new Map<number, { done: ReturnType<typeof deferred<unknown>>; timer: NodeJS.Timeout }>();
  private readonly startup: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private serial = 0;
  private stopping = false;
  private error: AppError | undefined;
  private stderr = "";
  tools: ToolSpec[] = [];
  events: PlatformEvent[] = [];

  constructor(location: {dir: string; entry: string}, private readonly hooks: Hooks,
    private readonly callMs: number, initMs: number) {
    const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
    const modules = fileURLToPath(new URL("../../../node_modules/", import.meta.url));
    this.child = fork(runner, [location.entry], {
      cwd: location.dir, stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: ["--permission", "--allow-fs-read=" + modules, "--allow-fs-read=" + location.dir,
        "--unhandled-rejections=strict"],
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    });
    this.startup = setTimeout(() => this.fail("EXTENSION_INIT_TIMEOUT", "扩展初始化超时"), initMs);
    this.child.stderr!.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.child.on("error", err => this.fail("EXTENSION_PROCESS_ERROR", err.message));
    this.child.on("message", raw => {
      try { this.receive(z.record(z.string(), z.unknown()).parse(raw)); }
      catch (err) { this.fail("EXTENSION_IPC_INVALID", String(err)); }
    });
    this.child.once("close", (code, signal) => {
      if (!this.stopping || this.calls.size) this.fail("EXTENSION_CRASHED", this.stderr || `进程退出 ${code ?? signal}`);
      this.clearTimers();
      this.exited.resolve();
    });
  }

  private send(message: object) {
    this.child.send(message, error => { if (error && !this.stopping) this.fail("EXTENSION_IPC_CLOSED", error.message); });
  }
  private receive(msg: Record<string, unknown>) {
    if (this.error) return;
    switch (msg.type) {
      case "fatal": this.fail(this.heartbeat ? "EXTENSION_CRASHED" : "EXTENSION_LOAD_FAILED", String(msg.error)); break;
      case "ready":
      case "inventory": {
        const specs = inventory.parse(msg);
        if (new Set(specs.tools.map(t => t.name)).size !== specs.tools.length) throw Error("EXTENSION_DUPLICATE_TOOL");
        this.tools = specs.tools;
        this.events = specs.events;
        this.hooks.inventory(this.tools);
        if (msg.type === "ready" && !this.heartbeat) {
          clearTimeout(this.startup);
          let lastPong = Date.now();
          this.onPong = () => { lastPong = Date.now(); };
          this.heartbeat = setInterval(() => {
            if (Date.now() - lastPong > 15_000) this.fail("EXTENSION_UNRESPONSIVE", "扩展未响应心跳");
            else this.send({ type: "ping" });
          }, 5000);
          this.ready.resolve();
        }
        break;
      }
      case "pong": this.onPong(); break;
      case "service": {
        const id = z.number().int().parse(msg.id);
        try { this.send({ type: "reply", id, value: this.hooks.service(service.parse(msg)) }); }
        catch (err) { this.send({ type: "reply", id, error: String(err) }); }
        break;
      }
      case "result": {
        const id = z.number().int().parse(msg.id);
        const pending = this.calls.get(id);
        if (!pending) break;
        this.calls.delete(id);
        clearTimeout(pending.timer);
        if (msg.error) pending.done.reject(new AppError(422,
          String(msg.error).endsWith("EXTENSION_UNAVAILABLE") ? "EXTENSION_UNAVAILABLE" : "EXTENSION_TOOL_FAILED", String(msg.error)));
        else pending.done.resolve(msg.value ?? null);
        break;
      }
      default: throw Error("EXTENSION_UNKNOWN_MESSAGE");
    }
  }
  private onPong = () => {};
  private clearTimers() { clearTimeout(this.startup); clearInterval(this.heartbeat); }
  private fail(code: string, message: string) {
    if (this.error) return;
    const error = this.error = new AppError(503, code, message);
    this.clearTimers();
    this.ready.reject(error);
    for (const {done, timer} of this.calls.values()) { clearTimeout(timer); done.reject(error); }
    this.calls.clear();
    this.child.kill("SIGKILL");
    this.hooks.failed(error);
  }
  assertAlive() { if (this.error) throw this.error; }
  request(type: "call" | "event", name: string, args: unknown, context?: object) {
    this.assertAlive();
    if (this.stopping) throw new AppError(409, "EXTENSION_UNAVAILABLE", "扩展正在退出");
    const id = ++this.serial;
    const done = deferred<unknown>();
    const timer = setTimeout(() => this.fail("EXTENSION_CALL_TIMEOUT", "扩展调用超时：" + name), this.callMs);
    this.calls.set(id, {done, timer});
    this.send({ type, id, name, args, context });
    return done.promise;
  }
  async dispose() {
    this.stopping = true;
    await Promise.allSettled([...this.calls.values()].map(c => c.done.promise));
    this.clearTimers();
    if (!this.error && this.child.connected) this.send({ type: "dispose" });
    const timer = setTimeout(() => {
      console.warn("EXTENSION_DISPOSE_TIMEOUT", this.child.pid);
      this.child.kill("SIGKILL");
    }, 2000);
    try { await this.exited.promise; } finally { clearTimeout(timer); }
  }
}
