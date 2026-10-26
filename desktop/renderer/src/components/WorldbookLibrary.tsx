import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type { WorldbookList, WorldbookResourceDetail, WorldbookSummary } from '../../../../src/contracts/worldbook-resources.js';
import { Button, Card, Empty, ErrorNote, LoadingNote, Modal, Tag } from '../ui';
import { WorldbookEditor } from './WorldbookEditor';
import { blankWorldbook, cloneWorldbook, copyBookId, nextRevision, type WorldbookEditorSeed } from '../lib/worldbook-editor';

const PAGE_SIZE = 50;

interface Group {
  id: string;
  name: string;
  versions: WorldbookSummary[];
}

function groupSummaries(items: WorldbookSummary[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const group = groups.get(item.id) ?? { id: item.id, name: item.name ?? item.id, versions: [] };
    group.versions.push(item);
    if (item.name) group.name = item.name;
    groups.set(item.id, group);
  }
  for (const group of groups.values()) {
    group.versions.sort((left, right) => right.revision.localeCompare(left.revision, undefined, { numeric: true }));
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Bounded version summaries stay body-free; a version body is fetched only when selected. */
export function WorldbookLibrary({ locked = false, reloadKey = 0 }: { locked?: boolean; reloadKey?: number }) {
  const mounted = useRef(true);
  const sequence = useRef(0);
  const nextRef = useRef<number | undefined>(undefined);
  const [items, setItems] = useState<WorldbookSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [detailBusy, setDetailBusy] = useState<string>();
  const [detailTarget, setDetailTarget] = useState<{ id: string; revision: string }>();
  const [detailError, setDetailError] = useState<string>();
  const [detail, setDetail] = useState<(WorldbookResourceDetail & { id: string; revision: string })>();
  const [editor, setEditor] = useState<WorldbookEditorSeed>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async (reset: boolean): Promise<void> => {
    const offset: number | undefined = reset ? 0 : nextRef.current;
    if (!reset && offset === undefined) return;
    if (!reset) setMoreBusy(true);
    else setLoading(true);
    setError(undefined);
    const ticket = ++sequence.current;
    try {
      const result = await api<WorldbookList>(`/worldbooks?limit=${PAGE_SIZE}${reset ? '' : `&offset=${offset}`}`);
      if (!mounted.current || ticket !== sequence.current) return;
      setItems(current => {
        const merged = reset ? result.items : [...current, ...result.items];
        const unique = new Map(merged.map(item => [`${item.id}\u0000${item.revision}`, item]));
        return [...unique.values()];
      });
      nextRef.current = result.nextOffset;
      setNextOffset(result.nextOffset);
    } catch (cause) {
      if (mounted.current && ticket === sequence.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current && ticket === sequence.current) { setLoading(false); setMoreBusy(false); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(true);
    return () => { mounted.current = false; sequence.current += 1; };
  }, [load, reloadKey]);

  const openVersion = async (id: string, revision: string): Promise<void> => {
    if (locked) return;
    setDetailTarget({ id, revision });
    setDetailBusy(`${id}@${revision}`); setDetailError(undefined); setDetail(undefined);
    try {
      const result = await api<WorldbookResourceDetail>(`/worldbooks/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}`);
      if (!mounted.current) return;
      setDetail({ ...result, id, revision });
    } catch (cause) {
      if (mounted.current) setDetailError(errorMessage(cause));
    } finally {
      if (mounted.current) setDetailBusy(undefined);
    }
  };

  const startCreate = (): void => {
    if (locked) return;
    setNotice(undefined);
    setEditor({ mode: 'create', id: '', revision: 'r1', name: '', worldbook: blankWorldbook() });
  };
  const startEdit = (value: WorldbookResourceDetail & { id: string; revision: string }, mode: 'derive' | 'copy'): void => {
    const versions = items.filter(item => item.id === value.id).map(item => item.revision);
    const name = value.manifest.name ?? '';
    setDetail(undefined);
    setEditor(mode === 'derive'
      ? { mode, id: value.id, revision: nextRevision(versions), name, ...(value.manifest.description ? { description: value.manifest.description } : {}),
        worldbook: cloneWorldbook(value.manifest.worldbook), base: { id: value.id, revision: value.revision, fingerprint: value.fingerprint } }
      : { mode, id: copyBookId(value.id, items.map(item => item.id)), revision: 'r1', name: `${name || value.id} 副本`,
        ...(value.manifest.description ? { description: value.manifest.description } : {}), worldbook: cloneWorldbook(value.manifest.worldbook) });
  };

  const groups = groupSummaries(items);

  return <>
    {error ? <ErrorNote message={`无法读取世界书列表：${error}`} onRetry={() => void load(true)} /> : null}
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    <Card title="独立世界书" subtitle="列表只含版本摘要；选择版本后才读取正文。保存会创建新版本，不覆盖原版本。"
      actions={<Button size="sm" icon="plus" disabled={locked} onClick={startCreate}>新建世界书</Button>}>
      {loading && items.length === 0 ? <LoadingNote label="正在读取世界书…" /> : groups.length === 0 ? (
        <Empty icon="package" title="还没有独立世界书"
          description={<>可新建世界书，或用上方的“导入世界书 JSON”选择文件。导入后不会自动启用，也不会改动任何会话。</>}
          action={<Button icon="refresh" onClick={() => void load(true)}>重新扫描</Button>} />
      ) : (
        <div className="artifact-grid">
          {groups.map(group => <Card key={group.id} className="artifact-card">
            <div className="artifact-head">
              <div>
                <div className="artifact-kind-row"><Tag tone="idle">世界书</Tag><span className="mono">{group.id}</span></div>
                <h3>{group.name}</h3>
              </div>
              <div className="artifact-current"><span className="meta-label">版本</span><span className="mono">{group.versions.length}</span></div>
            </div>
            <div className="revision-list">
              {group.versions.map(version => {
                const busyKey = `${version.id}@${version.revision}`;
                return <div className="revision-row" key={version.revision}>
                  <div className="revision-name">
                    <span className="mono">{version.revision}</span>
                    <span className="muted">{version.entryCount} 条 · 启用 {version.enabledEntryCount}</span>
                    <span className="muted mono" title={version.fingerprint}>{version.fingerprint.slice(0, 10)}</span>
                  </div>
                  <div className="revision-actions">
                    <Button size="sm" variant="ghost" busy={detailBusy === busyKey} disabled={locked || Boolean(detailBusy)} onClick={() => void openVersion(version.id, version.revision)}>查看版本</Button>
                  </div>
                </div>;
              })}
            </div>
          </Card>)}
        </div>
      )}
      {nextOffset !== undefined ? <div className="form-submit">
        <Button size="sm" variant="ghost" icon="refresh" busy={moreBusy} disabled={locked || moreBusy} onClick={() => void load(false)}>加载更多版本</Button>
      </div> : null}
      {!loading && items.length > 0 ? <p className="field-hint">已加载 {items.length} 个版本；完整正文只在“查看版本”时读取。</p> : null}
    </Card>

    <Modal open={Boolean(detailBusy) || Boolean(detail) || Boolean(detailError)} title={detail ? `${detail.manifest.name ?? detail.id} · ${detail.revision}` : detailBusy ? '读取世界书版本' : '世界书版本读取失败'}
      closeDisabled={Boolean(detailBusy)} onClose={() => { if (!detailBusy) { setDetail(undefined); setDetailError(undefined); } }} className="worldbook-detail-modal">
      <div className="ui-modal-content">
        {detailBusy ? <LoadingNote label="正在读取指定版本正文…" /> : null}
        {detailError ? <ErrorNote message={detailError} onRetry={detailTarget ? () => void openVersion(detailTarget.id, detailTarget.revision) : undefined} /> : null}
        {detailError ? <p className="field-hint">列表和其他版本未被清空。请关闭后重试，或选择其他版本。</p> : null}
        {detail ? <>
          <dl className="detail-list">
            <div><dt>id</dt><dd className="mono">{detail.id}</dd></div>
            <div><dt>版本</dt><dd className="mono">{detail.revision}</dd></div>
            {detail.manifest.name ? <div><dt>名称</dt><dd>{detail.manifest.name}</dd></div> : null}
            {detail.manifest.description ? <div><dt>说明</dt><dd>{detail.manifest.description}</dd></div> : null}
            <div><dt>指纹</dt><dd className="mono">{detail.fingerprint}</dd></div>
            <div><dt>基础版本</dt><dd className="mono">{detail.baseRef ? `${detail.baseRef.id}@${detail.baseRef.revision}` : '无（全新书）'}</dd></div>
            <div><dt>建议参数</dt><dd>扫描 {detail.manifest.worldbook.scanDepth} 条 · 预算 {detail.manifest.worldbook.budgetChars} 字符</dd></div>
          </dl>
          <p className="field-hint">只读取该固定版本；此处查看不会启用、部署或改变任何会话。</p>
          <div className="worldbook-detail-entries">
            {detail.manifest.worldbook.entries.length === 0 ? <p className="muted">该书没有条目。</p> : detail.manifest.worldbook.entries.map(entry => <div className="worldbook-detail-entry" key={entry.id}>
              <div><span className="mono">{entry.id}</span> <Tag tone={entry.enabled ? 'ok' : 'idle'}>{entry.enabled ? '启用' : '停用'}</Tag>{entry.constant ? <Tag tone="idle">常驻</Tag> : null}</div>
              <div className="muted">关键词：{entry.keys.join('、') || '无'} · 位置：{entry.position === 'before-role' ? '角色前' : '角色后'} · 优先级：{entry.priority}</div>
              <p className="worldbook-detail-content">{entry.content.length > 240 ? `${entry.content.slice(0, 240)}…` : entry.content}</p>
            </div>)}
          </div>
          <div className="form-submit">
            <Button variant="ghost" disabled={locked} onClick={() => setDetail(undefined)}>关闭</Button>
            <Button disabled={locked} onClick={() => startEdit(detail, 'copy')}>复制为新书</Button>
            <Button variant="primary" disabled={locked} onClick={() => startEdit(detail, 'derive')}>从此版本编辑</Button>
          </div>
        </> : null}
      </div>
    </Modal>

    {editor ? <WorldbookEditor key={`${editor.mode}:${editor.id}:${editor.revision}:${editor.base?.revision ?? 'new'}`} seed={editor} locked={locked}
      onClose={() => setEditor(undefined)}
      onSaved={result => { setNotice(`已保存 ${result.manifest.id} @ ${result.manifest.revision}；已有会话仍使用原版本，需明确切换。`); }}
      onRefresh={() => load(true)} /> : null}
  </>;
}
