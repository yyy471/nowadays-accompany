import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../../api';
import { Button, Field, Input, Select, Switch, Textarea } from '../../../ui';
import type { ConfigDraftState } from '../../config-draft';
import { MediaGroup, MediaStateRow, RoleSaveActions, SheetHost } from '../MediaSheet';
import { ServiceRow } from '../ServiceParts';
import { useSheet } from '../sheet/sheet-context';

type Entry = {
  id: string; title: string; keywords: string[]; content: string; enabled: boolean;
  visibility: 'known' | 'author_only';
};
type Book = { id: string; name: string; enabled: boolean; entries: Entry[] };
type Collection = { revision: number; books: Book[] };
type Props = {
  roleId: string; active: boolean; pausedWrite: boolean;
  guardWrite: <T,>(action: () => Promise<T>, verb: string) => Promise<T>;
  onDraftChange: (state: ConfigDraftState) => void;
};

function validate(books: Book[]) {
  for (const [bookIndex, book] of books.entries()) {
    if (!book.name.trim()) return `请填写第 ${bookIndex + 1} 本世界书的名称。`;
    for (const [entryIndex, entry] of book.entries.entries()) {
      const location = `《${book.name}》的第 ${entryIndex + 1} 条`;
      if (!entry.title.trim() || !entry.content.trim()) return `${location}需要标题和正文。`;
      const keys = entry.keywords.map(key => key.trim()).filter(Boolean);
      if (!keys.length || keys.length > 16 || keys.some(key => key.length > 64))
        return `${location}需要 1 至 16 个关键词，每个最多 64 个字符。`;
    }
  }
  return '';
}

