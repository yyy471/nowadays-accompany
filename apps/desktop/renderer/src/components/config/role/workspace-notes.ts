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
