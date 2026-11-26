import { Context } from "cordis";
import { pathToFileURL } from "node:url";

const ctx = new Context();
const handlers = new Map();
const uiActions = new Map();
const subscriptions = new Map();
const requests = new Map();
let serial = 0;
let registration = 0;
let ready = false;
let disposing = false;
const send = message => process.send(message);
function diagnostic(error) {
  const stack = String(error?.stack ?? error);
  if (error instanceof TypeError && stack.includes("reading 'dispose'") && stack.includes("Scope.effect")) {
    return "EXTENSION_EFFECT_INVALID: ctx.effect 的初始化函数必须返回清理函数。api.tools.register 和 api.events.on 已自动清理。额外释放资源可用 api.onDispose(fn)。请用新版本号重新提交。\n" + stack.slice(0, 1000);
  }
  return stack.slice(0, 4000);
}
ctx.on("internal/error", error => send({ type: "fatal", error: diagnostic(error) }));
const inventory = () => ({
  tools: [...handlers.values()].map(item => item.spec),
  events: [...subscriptions.keys()],
});
const changed = () => { if (ready) send({ type: "inventory", ...inventory() }); };
function service(method, args) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    requests.set(id, { resolve, reject });
    if (disposing) process.channel.ref();
    send({ type: "service", id, method, args });
  });
}
const platform = {
  onDispose(cleanup) {
    if (typeof cleanup !== "function") throw Error("EXTENSION_DISPOSER_INVALID");
    return ctx.effect(() => cleanup);
  },
  tools: {
    register(spec, handler) {
      if (typeof handler !== "function" || handlers.has(spec.name)) throw Error("EXTENSION_TOOL_INVALID");
      handlers.set(spec.name, { spec: { ...spec, regId: ++registration }, handler });
      changed();
      return ctx.effect(() => () => { handlers.delete(spec.name); changed(); });
    },
  },
  ui: {
    onAction(name, handler) {
      if (typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) ||
          typeof handler !== "function" || uiActions.has(name)) throw Error("EXTENSION_UI_ACTION_INVALID");
      return ctx.effect(() => {
        uiActions.set(name, handler);
        return () => { uiActions.delete(name); };
      });
    },
  },
  events: {
    on(name, handler) {
      if (!["dialogue_batch", "role_exchange"].includes(name) || typeof handler !== "function") throw Error("EXTENSION_EVENT_INVALID");
      const group = subscriptions.get(name) ?? new Set();
      group.add(handler);
      subscriptions.set(name, group);
      changed();
      return ctx.effect(() => () => {
        group.delete(handler);
        if (!group.size) subscriptions.delete(name);
        changed();
      });
    },
  },
  kv: { get: key => service("get", { key }), set: (key, value) => service("set", { key, value }) },
  notify: notice => service("notify", notice),
};

process.once("disconnect", () => process.exit(0));
process.on("message", async msg => {
  if (msg.type === "reply") {
    const pending = requests.get(msg.id);
    if (!pending) return;
    requests.delete(msg.id);
    if (msg.error) pending.reject(Error(msg.error));
    else pending.resolve(msg.value);
    if (disposing && !requests.size) process.channel.unref();
  } else if (msg.type === "ping") {
    send({ type: "pong" });
  } else if (msg.type === "dispose") {
    ready = false;
    disposing = true;
    await ctx.stop();
    // 异步 disposer 的计时器与在途 IPC 继续保活，直至自然排空。
    if (!requests.size) process.channel.unref();
  } else if (msg.type === "call" || msg.type === "event" || msg.type === "ui-action") {
    try {
      let value;
      if (msg.type === "call") {
        const tool = handlers.get(msg.name);
        if (!tool || tool.spec.regId !== msg.regId) throw Error("EXTENSION_UNAVAILABLE");
        value = await tool.handler(msg.args, msg.context);
      } else if (msg.type === "ui-action") {
        const handler = uiActions.get(msg.name);
        if (!handler) {
          send({ type: "result", id: msg.id, code: "EXTENSION_UI_ACTION_NOT_FOUND", error: "扩展未登记此界面动作" });
          return;
        }
        value = await handler(msg.args);
      } else {
        for (const fn of subscriptions.get(msg.name) ?? []) await fn(msg.args);
      }
      send({ type: "result", id: msg.id, value });
    } catch (error) {
      send({ type: "result", id: msg.id, error: String(error),
        code: msg.type === "ui-action" ? "EXTENSION_UI_ACTION_FAILED" : undefined });
    }
  }
});
try {
  await ctx.start();
  const plugin = await import(pathToFileURL(process.argv[2]).href);
  await (plugin.default ?? plugin.apply)(ctx, platform);
  await ctx.lifecycle.flush();
  ready = true;
  send({ type: "ready", ...inventory() });
} catch (error) { send({ type: "fatal", error: diagnostic(error) }); }
