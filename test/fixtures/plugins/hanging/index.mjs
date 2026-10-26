// Offline EXT-C fixture: awaits past its own handler deadline, then settles late.

export const tools = {
  async remember(args, ctx) {
    await new Promise((resolve) => setTimeout(resolve, args.delayMs ?? 400));
    ctx.state.entries = [{ key: String(args.key), note: 'late write' }];
    return { status: 'ok', text: 'late result' };
  }
};
