import { Context } from "cordis";
import { pathToFileURL } from "node:url";

const ctx = new Context();
const handlers = new Map();
const subscriptions = new Map();
const requests = new Map();
let serial = 0;
let ready = false;
let disposing = false;
const send = message => process.send(message);
const diagnostic = error => String(error?.stack ?? error).slice(0, 4000);
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
  tools: {
    register(spec, handler) {
      if (typeof handler !== "function" || handlers.has(spec.name)) throw Error("EXTENSION_TOOL_INVALID");
      handlers.set(spec.name, { spec, handler });
      changed();
      return ctx.effect(() => () => { handlers.delete(spec.name); changed(); });
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
  } else if (msg.type === "call" || msg.type === "event") {
    try {
      let value;
      if (msg.type === "call") {
        const tool = handlers.get(msg.name);
        if (!tool) throw Error("EXTENSION_UNAVAILABLE");
        value = await tool.handler(msg.args, msg.context);
      } else {
        for (const fn of subscriptions.get(msg.name) ?? []) await fn(msg.args);
      }
      send({ type: "result", id: msg.id, value });
    } catch (error) { send({ type: "result", id: msg.id, error: String(error) }); }
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
