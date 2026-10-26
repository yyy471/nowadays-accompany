// Offline EXT-C fixture: blocks the worker event loop so only the host deadline can escape.

function spin(ms) {
  const until = Date.now() + ms;
  let sink = 0;
  while (Date.now() < until) sink += Math.sqrt(sink + 1);
  return sink;
}

export const tools = {
  async remember(args, ctx) {
    spin(args.blockMs ?? 300);
    ctx.state.entries = [{ key: String(args.key), note: 'written after the host gave up' }];
    return { status: 'ok', text: 'late after block' };
  }
};
