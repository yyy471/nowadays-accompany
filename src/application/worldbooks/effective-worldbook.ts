import { createHash } from 'node:crypto';
import type { LocalArtifactStore } from '../../artifacts/local.js';
import type { ResolvedRoleCard } from '../../artifacts/types.js';
import { parseConversationWorldbookSource, summarizeWorldbook } from '../../worldbook/schema.js';
import type { ConversationWorldbookSource, EffectiveWorldbook, Worldbook } from '../../worldbook/types.js';

export interface EffectiveWorldbookResult { view: EffectiveWorldbook; book?: Worldbook; guard: string }

/** Shared source resolution for settings, preview and per-turn snapshots. Disabled runtime resolution performs no book I/O. */
export async function resolveEffectiveWorldbook(store: LocalArtifactStore, card: ResolvedRoleCard | undefined,
  rawSource: ConversationWorldbookSource | undefined, inspect = true): Promise<EffectiveWorldbookResult> {
  const source = parseConversationWorldbookSource(rawSource);
  if (!inspect) return { view: { source, state: 'empty', entryCount: 0, enabledEntryCount: 0 }, guard: 'disabled' };
  let book: Worldbook | undefined;
  let state: EffectiveWorldbook['state'] = 'empty';
  let name: string | undefined;
  let error: string | undefined;
  if (source.kind === 'role-card') book = card?.manifest.worldbook;
  else {
    const result = await store.resolveWorldbook(source.ref);
    if (result.status === 'ready') { book = result.worldbook; name = result.name; }
    else { state = result.status === 'missing' ? 'missing' : 'invalid'; error = result.status === 'error' ? '世界书暂时无法读取，请检查文件权限。' : '世界书版本缺失或损坏，请重新选择版本或关闭世界书。'; }
  }
  const view: EffectiveWorldbook = { source, state, entryCount: 0, enabledEntryCount: 0,
    ...(source.kind === 'artifact' ? { revision: source.ref.revision } : {}), ...(error ? { error } : {}) };
  if (book) Object.assign(view, summarizeWorldbook(book), book.name ? { name: book.name } : {});
  if (name) view.name = name;
  const guard = createHash('sha256').update(JSON.stringify({ source, state: view.state, book })).digest('hex');
  return { view, ...(book ? { book } : {}), guard };
}
