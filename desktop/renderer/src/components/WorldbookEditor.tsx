import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import { Button, CancelButton, Checkbox, ConfirmButton, ControlButton, ErrorNote, Field, Input, Modal, Select, Tag, Textarea, useConfirm } from '../ui';
import { worldbookEvaluationView } from './WorldbookEvaluation';
import { useDraftProtection } from './DraftProtectionProvider';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { hashRevision } from '../lib/drafts/registry';
import {
  POSITIONS, POSITION_LABELS, cloneWorldbook, draftIsDirty, duplicateEntry,
  newEntry, parseKeys, requestId, revisionConflict, validateWorldbookDraft,
  type WorldbookDraft, type WorldbookEditorSeed
} from '../lib/worldbook-editor';
import type { WorldbookEvaluation } from '../../../../src/contracts/worldbook.js';
import type { WorldbookSaveResult } from '../../../../src/contracts/worldbook-resources.js';

export interface WorldbookEditorProps {
  seed: WorldbookEditorSeed;
  locked?: boolean;
  onClose: () => void;
  onSaved?: (result: WorldbookSaveResult) => void;
  onRefresh: () => Promise<void>;
}

export function WorldbookEditor({ seed, locked = false, onClose, onSaved, onRefresh }: WorldbookEditorProps) {
  const initial = useRef(seed);
  const [id, setId] = useState(seed.id);
  const [revision, setRevision] = useState(seed.revision);
  const [name, setName] = useState(seed.name);
  const [book, setBook] = useState(() => cloneWorldbook(seed.worldbook));
  const [baseline, setBaseline] = useState(() => ({ id: seed.id, revision: seed.revision, name: seed.name, worldbook: cloneWorldbook(seed.worldbook) }));
  const [base, setBase] = useState(seed.base);
  const [mode, setMode] = useState(seed.mode);
  const [isNew, setIsNew] = useState(seed.mode !== 'derive');
  const description = useRef(seed.description);
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [keyTexts, setKeyTexts] = useState<Record<number, string>>({});
  const [text, setText] = useState('');
  const [evaluation, setEvaluation] = useState<WorldbookEvaluation>();
  const [busy, setBusy] = useState<'save' | 'preview'>();
  const [error, setError] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  const active = useRef(false);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const pendingRequest = useRef<{ key: string; id: string } | undefined>(undefined);
  const confirm = useConfirm();
  const { requestTransition } = useDraftProtection();
  const registrationId = 'worldbook-editor';

  useEffect(() => {
    mounted.current = true;
    const instance = ++lifecycle.current;
    return () => {
      if (lifecycle.current === instance) mounted.current = false;
      lifecycle.current += 1;
      active.current = false;
    };
  }, []);

  const draft: WorldbookDraft = { id, revision, name, worldbook: book };
  const dirty = isNew || draftIsDirty(draft, baseline);
  const errors = validateWorldbookDraft(draft);
  if (dirty && revisionConflict(draft, base)) errors.revision = `新版本不能与基础版本 ${base!.revision} 相同；原版本不会被覆盖。`;
  const frozen = locked || Boolean(busy);
  const valid = Object.keys(errors).length === 0;
  const isCurrent = (instance = lifecycle.current): boolean => mounted.current && lifecycle.current === instance && !lockedRef.current;
  const canAct = (): boolean => isCurrent() && !active.current;
  const canEdit = (): boolean => canAct() && !busy;
  const currentEntry = book.entries[selected];
  const currentKeyText = keyTexts[selected] ?? currentEntry?.keys.join(', ') ?? '';
  const filtered = book.entries.map((entry, index) => ({ entry, index })).filter(({ entry }) =>
    (enabledFilter === 'all' || (enabledFilter === 'enabled') === entry.enabled)
    && (!query.trim() || entry.id.toLowerCase().includes(query.trim().toLowerCase()) || entry.keys.some(key => key.toLowerCase().includes(query.trim().toLowerCase()))));

  useDraftRegistration({
    id: registrationId, owner: 'page', label: `世界书编辑器 ${id || '（新书）'}`,
    dirty, busy: Boolean(busy), revision: hashRevision(draft),
    discard: () => { setBook(cloneWorldbook(baseline.worldbook)); setId(baseline.id); setRevision(baseline.revision); setName(baseline.name);
      setBase(seed.base); setKeyTexts({}); setEvaluation(undefined); setText(''); setError(undefined); setRefreshError(undefined); setNotice(undefined); }
  });

  const updateBook = (patch: Partial<typeof book>): void => {
    if (!canEdit()) return;
    setBook(value => ({ ...value, ...patch })); setError(undefined); setNotice(undefined); setEvaluation(undefined);
  };
  const updateEntry = (patch: Partial<(typeof book.entries)[number]>): void => {
    if (!canEdit() || !currentEntry) return;
    setBook(value => ({ ...value, entries: value.entries.map((entry, index) => index === selected ? { ...entry, ...patch } : entry) }));
    setError(undefined); setNotice(undefined); setEvaluation(undefined);
  };
  const addEntry = (): void => {
    if (!canEdit()) return;
    const entry = newEntry(book.entries.map(item => item.id));
    setBook(value => ({ ...value, entries: [...value.entries, entry] }));
    setSelected(book.entries.length); setKeyTexts({}); setError(undefined); setNotice(undefined); setEvaluation(undefined);
  };
  const copyEntry = (): void => {
    if (!canEdit() || !currentEntry) return;
    const entry = duplicateEntry(currentEntry, book.entries.map(item => item.id));
    setBook(value => ({ ...value, entries: [...value.entries, entry] }));
    setSelected(book.entries.length); setKeyTexts({}); setError(undefined); setNotice(undefined); setEvaluation(undefined);
  };
  const removeEntry = async (): Promise<void> => {
    if (!canEdit() || !currentEntry) return;
    const instance = lifecycle.current;
    if (!(await confirm({ title: '删除世界书条目', description: `删除条目「${currentEntry.id}」？保存新版本后才会写入资源；取消将保留当前草稿。`, confirmLabel: '删除', tone: 'danger' }))) return;
    if (!isCurrent(instance) || !canAct()) return;
    setBook(value => ({ ...value, entries: value.entries.filter((_, index) => index !== selected) }));
    setSelected(Math.max(0, Math.min(selected, book.entries.length - 2)));
    setKeyTexts({}); setEvaluation(undefined);
  };
  const setKeys = (raw: string): void => {
    if (!canEdit()) return;
    setKeyTexts(values => ({ ...values, [selected]: raw }));
    updateEntry({ keys: parseKeys(raw) });
  };

  const close = async (): Promise<void> => {
    if (!canAct()) return;
    const instance = lifecycle.current;
    const result = await requestTransition({ scope: { kind: 'ids', ids: [registrationId] }, actionLabel: '关闭世界书编辑器' });
    if (!isCurrent(instance)) return;
    if (result.ok) onClose();
    else if (result.message) setError(result.message);
  };

  const preview = async (): Promise<void> => {
    if (!canAct() || !text.trim()) return;
    if (!valid) { setError('请先修正世界书或条目错误，再进行草稿测试。'); return; }
    const instance = lifecycle.current;
    active.current = true; setBusy('preview'); setError(undefined); setEvaluation(undefined);
    try {
      const result = await api<{ evaluation: WorldbookEvaluation }>('/worldbooks/preview', {
        method: 'POST',
        body: JSON.stringify({ book, text, scanDepth: book.scanDepth, budgetChars: book.budgetChars })
      });
      if (isCurrent(instance)) setEvaluation(result.evaluation);
    } catch (cause) { if (isCurrent(instance)) setError(errorMessage(cause)); }
    finally { active.current = false; if (mounted.current && lifecycle.current === instance) setBusy(undefined); }
  };

  const save = async (): Promise<void> => {
    if (!canAct() || !valid || !dirty) return;
    const manifest = {
      id, kind: 'worldbook' as const, revision,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(description.current ? { description: description.current } : {}),
      worldbook: book
    };
    const basePayload = base ? { baseRef: { id: base.id, revision: base.revision }, expectedBaseFingerprint: base.fingerprint } : {};
    const key = JSON.stringify({ manifest, basePayload });
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, id: requestId() };
    const submitted = { requestId: pendingRequest.current.id, manifest, ...basePayload };
    const instance = lifecycle.current;
    active.current = true; setBusy('save'); setError(undefined); setRefreshError(undefined); setNotice(undefined);
    try {
      const result = await api<WorldbookSaveResult>('/worldbooks/revisions', { method: 'POST', body: JSON.stringify(submitted) });
      if (!isCurrent(instance)) return;
      const saved = cloneWorldbook(result.manifest.worldbook);
      setBook(saved); setId(result.manifest.id); setRevision(result.manifest.revision); setName(result.manifest.name ?? '');
      setBaseline({ id: result.manifest.id, revision: result.manifest.revision, name: result.manifest.name ?? '', worldbook: cloneWorldbook(saved) });
      setBase({ id: result.manifest.id, revision: result.manifest.revision, fingerprint: result.fingerprint });
      description.current = result.manifest.description;
      pendingRequest.current = undefined; setMode('derive'); setIsNew(false); setKeyTexts({}); setEvaluation(undefined);
      setNotice(`已保存为新版本 ${result.manifest.revision}；原版本未被覆盖，已有会话不会自动切换。`);
      onSaved?.(result);
      try { await onRefresh(); }
      catch (cause) { if (mounted.current && lifecycle.current === instance) setRefreshError(`版本已保存，但列表刷新失败：${errorMessage(cause)}。请稍后手动刷新，不要重复保存同一版本。`); }
    } catch (cause) { if (isCurrent(instance)) setError(errorMessage(cause)); }
    finally { active.current = false; if (mounted.current && lifecycle.current === instance) setBusy(undefined); }
  };

  const title = mode === 'create' ? '新建世界书' : mode === 'copy' ? '复制为新书' : mode === 'derive' ? `编辑 ${initial.current.id}` : '世界书编辑器';

  return (
    <Modal open title={title} description="保存会创建不可变的新版本，不覆盖原版本，也不会改变任何会话。填写中的内容只是草稿。" closeDisabled={frozen} onClose={() => void close()} className="worldbook-editor-modal">
      <div className="ui-modal-content worldbook-editor">
        {error ? <ErrorNote message={error} /> : null}
        {refreshError ? <ErrorNote message={refreshError} /> : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        {mode === 'derive' && base ? <p className="field-hint">基于 {base.id} @ {base.revision} 派生；新版本号不能与基础版本相同。保存后已有会话仍使用原版本，需在会话中明确切换。</p> : null}
        {mode === 'copy' ? <p className="field-hint">复制会创建一本独立的新书，可修改 id；不会复制原书的会话引用。</p> : null}
        {isNew ? <p className="field-hint">这是本地草稿，尚未保存。可先添加条目并做草稿测试。</p> : null}

        <div className="worldbook-book-grid">
          <Field label="世界书 id" hint="1–64 位字母、数字、点、下划线或短横线">
            <Input aria-label="世界书 id" value={id} disabled={frozen || mode === 'derive'} aria-invalid={Boolean(errors.id) || undefined} onChange={event => { if (!canEdit()) return; setId(event.target.value); setError(undefined); setNotice(undefined); }} />
          </Field>
          <Field label="新版本号" hint="保存时创建该版本；原版本保持不变">
            <Input aria-label="新版本号" value={revision} disabled={frozen} aria-invalid={Boolean(errors.revision) || undefined} onChange={event => { if (!canEdit()) return; setRevision(event.target.value); setError(undefined); setNotice(undefined); }} />
          </Field>
          <Field label="名称">
            <Input aria-label="名称" value={name} disabled={frozen} aria-invalid={Boolean(errors.name) || undefined} onChange={event => { if (!canEdit()) return; setName(event.target.value); setError(undefined); setNotice(undefined); }} />
          </Field>
          <Field label="扫描历史条数（0–20）">
            <Input type="number" min={0} max={20} step={1} value={book.scanDepth} disabled={frozen} aria-invalid={Boolean(errors.scanDepth) || undefined}
              onChange={event => updateBook({ scanDepth: Number(event.target.value) })} />
          </Field>
          <Field label="建议注入预算字符数（0–8000）">
            <Input type="number" min={0} max={8000} step={1} value={book.budgetChars} disabled={frozen} aria-invalid={Boolean(errors.budgetChars) || undefined}
              onChange={event => updateBook({ budgetChars: Number(event.target.value) })} />
          </Field>
        </div>
        {errors.id ? <p className="inline-error">{errors.id}</p> : null}
        {errors.revision ? <p className="inline-error">{errors.revision}</p> : null}
        {errors.name ? <p className="inline-error">{errors.name}</p> : null}
        {errors.scanDepth ? <p className="inline-error">{errors.scanDepth}</p> : null}
        {errors.budgetChars ? <p className="inline-error">{errors.budgetChars}</p> : null}

        <section className="worldbook-entries" aria-label="世界书条目">
          <div className="worldbook-entry-toolbar">
            <Input type="search" aria-label="搜索条目" placeholder="搜索 id 或关键词" value={query} disabled={frozen} onChange={event => { if (!canEdit()) return; setQuery(event.target.value); }} />
            <Select aria-label="按启用状态筛选" value={enabledFilter} disabled={frozen} onChange={event => { if (!canEdit()) return; setEnabledFilter(event.target.value as typeof enabledFilter); }}>
              <option value="all">全部条目</option>
              <option value="enabled">仅启用</option>
              <option value="disabled">仅停用</option>
            </Select>
            <Button size="sm" icon="plus" disabled={frozen} onClick={addEntry}>新增条目</Button>
          </div>
          <p className="field-hint">筛选只影响列表显示，切换条目不会丢弃草稿。当前 {book.entries.length} 条，显示 {filtered.length} 条。</p>
          {errors.entries ? <ErrorNote message={errors.entries} /> : null}
          <div className="worldbook-entry-layout">
            <div className="worldbook-entry-list" role="list">
              {filtered.length === 0 ? <p className="muted">{book.entries.length === 0 ? '还没有条目，请新增。' : '没有符合筛选条件的条目。'}</p> : filtered.map(({ entry, index }) => {
                const entryErrors = Object.keys(errors).filter(key => key.startsWith(`entry:${index}:`));
                return <ControlButton type="button" role="listitem" key={`${index}:${entry.id}`} className={`worldbook-entry-row${index === selected ? ' is-selected' : ''}`} disabled={frozen} onClick={() => { if (canEdit()) setSelected(index); }}>
                  <span className="mono">{entry.id || '（空 id）'}</span>
                  <span className="worldbook-entry-meta">
                    {entryErrors.length ? <Tag tone="bad">需修正</Tag> : null}
                    <Tag tone={entry.enabled ? 'ok' : 'idle'}>{entry.enabled ? '启用' : '停用'}</Tag>
                    <span className="muted">{entry.keys.length} 词</span>
                  </span>
                </ControlButton>;
              })}
            </div>
            <div className="worldbook-entry-form">
              {currentEntry ? <>
                <div className="worldbook-entry-actions">
                  <Button size="sm" icon="copy" disabled={frozen} onClick={copyEntry}>复制条目</Button>
                  <Button size="sm" variant="danger" icon="trash" disabled={frozen} onClick={() => void removeEntry()}>删除</Button>
                </div>
                <Field label="条目 id">
                  <Input aria-label="条目 id" value={currentEntry.id} disabled={frozen} aria-invalid={Boolean(errors[`entry:${selected}:id`]) || undefined} onChange={event => updateEntry({ id: event.target.value })} />
                </Field>
                {errors[`entry:${selected}:id`] ? <p className="inline-error">{errors[`entry:${selected}:id`]}</p> : null}
                <Field label="关键词" hint="用逗号或换行分隔；启用且非常驻的条目至少需要一个关键词">
                  <Textarea aria-label="条目关键词" value={currentKeyText} disabled={frozen} aria-invalid={Boolean(errors[`entry:${selected}:keys`]) || undefined} onChange={event => setKeys(event.target.value)} placeholder="例如：花园，银杏" />
                </Field>
                {errors[`entry:${selected}:keys`] ? <p className="inline-error">{errors[`entry:${selected}:keys`]}</p> : null}
                <Field label="正文">
                  <Textarea aria-label="条目正文" className="worldbook-content-input" value={currentEntry.content} disabled={frozen} aria-invalid={Boolean(errors[`entry:${selected}:content`]) || undefined} onChange={event => updateEntry({ content: event.target.value })} />
                </Field>
                {errors[`entry:${selected}:content`] ? <p className="inline-error">{errors[`entry:${selected}:content`]}</p> : null}
                <div className="worldbook-entry-options">
                  <label className="check-row"><Checkbox checked={currentEntry.enabled} disabled={frozen} onChange={event => updateEntry({ enabled: event.target.checked })} /><span>启用条目</span></label>
                  <label className="check-row"><Checkbox checked={currentEntry.constant} disabled={frozen} onChange={event => updateEntry({ constant: event.target.checked })} /><span>常驻（无需关键词）</span></label>
                  <label className="check-row"><Checkbox checked={currentEntry.caseSensitive} disabled={frozen} onChange={event => updateEntry({ caseSensitive: event.target.checked })} /><span>区分大小写</span></label>
                </div>
                <div className="worldbook-book-grid">
                  <Field label="优先级（-1000 至 1000）" hint="数值越大越先考虑；预算不足时先跳过后续条目">
                    <Input type="number" min={-1000} max={1000} step={1} value={currentEntry.priority} disabled={frozen} aria-invalid={Boolean(errors[`entry:${selected}:priority`]) || undefined}
                      onChange={event => updateEntry({ priority: Number(event.target.value) })} />
                  </Field>
                  <Field label="插入位置">
                    <Select value={currentEntry.position} disabled={frozen} onChange={event => updateEntry({ position: event.target.value as typeof currentEntry.position })}>
                      {POSITIONS.map(position => <option key={position} value={position}>{POSITION_LABELS[position]}</option>)}
                    </Select>
                  </Field>
                </div>
                {errors[`entry:${selected}:priority`] ? <p className="inline-error">{errors[`entry:${selected}:priority`]}</p> : null}
              </> : <p className="muted">选择或新增一个条目后编辑。</p>}
            </div>
          </div>
        </section>

        <section className="worldbook-preview" aria-label="草稿测试">
          <h3>草稿测试（尚未保存）</h3>
          <Field label="测试文本" hint="最多 16000 字符；只检查这段文本，不读取真实历史、不调用模型、不写记忆。">
            <Textarea aria-label="草稿测试文本" value={text} disabled={frozen} maxLength={16000} onChange={event => { if (!canEdit()) return; setText(event.target.value); setEvaluation(undefined); }} />
          </Field>
          <Button size="sm" icon="search" disabled={frozen || !text.trim()} busy={busy === 'preview'} onClick={() => void preview()}>测试当前草稿</Button>
          {evaluation ? worldbookEvaluationView(evaluation, '草稿测试，尚未保存') : null}
        </section>

        <div className="form-submit worldbook-savebar">
          <CancelButton disabled={frozen} onClick={() => void close()}>关闭</CancelButton>
          <ConfirmButton disabled={frozen || !valid || !dirty} busy={busy === 'save'} onClick={() => void save()}>保存新版本</ConfirmButton>
        </div>
        {!valid ? <p className="field-hint">请修正上方标出的错误后再保存；草稿测试同样要求结构合法。</p> : null}
        {isNew ? <p className="field-hint">提示：空书可以直接保存；禁用条目可保存，但启用且非常驻的条目必须填写关键词。</p> : null}
      </div>
    </Modal>
  );
}
