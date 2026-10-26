// Offline EXT-C fixture: a slow hook used to show fan-out does not queue plugins behind each other.

export async function beforeContext(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 400));
  ctx.state.seen = (ctx.state.seen ?? 0) + 1;
  return { additions: [{ source: 'slow-hook', text: 'slow addition' }] };
}
