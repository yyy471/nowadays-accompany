import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { errorText } from '../../../lib/error-text';
import { Button, Disclosure } from '../../../ui';
import {
  formatNoteBytes,
  formatNoteTimestamp,
  pickSelectedNotePath,
  type WorkspaceNoteDetail,
  type WorkspaceNoteSummary
} from './workspace-notes';
import '../../../styles/role-transfer-workspace.css';

type Props = { roleId: string; active: boolean };

/** 角色工作空间内的 Markdown 笔记：默认折叠，展开且分区可见时按需读取。 */
export function WorkspaceNotesPanel({ roleId, active }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WorkspaceNoteSummary[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<{ roleId: string; path: string } | null>(null);
  // 选中路径与角色绑定：角色切换的同一帧里不会拿旧路径去请求新角色。
  const selectedPath = selected?.roleId === roleId ? selected.path : '';
  const [note, setNote] = useState<WorkspaceNoteDetail | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [noteLoading, setNoteLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [noteError, setNoteError] = useState('');
  const [revision, setRevision] = useState(0);
  const [directoryNotice, setDirectoryNotice] = useState('');

  // 角色切换时清空旧选择，避免把上一个角色的笔记带到新角色。
  useEffect(() => {
    setItems([]);
    setTruncated(false);
    setSelected(null);
    setNote(null);
    setListError('');
    setNoteError('');
    setDirectoryNotice('');
  }, [roleId]);

  useEffect(() => {
    if (!open || !active) return;
    const request = new AbortController();
    setListLoading(true);
    setListError('');
    api<{ items: WorkspaceNoteSummary[]; truncated?: boolean }>(`/v1/roles/${encodeURIComponent(roleId)}/workspace/notes`, { signal: request.signal })
      .then(result => {
        if (request.signal.aborted) return;
        setItems(result.items);
        setTruncated(result.truncated === true);
        setSelected(previous => {
          const kept = previous?.roleId === roleId ? previous.path : '';
          const path = pickSelectedNotePath(result.items, kept);
          return path ? { roleId, path } : null;
        });
      })
      .catch(error => { if (!request.signal.aborted) setListError(errorText(error)); })
      .finally(() => { if (!request.signal.aborted) setListLoading(false); });
    return () => request.abort();
  }, [open, active, roleId, revision]);

  useEffect(() => {
    if (!open || !active || !selectedPath) { setNote(null); return; }
    const request = new AbortController();
    setNoteLoading(true);
    setNoteError('');
    api<{ note: WorkspaceNoteDetail }>(
      `/v1/roles/${encodeURIComponent(roleId)}/workspace/note?path=${encodeURIComponent(selectedPath)}`,
      { signal: request.signal }
    )
      .then(result => { if (!request.signal.aborted) setNote(result.note); })
      .catch(error => { if (!request.signal.aborted) setNoteError(errorText(error)); })
      .finally(() => { if (!request.signal.aborted) setNoteLoading(false); });
    return () => request.abort();
  }, [open, active, roleId, selectedPath, revision]);

  const openDirectory = async () => {
    const opener = window.nowadaysDesk?.openRoleWorkspace;
    if (!opener) return;
    setDirectoryNotice('正在打开目录…');
    try {
      const result = await opener(roleId);
      setDirectoryNotice(result.ok ? '已在资源管理器中打开工作空间。' : result.message);
    } catch {
      setDirectoryNotice('无法打开角色工作空间目录。');
    }
  };

  return <Disclosure title="书案笔记（工作空间）" open={open} onOpenChange={setOpen}>
    <div className="workspace-notes">
      <div className="workspace-notes-tools">
        <Button size="sm" variant="ghost" icon="refresh" busy={listLoading} disabled={!active} onClick={() => setRevision(value => value + 1)}>刷新</Button>
        {window.nowadaysDesk?.openRoleWorkspace && <Button size="sm" variant="ghost" icon="folder" onClick={() => void openDirectory()}>在资源管理器中打开目录</Button>}
        {directoryNotice && <p className="workspace-notes-notice" role="status">{directoryNotice}</p>}
      </div>
      {listError && <p className="workspace-notes-error" role="alert">{listError}</p>}
      {!listError && listLoading && !items.length && <p className="workspace-notes-notice" role="status">正在读取工作空间笔记…</p>}
      {!listError && !listLoading && items.length === 0 && <p className="workspace-notes-empty">工作空间里还没有 Markdown 笔记。</p>}
      {!listError && truncated && <p className="workspace-notes-notice" role="status">工作空间目录较大，仅展示前 {items.length} 篇笔记（已跳过 node_modules 等依赖目录）。</p>}
      {items.length > 0 && <div className="workspace-notes-layout">
        <ul className="workspace-notes-list" aria-label="工作空间笔记">
          {items.map(item => <li key={item.relativePath}>
            <button type="button" className="workspace-notes-item" aria-current={selectedPath === item.relativePath ? 'true' : undefined}
              title={item.relativePath} onClick={() => setSelected({ roleId, path: item.relativePath })}>
              <strong>{item.name}</strong>
              <small>{item.relativePath}</small>
              <span>{formatNoteBytes(item.sizeBytes)} · {formatNoteTimestamp(item.updatedAt)}</span>
            </button>
          </li>)}
        </ul>
        <div className="workspace-notes-preview">
          {noteError ? <p className="workspace-notes-error" role="alert">{noteError}</p>
            : noteLoading && !note ? <p className="workspace-notes-notice" role="status">正在读取笔记…</p>
            : note ? <>
              <header className="workspace-notes-preview-head"><strong>{note.name}</strong><small>{note.relativePath}</small></header>
              <pre className="workspace-note-body">{note.content}</pre>
            </> : <p className="workspace-notes-notice">选择左侧笔记查看内容。</p>}
        </div>
      </div>}
    </div>
  </Disclosure>;
}
