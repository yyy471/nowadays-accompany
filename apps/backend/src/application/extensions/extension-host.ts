import { z } from "zod";
import { AppError } from "../../domain/errors.js";
import { ExtensionFiles, extIdSchema, upsertSchema, type Definition, type Manifest, type ToolSpec } from "./extension-files.js";
import { ExtensionProcess, type PlatformEvent, type ServiceCall } from "./extension-process.js";

export type Notice = { extId: string; message: string; data?: unknown };
const unavailable = () => new AppError(409, "EXTENSION_UNAVAILABLE", "扩展工具当前不可用");
function diagnostic(err: unknown) {
  return { code: err instanceof AppError ? err.code : "EXTENSION_LOAD_FAILED",
    message: err instanceof Error ? err.message : String(err) };
}
function validated<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(400, "EXTENSION_ARGUMENTS_INVALID", result.error.message);
  return result.data;
}

export class ExtensionHost {
  private readonly files: ExtensionFiles;
  private readonly records = new Map<string, Manifest>();
  private readonly active = new Map<string, ExtensionProcess>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<(notice: Notice) => void>();
  private readonly uiListeners = new Set<(event: "snapshot" | "notice", payload: unknown) => void>();
  private readonly children = new Set<ExtensionProcess>();
  private closing = false;
  ready: Promise<void> = Promise.resolve();

