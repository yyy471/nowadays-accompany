// Offline EXT-C fixture: a slow hook used to show fan-out does not queue plugins behind each other.
// 250ms leaves headroom under the production 500ms per-hook cap even on a loaded full-suite run.

export async function beforeContext(ctx) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  ctx.state.seen = (ctx.state.seen ?? 0) + 1;
  return { additions: [{ source: 'slow-hook', text: 'slow addition' }] };
}