export function WorldbooksPanel({ roleId, active, pausedWrite, guardWrite, onDraftChange }: Props) {
  const sheet = useSheet();
  const [saved, setSaved] = useState<Collection | null>(null);
  const [draft, setDraft] = useState<Book[]>([]);
  const [bookId, selectBook] = useState('');
  const [entryId, selectEntry] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const path = `/v1/roles/${encodeURIComponent(roleId)}/worldbooks`;
  const book = draft.find(item => item.id === bookId) ?? draft[0];
  const entry = book?.entries.find(item => item.id === entryId) ?? book?.entries[0];

  useEffect(() => {
    if (!active) return;
    const request = new AbortController();
    setSaved(null);
    setReadError('');
    api<Collection>(path, { signal: request.signal }).then(result => {
      if (request.signal.aborted) return;
      setSaved(result);
      setDraft(result.books);
      setConflict(false);
      setWriteError('');
    }).catch(error => { if (!request.signal.aborted) setReadError(String(error.message || error)); });
    return () => request.abort();
  }, [active, path, readAttempt]);

  const discard = useCallback(() => {
    setDraft(saved?.books ?? []);
    setWriteError('');
    setConflict(false);
    if (conflict) setReadAttempt(attempt => attempt + 1);
  }, [saved, conflict]);
  const count = useMemo(() => {
    if (!saved || saved.books === draft) return 0;
    const previous = new Map(saved.books.map(item => [item.id, item]));
    let changed = 0;
    for (const item of draft) {
      const old = previous.get(item.id);
      if (!old || (old !== item && JSON.stringify(old) !== JSON.stringify(item))) changed++;
      previous.delete(item.id);
    }
    return changed + previous.size;
  }, [draft, saved]);
  useEffect(() => { onDraftChange({ dirty: count > 0, count, busy, discard }); }, [count, busy, discard, onDraftChange]);
  const invalid = useMemo(() => validate(draft), [draft]);
  const editBook = (update: Partial<Book>) => {
    setDraft(books => books.map(item => item.id === book.id ? { ...item, ...update } : item));
    setWriteError('');
  };
  const editEntry = (update: Partial<Entry>) =>
    editBook({ entries: book.entries.map(item => item.id === entry.id ? { ...item, ...update } : item) });
  const addBook = () => {
    const id = crypto.randomUUID();
    setDraft(books => [...books, { id, name: '', enabled: true, entries: [] }]);
    selectBook(id);
    setWriteError('');
  };
  const addEntry = () => {
    const id = crypto.randomUUID();
    editBook({ entries: [...book.entries, { id, title: '', keywords: [], content: '', enabled: true, visibility: 'known' }] });
    selectEntry(id);
  };
  const save = async () => {
    if (!saved || !count || invalid || conflict || saving.current) return;
    saving.current = true;
    setBusy(true);
    setWriteError('');
    try {
      const books = draft.map(item => ({ ...item, name: item.name.trim(), entries: item.entries.map(row => ({
        ...row, title: row.title.trim(), content: row.content.trim(),
        keywords: [...new Set(row.keywords.map(key => key.trim()).filter(Boolean))],
      })) }));
      const result = await guardWrite(async () => {
        try {
          return await api<Collection>(path, { method: 'PUT', body: { expectedRevision: saved.revision, books } });
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'WORLDBOOK_REVISION_CONFLICT') throw error;
          setConflict(true);
          throw new Error('其他窗口已修改世界书，请复制需要保留的草稿，再读取最新版本。');
        }
      }, '保存世界书');
      setSaved(result);
      setDraft(result.books);
      sheet.closeNow();
    } catch (error) { setWriteError(error instanceof Error ? error.message : String(error)); }
    finally { saving.current = false; setBusy(false); }
  };

  if (!active) return null;
  if (!saved) return <MediaStateRow label="世界书" loading={!readError} error={readError} onRetry={() => setReadAttempt(attempt => attempt + 1)}/>;
  const enabledCount = saved.books.filter(item => item.enabled).length;
  return <>
    <ServiceRow label="世界书" value={saved.books.length ? `已启用 ${enabledCount} / ${saved.books.length} 本` : '尚未添加'}
      keys={['当前角色专用，按关键词引用设定']} status={count ? 'dirty' : enabledCount ? 'ok' : 'none'}
      statusText={count ? '有改动未保存' : enabledCount ? '已启用' : '未启用'}
      onOpen={anchor => sheet.open({ id: 'worldbooks', title: '编辑世界书', shape: 'full', anchor: anchor.closest<HTMLElement>('.config-sum'), focusReturn: anchor.matches('button') ? anchor : anchor.querySelector('button') })}/>
    <SheetHost id="worldbooks" active={active} state={{ dirty: count > 0, count, busy, discard }}
      footer={<RoleSaveActions count={count} pause={pausedWrite} busy={busy} invalid={!!invalid || conflict} error={writeError} onSave={() => void save()}/>}>
      {() => <>
        <MediaGroup title="世界书">
          {draft.length > 0 && <Field label="选择世界书"><Select value={book.id} onChange={event => selectBook(event.target.value)} disabled={busy}>
            {draft.map((item, index) => <option key={item.id} value={item.id}>{item.name || `未命名世界书 ${index + 1}`}</option>)}
          </Select></Field>}
          <div className="config-actions">
            <Button size="sm" disabled={busy || draft.length >= 16} onClick={addBook}>添加世界书</Button>
            {book && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(books => books.filter(item => item.id !== book.id)); setWriteError(''); }}>移除这本书</Button>}
          </div>
          {book && <>
            <Field label="书名"><Input value={book.name} maxLength={80} disabled={busy} onChange={event => editBook({ name: event.target.value })}/></Field>
            <Switch label="启用整本世界书" checked={book.enabled} disabled={busy} onCheckedChange={enabled => editBook({ enabled })}/>
          </>}
        </MediaGroup>
        {book && <MediaGroup title="设定条目">
          {book.entries.length > 0 && <Field label="选择条目"><Select value={entry.id} onChange={event => selectEntry(event.target.value)} disabled={busy}>
            {book.entries.map((item, index) => <option key={item.id} value={item.id}>{item.title || `未命名条目 ${index + 1}`}</option>)}
          </Select></Field>}
          <div className="config-actions">
            <Button size="sm" disabled={busy || book.entries.length >= 64} onClick={addEntry}>添加条目</Button>
            {entry && <Button size="sm" variant="ghost" disabled={busy} onClick={() => editBook({ entries: book.entries.filter(item => item.id !== entry.id) })}>移除条目</Button>}
          </div>
          {entry && <>
            <Field label="条目标题"><Input value={entry.title} maxLength={80} disabled={busy} onChange={event => editEntry({ title: event.target.value })}/></Field>
            <Field label="关键词" hint="每行一个，提及其中任意一个就可能引用此条。"><Textarea rows={3} value={entry.keywords.join('\n')} disabled={busy} onChange={event => editEntry({ keywords: event.target.value.split('\n') })}/></Field>
            <Field label="设定正文"><Textarea rows={5} maxLength={1800} value={entry.content} disabled={busy} onChange={event => editEntry({ content: event.target.value })}/></Field>
            <Field label="角色知情范围"><Select value={entry.visibility} disabled={busy} onChange={event => editEntry({ visibility: event.target.value as Entry['visibility'] })}>
              <option value="known">角色知道</option><option value="author_only">仅作者可见</option>
            </Select></Field>
            <Switch label="启用此条目" disabled={busy} checked={entry.enabled} onCheckedChange={enabled => editEntry({ enabled })}/>
          </>}
        </MediaGroup>}
        {count > 0 && invalid && <p role="status" className="config-inline-hint">{invalid}</p>}
        {conflict && <Button size="sm" disabled={busy} onClick={() => sheet.requestClose()}>读取最新版本</Button>}
      </>}
    </SheetHost>
  </>;
}