  constructor(root: string, private readonly timeouts = { initMs: 10_000, callMs: 15_000 }) {
    this.files = new ExtensionFiles(root);
  }
  restore() {
    const jobs: Promise<unknown>[] = [];
    let ids: string[];
    try { ids = this.files.ids(); }
    catch (error) {
      console.error("EXTENSION_DIRECTORY_UNAVAILABLE", error);
      return;
    }
    for (const id of ids) {
      try {
        const record = this.files.read(id);
        if (!record) continue;
        this.records.set(id, record);
        if (record.status === "enabled") jobs.push(this.toggle(id, "enable"));
      } catch (err) { console.error("EXTENSION_RESTORE_FAILED", id, err); }
    }
    this.ready = Promise.allSettled(jobs).then(results => {
      for (const result of results) if (result.status === "rejected") console.error("EXTENSION_RESTORE_FAILED", result.reason);
    });
  }
  private run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    validated(extIdSchema, id);
    if (this.closing) throw unavailable();
    const previous = this.operations.get(id);
    const job = previous ? previous.then(fn, fn) : Promise.resolve().then(fn);
    this.operations.set(id, job);
    const release = () => { if (this.operations.get(id) === job) this.operations.delete(id); };
    void job.then(release, release);
    return job;
  }
  private record(id: string) {
    validated(extIdSchema, id);
    const record = this.records.get(id);
    if (!record) throw new AppError(404, "EXTENSION_NOT_FOUND", "找不到此扩展", { extId: id });
    return record;
  }
  private save(id: string, record: Manifest) {
    this.files.save(id, record);
    this.records.set(id, record);
  }
  get(id: string) {
    const { kv, ...manifest } = this.record(id);
    const process = this.active.get(id);
    return { extId: id, ...manifest, status: manifest.status === "enabled" && !process ? "starting" : manifest.status,
      pid: process?.child.pid ?? null };
  }
  list() { return [...this.records.keys()].sort().map(id => this.get(id)); }
  uiAsset(id: string, file: string, version: string | null) {
    const record = this.records.get(id);
    if (!record || !this.active.has(id) || record.status !== "enabled" || (version !== null && version !== record.version))
      throw new AppError(404, "EXTENSION_ASSET_NOT_FOUND", "此扩展资源不可用");
    return this.files.uiAsset(id, record, file);
  }
  private uiSnapshot() {
    return this.list().map(({ extId, version, status, ui, lastError }) => ({ extId, version, status, ui, lastError }));
  }
  subscribeUi(listener: (event: "snapshot" | "notice", payload: unknown) => void) {
    listener("snapshot", this.uiSnapshot());
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }
  private publishUi(event: "snapshot" | "notice" = "snapshot", payload?: unknown) {
    if (!this.uiListeners.size) return;
    const data = payload ?? this.uiSnapshot();
    for (const listener of this.uiListeners) {
      try { listener(event, data); } catch (error) { console.error("EXTENSION_UI_PUSH_FAILED", error); }
    }
  }
  onNotice(listener: (notice: Notice) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(notice: Notice) {
    for (const listener of this.listeners) {
      try { listener(notice); } catch (error) { console.error("EXTENSION_NOTICE_FAILED", error); }
    }
  }
  publish(name: PlatformEvent, data: unknown) {
    for (const [id, worker] of this.active) {
      if (worker.events.includes(name)) void worker.request("event", name, data)
        .catch(error => console.error("EXTENSION_EVENT_FAILED", id, name, error));
    }
  }
  tools(admin: boolean) {
    return [...this.active].flatMap(([extId, worker]) => worker.tools
      .filter(spec => admin || spec.scope === "all_roles").map(spec => ({ extId, spec })));
  }
  call(id: string, name: string, admin: boolean, args: unknown, context: object, onDispatch?: () => void) {
    const worker = this.active.get(id);
    const spec = worker?.tools.find(t => t.name === name);
    if (!worker || !spec || (!admin && spec.scope !== "all_roles")) throw unavailable();
    onDispatch?.();
    return worker.request("call", name, args, context);
  }

  upsert(input: unknown) {
    const {extId, manifest, files} = validated(upsertSchema, input);
    return this.run(extId, async () => {
      this.files.stage(extId, manifest, files);
      await this.activate(extId, manifest, true);
      return this.get(extId);
    });
  }
  toggle(id: string, action: "enable" | "reload" | "disable") {
    return this.run(id, async () => {
      const current = this.record(id);
      const old = this.active.get(id);
      if (action === "disable") {
        this.save(id, { ...current, status: "disabled" });
        this.active.delete(id);
        this.publishUi();
        await old?.dispose();
      } else if (action === "reload" || !old) {
        await this.activate(id, current, false);
      }
      return this.get(id);
    });
  }
  delete(id: string) {
    return this.run(id, async () => {
      this.save(id, { ...this.record(id), status: "disabled" });
      const old = this.active.get(id);
      this.active.delete(id);
      this.publishUi();
      await old?.dispose();
      this.files.remove(id);
      this.records.delete(id);
      this.publishUi();
      return { extId: id, deleted: true };
    });
  }
  private async activate(id: string, spec: Definition, staged: boolean) {
    const old = this.active.get(id);
    const initial = this.records.get(id);
    let committed = false;
    const writes = new Map<string, unknown>();
    const notices: Notice[] = [];
    let worker: ExtensionProcess | undefined;
    const deliver = (notice: Notice) => {
      this.notify(notice);
      if (this.active.get(id) === worker) this.publishUi("notice", { extId: id, version: spec.version, message: notice.message });
    };
    // 保留调用发生时的当前 KV。候选初始化写入在清单切换时一次合并。
    const service = (call: ServiceCall) => {
      if (call.method === "notify") {
        const notice = { extId: id, ...call.args };
        if (committed) deliver(notice); else notices.push(notice);
        return null;
      }
      const current = this.records.get(id);
      const key = call.args.key;
      if (call.method === "get") {
        if (!committed && writes.has(key)) return writes.get(key);
        return current && Object.hasOwn(current.kv, key) ? current.kv[key] : null;
      }
      if (committed && current) this.save(id, { ...current, kv: { ...current.kv, [key]: call.args.value } });
      else writes.set(key, call.args.value);
      return null;
    };
    try {
      worker = new ExtensionProcess(this.files.entry(id, spec), {
        service,
        inventory: (tools: ToolSpec[]) => {
          if (committed && this.active.get(id) === worker) this.save(id, { ...this.record(id), tools });
        },
        failed: error => {
          if (!committed || this.active.get(id) !== worker) return;
          this.active.delete(id);
          const failed = { ...this.record(id), status: "failed" as const, lastError: diagnostic(error) };
          this.records.set(id, failed);
          this.publishUi();
          try { this.files.save(id, failed); }
          catch (err) { console.error("EXTENSION_FAILURE_PERSIST_FAILED", id, err); }
        },
      }, this.timeouts.callMs, this.timeouts.initMs);
      const child = worker;
      this.children.add(child);
      void child.exited.promise.then(() => this.children.delete(child));
      await worker.ready.promise;
      worker.assertAlive();
      this.save(id, { ...spec, status: "enabled", tools: worker.tools, lastError: null,
        kv: { ...this.records.get(id)?.kv, ...Object.fromEntries(writes) } });
      this.active.set(id, worker);
      committed = true;
      this.publishUi();
    } catch (err) {
      await worker?.dispose();
      const lastError = diagnostic(err);
      const current = this.records.get(id);
      if (staged && initial) this.files.remove(id, spec.version);
      this.save(id, current ? { ...current, status: this.active.has(id) ? "enabled" : "failed", lastError }
        : { ...spec, status: "failed", lastError, tools: [], kv: {} });
      this.publishUi();
      throw new AppError(422, lastError.code, lastError.message, { extId: id, version: spec.version });
    }
    writes.clear();
    for (const notice of notices.splice(0)) deliver(notice);
    await old?.dispose();
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.operations.values()]);
    const workers = [...this.children];
    this.active.clear();
    await Promise.all(workers.map(worker => worker.dispose()));
  }
}
