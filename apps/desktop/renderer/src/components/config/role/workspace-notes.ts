/** 角色工作空间 Markdown 笔记的展示纯逻辑；不发请求、不碰 DOM。 */

export interface WorkspaceNoteSummary {
  relativePath: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface WorkspaceNoteDetail extends WorkspaceNoteSummary {
  content: string;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export function formatNoteBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < BYTE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

export function formatNoteTimestamp(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  return new Date(time).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
}

/** 保留仍存在的选择；角色切换后旧路径失效时退回列表第一条。 */
export function pickSelectedNotePath(items: WorkspaceNoteSummary[], previous: string): string {
  if (items.length === 0) return '';
  if (previous && items.some(item => item.relativePath === previous)) return previous;
  return items[0].relativePath;
}

/** 详情请求的身份：角色、路径和刷新轮次任一变化都必须视为新的请求。 */
export interface NoteDetailRequest {
  roleId: string;
  path: string;
  revision: number;
}

export type NoteDetailState =
  | { phase: 'loading'; request: NoteDetailRequest }
  | { phase: 'ready'; request: NoteDetailRequest; note: WorkspaceNoteDetail }
  | { phase: 'error'; request: NoteDetailRequest; error: string };

export type NoteListFeedback =
  | { kind: 'loading'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'scan-empty'; message: string }
  | { kind: 'truncated'; message: string }
  | { kind: 'list' };

export type NotePreviewView =
  | { kind: 'placeholder' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'content'; note: WorkspaceNoteDetail };

/** 扫描预算耗尽时列表可能为空：此时只提示范围，不叠加“还没有笔记”。 */
export function noteListFeedback(loading: boolean, count: number, truncated: boolean): NoteListFeedback {
  if (loading && count === 0) return { kind: 'loading', message: '正在读取工作空间笔记…' };
  if (count === 0) {
    return truncated
      ? { kind: 'scan-empty', message: '当前扫描范围内未找到 Markdown 笔记。' }
      : { kind: 'empty', message: '工作空间里还没有 Markdown 笔记。' };
  }
  if (truncated) {
    return { kind: 'truncated', message: `工作空间目录较大，仅展示前 ${count} 篇笔记（已跳过 node_modules 等依赖目录）。` };
  }
  return { kind: 'list' };
}

/**
 * 只渲染与当前角色、路径和刷新轮次完全一致的详情响应。
 * 身份不匹配时立即视为加载中，不等 useEffect 清空旧正文。
 */
export function notePreviewView(request: NoteDetailRequest | null, state: NoteDetailState | null): NotePreviewView {
  if (!request) return { kind: 'placeholder' };
  if (!state
    || state.request.roleId !== request.roleId
    || state.request.path !== request.path
    || state.request.revision !== request.revision) {
    return { kind: 'loading' };
  }
  if (state.phase === 'error') return { kind: 'error', message: state.error };
  if (state.phase === 'ready') return { kind: 'content', note: state.note };
  return { kind: 'loading' };
}
