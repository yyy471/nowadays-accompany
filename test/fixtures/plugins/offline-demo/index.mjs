// Offline EXT-C fixture: no network, no filesystem, no timers.

let initialized = false;
let disposed = false;

export async function init() {
  initialized = true;
  return { ok: true };
}

export async function dispose() {
  disposed = true;
  return { ok: true };
}

export const tools = {
  async remember(args, ctx) {
    if (args.refuse) throw new Error('remember refused');
    if (!Array.isArray(ctx.state.entries)) ctx.state.entries = [];
    ctx.state.entries.push({ key: String(args.key), note: String(args.note) });
    ctx.state.lastInvocationId = ctx.invocationId;
    ctx.state.initialized = initialized;
    return { status: 'ok', text: `已记住 ${args.key}` };
  },
  async recall(args, ctx) {
    const entries = Array.isArray(ctx.state.entries) ? ctx.state.entries : [];
    const hits = entries.filter((entry) => entry.key === String(args.key));
    return {
      status: 'ok',
      text: hits.length ? hits[hits.length - 1].note : '(none)',
      data: { total: entries.length, hits: hits.length, disposed }
    };
  }
};

export async function beforeContext(ctx) {
  ctx.state.turns = (ctx.state.turns ?? 0) + 1;
  const entries = Array.isArray(ctx.state.entries) ? ctx.state.entries : [];
  if (!entries.length) return { additions: [] };
  const last = entries[entries.length - 1];
  return {
    additions: [{
      source: 'offline-demo',
      text: `offline notes=${entries.length} last=${last.key}:${last.note} scope=${ctx.scope.kind}/${ctx.scope.peerId}/${ctx.scope.contextEpoch}/shared=${ctx.scope.accountShared}`
    }]
  };
}

export async function afterTurn(ctx) {
  ctx.state.replies = (ctx.state.replies ?? 0) + 1;
  ctx.state.lastOutcome = ctx.outcome;
}

export async function undeclaredHandler() {
  throw new Error('undeclared export must never become a tool');
}
