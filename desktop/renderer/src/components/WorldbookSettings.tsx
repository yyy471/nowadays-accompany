import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import { Button, CancelButton, Checkbox, ConfirmButton, ErrorNote, Field, Input, Modal, Select, Tag, Textarea } from '../ui';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { hashRevision } from '../lib/drafts/registry';
import { useDraftProtection } from './DraftProtectionProvider';
import { worldbookEvaluationView } from './WorldbookEvaluation';
import type { ConversationWorldbookSource, EffectiveWorldbook, WorldbookEvaluation as Evaluation, WorldbookOptions } from '../../../../src/contracts/worldbook.js';
import type { WorldbookList, WorldbookResourceDetail, WorldbookSummary } from '../../../../src/contracts/worldbook-resources.js';
export type { WorldbookOptions } from '../../../../src/contracts/worldbook.js';

export interface WorldbookBinding {
  accountId: string; kind: 'private' | 'group'; peerId: string; revision: string;
  worldbook?: WorldbookOptions; worldbookEntryCount?: number;
  worldbookDefaults?: { scanDepth: number; budgetChars: number };
  worldbookSource?: ConversationWorldbookSource;
  effectiveWorldbook?: EffectiveWorldbook;
}
const defaults = (): WorldbookOptions => ({ enabled: false, scanDepth: 4, budgetChars: 2000 });
const optionsFor = (binding: WorldbookBinding): WorldbookOptions => binding.worldbook ?? { ...defaults(), ...((binding.worldbookEntryCount ?? 0) > 0 ? binding.worldbookDefaults : undefined) };
const sourceFor = (binding: WorldbookBinding): ConversationWorldbookSource => binding.worldbookSource ?? { kind: 'role-card' };
const identityFor = (binding: WorldbookBinding): string => `${binding.accountId}/${binding.kind}/${binding.peerId}`;
const STATE_LABELS: Record<EffectiveWorldbook['state'], string> = { ready: '可用', empty: '没有启用条目', missing: '缺失', invalid: '损坏或无法解析' };

export function WorldbookSettings({ binding, onSaved, onReload, disabled = false, locked = false, visible = true }: {
  binding: WorldbookBinding; onSaved: (binding: WorldbookBinding) => void; onReload?: () => void; disabled?: boolean; locked?: boolean; visible?: boolean;
}) {
  const identity = identityFor(binding);
  const registrationId = `worldbook:${identity}`;
  const { requestTransition } = useDraftProtection();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(binding);
  const [draft, setDraft] = useState<WorldbookOptions>(() => optionsFor(binding));
  const [source, setSource] = useState<ConversationWorldbookSource>(() => sourceFor(binding));
  const [versions, setVersions] = useState<WorldbookSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsMoreBusy, setVersionsMoreBusy] = useState(false);
  const [versionsNextOffset, setVersionsNextOffset] = useState<number>();
  const [versionsError, setVersionsError] = useState<string>();
  const [detail, setDetail] = useState<WorldbookResourceDetail>();
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [text, setText] = useState('');
  const [evaluation, setEvaluation] = useState<Evaluation>();
  const [busy, setBusy] = useState<'save' | 'preview'>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  const active = useRef(false);
  const current = useRef({ identity, locked, disabled, visible });
  current.current = { identity, locked, disabled, visible };
  const detailSequence = useRef(0);
  const detailRequest = useRef<{ ticket: number; identity: string } | null>(null);
  const detailReload = useRef<{ identity: string } | null>(null);
  const versionsSequence = useRef(0);
  const versionsNextRef = useRef<number | undefined>(undefined);
  const selectionSequence = useRef(0);
  const optionsDirty = JSON.stringify(draft) !== JSON.stringify(optionsFor(saved));
  const savedSource = sourceFor(saved);
  const sourceDirty = JSON.stringify(source) !== JSON.stringify(savedSource);
  const dirty = optionsDirty || sourceDirty || Boolean(text);
  const frozen = locked || disabled || Boolean(busy);
  const stale = binding.revision !== saved.revision;
  const valid = Number.isInteger(draft.scanDepth) && draft.scanDepth >= 0 && draft.scanDepth <= 20
    && Number.isInteger(draft.budgetChars) && draft.budgetChars >= 0 && draft.budgetChars <= 8000;
  const sourceValid = source.kind === 'role-card' || Boolean(source.ref.id && source.ref.revision);
  const detailMatches = source.kind === 'artifact' && detail?.manifest.id === source.ref.id && detail.manifest.revision === source.ref.revision;
  const sourceMatchesSaved = JSON.stringify(source) === JSON.stringify(savedSource);
  const knownEntryCount = detailMatches
    ? detail!.manifest.worldbook.entries.length
    : sourceMatchesSaved ? binding.worldbookEntryCount ?? 0 : undefined;
  const suggested = detailMatches
    ? { scanDepth: detail!.manifest.worldbook.scanDepth, budgetChars: detail!.manifest.worldbook.budgetChars }
    : sourceMatchesSaved ? binding.worldbookDefaults : undefined;
  const isCurrent = (): boolean => mounted.current && current.current.identity === identity;
  const canInteract = (): boolean => isCurrent() && current.current.visible && !current.current.locked && !current.current.disabled;
  const canAct = (): boolean => canInteract() && !active.current;
  const discard = (): void => {
    setDraft(optionsFor(binding)); setSaved(binding); setSource(sourceFor(binding)); setText(''); setEvaluation(undefined);
    setError(undefined); setNotice(undefined); setDetail(undefined); setVersionsError(undefined); setDetailError(undefined);
  };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; detailSequence.current += 1; selectionSequence.current += 1; detailRequest.current = null; detailReload.current = null; }; }, []);
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  useEffect(() => {
    if (!dirty && !active.current && binding.revision !== saved.revision) {
      setSaved(binding); setDraft(optionsFor(binding)); setSource(sourceFor(binding)); setEvaluation(undefined);
    }
  }, [binding, dirty, saved.revision]);
  useDraftRegistration({ id: registrationId, owner: 'page', accountId: binding.accountId,
    label: `账号 ${binding.accountId} 的${binding.kind === 'private' ? '私聊' : '群聊'} ${binding.peerId} 世界书`,
    dirty, busy: Boolean(busy), revision: hashRevision({ draft, source, text, revision: saved.revision }), discard });

  const loadVersions = async (more = false): Promise<WorldbookSummary[] | undefined> => {
    if (!isCurrent()) return;
    const offset = more ? versionsNextRef.current : 0;
    if (more && offset === undefined) return;
    const ticket = ++versionsSequence.current;
    if (more) setVersionsMoreBusy(true); else setVersionsLoading(true);
    setVersionsError(undefined);
    try {
      const result = await api<WorldbookList>(`/worldbooks?limit=100${more ? `&offset=${offset}` : ''}`);
      if (!isCurrent() || ticket !== versionsSequence.current) return;
      setVersions(existing => {
        const merged = more ? [...existing, ...result.items] : result.items;
        const unique = new Map(merged.map(item => [`${item.id}\u0000${item.revision}`, item]));
        return [...unique.values()];
      });
      versionsNextRef.current = result.nextOffset;
      setVersionsNextOffset(result.nextOffset);
      return result.items;
    } catch (cause) {
      if (isCurrent() && ticket === versionsSequence.current) setVersionsError(errorMessage(cause));
      return undefined;
    } finally {
      if (isCurrent() && ticket === versionsSequence.current) { setVersionsLoading(false); setVersionsMoreBusy(false); }
    }
  };
  const invalidateDetail = (): void => {
    detailSequence.current += 1;
    detailRequest.current = null;
    if (mounted.current) setDetailBusy(false);
  };
  const loadDetail = async (id: string, revision: string): Promise<void> => {
    detailReload.current = null;
    const ticket = ++detailSequence.current;
    detailRequest.current = { ticket, identity };
    setDetailBusy(true); setDetailError(undefined); setDetail(undefined);
    try {
      const result = await api<WorldbookResourceDetail>(`/worldbooks/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}`);
      if (!isCurrent() || ticket !== detailSequence.current) return;
      setDetail(result);
    } catch (cause) {
      if (isCurrent() && ticket === detailSequence.current) setDetailError(errorMessage(cause));
    } finally {
      // Ownership check: an older request must not clear a newer request or a restored state.
      if (detailRequest.current?.ticket === ticket) {
        detailRequest.current = null;
        if (mounted.current && isCurrent()) setDetailBusy(false);
      }
    }
  };
  useEffect(() => {
    const pending = detailRequest.current;
    if (pending) detailReload.current = { identity: pending.identity };
    selectionSequence.current += 1;
    invalidateDetail();
    if (!current.current.visible || current.current.locked || current.current.disabled) return;
    if (!open) { detailReload.current = null; return; }
    const reload = detailReload.current;
    if (!reload) return;
    detailReload.current = null;
    if (reload.identity !== identity || source.kind !== 'artifact' || !source.ref.id || !source.ref.revision) return;
    void loadDetail(source.ref.id, source.ref.revision);
  }, [identity, visible, locked, disabled]);
  const openDialog = (): void => {
    if (!canAct()) return;
    selectionSequence.current += 1; invalidateDetail();
    setOpen(true); setError(undefined); setNotice(undefined);
    if (sourceFor(saved).kind === 'artifact') {
      const currentSource = sourceFor(saved) as Extract<ConversationWorldbookSource, { kind: 'artifact' }>;
      void loadVersions(); void loadDetail(currentSource.ref.id, currentSource.ref.revision);
    }
  };
  const close = async (): Promise<void> => {
    if (!canAct()) return;
    const result = await requestTransition({ scope: { kind: 'ids', ids: [registrationId] }, actionLabel: '关闭世界书设置' });
    if (!isCurrent() || !current.current.visible || current.current.locked) return;
    if (result.ok) { selectionSequence.current += 1; invalidateDetail(); setOpen(false); }
    else if (result.message) setError(result.message);
  };
  const reload = async (): Promise<void> => {
    if (!canAct() || !onReload) return;
    const result = await requestTransition({ scope: { kind: 'ids', ids: [registrationId] }, actionLabel: '重新读取世界书设置' });
    if (!canAct()) return;
    if (result.ok) { selectionSequence.current += 1; invalidateDetail(); setOpen(false); onReload(); }
    else if (result.message) setError(result.message);
  };
  const update = (patch: Partial<WorldbookOptions>): void => {
    if (!canAct()) return;
    if (patch.enabled === true && knownEntryCount === 0) return;
    setDraft(value => ({ ...value, ...patch })); setError(undefined); setNotice(undefined);
  };
  const chooseKind = async (kind: ConversationWorldbookSource['kind']): Promise<void> => {
    if (!canAct()) return;
    const intent = ++selectionSequence.current;
    invalidateDetail(); setDetailError(undefined); setError(undefined); setNotice(undefined); setEvaluation(undefined);
    if (kind === 'role-card') { setSource({ kind: 'role-card' }); return; }
    const previous = source.kind === 'artifact' ? source : undefined;
    setSource({ kind: 'artifact', ref: { source: 'public', id: previous?.ref.id ?? '', revision: previous?.ref.revision ?? '' } });
    const items = versions.length ? versions : (await loadVersions()) ?? [];
    if (!isCurrent() || intent !== selectionSequence.current || !canInteract() || active.current) return;
    const id = previous?.ref.id || items[0]?.id;
    if (!id) { setError('还没有可选的独立世界书。请先在资源库新建或导入世界书 JSON。'); return; }
    const revision = previous?.ref.revision || items.find(item => item.id === id)?.revision;
    if (!revision) { setError('请选择世界书版本。'); return; }
    const next: ConversationWorldbookSource = { kind: 'artifact', ref: { source: 'public', id, revision } };
    setSource(next); void loadDetail(id, revision);
  };
  const chooseBook = (id: string): void => {
    if (!canAct()) return;
    selectionSequence.current += 1; invalidateDetail();
    if (!id) {
      setSource({ kind: 'artifact', ref: { source: 'public', id: '', revision: '' } });
      setDetail(undefined); setDetailError(undefined);
      return;
    }
    const revision = versions.find(item => item.id === id)?.revision;
    if (!revision) return;
    setSource({ kind: 'artifact', ref: { source: 'public', id, revision } }); setEvaluation(undefined);
    void loadDetail(id, revision);
  };
  const chooseRevision = (revision: string): void => {
    if (!canAct() || source.kind !== 'artifact' || !source.ref.id || !revision) return;
    selectionSequence.current += 1; invalidateDetail();
    setSource({ kind: 'artifact', ref: { source: 'public', id: source.ref.id, revision } });
    setEvaluation(undefined); void loadDetail(source.ref.id, revision);
  };

  const endpoint = `/accounts/${encodeURIComponent(binding.accountId)}/role-bindings/${binding.kind}/${encodeURIComponent(binding.peerId)}/worldbook`;
  const readBinding = async (): Promise<WorldbookBinding | undefined> => {
    const result = await api<{ bindings: WorldbookBinding[] }>(`/accounts/${encodeURIComponent(binding.accountId)}/role-bindings`);
    return result.bindings.find(item => item.kind === binding.kind && item.peerId === binding.peerId);
  };
  const save = async (): Promise<void> => {
    if (!canAct() || !valid || !sourceValid || stale || (!optionsDirty && !sourceDirty) || (draft.enabled && knownEntryCount === 0)) return;
    active.current = true; setBusy('save'); setError(undefined); setNotice(undefined);
    const submitted = { ...draft };
    const submittedSource = source;
    const sourceChanged = sourceDirty;
    try {
      const result = await api<{ binding: WorldbookBinding }>(endpoint, { method: 'PUT', body: JSON.stringify({ worldbook: submitted, source: submittedSource, expectedRevision: saved.revision }) });
      if (!isCurrent()) return;
      let updated = { ...saved, ...result.binding };
      let reusedView = false;
      if (sourceChanged) {
        try {
          const fresh = await readBinding();
          if (!isCurrent()) return;
          if (fresh) updated = fresh;
          else reusedView = true;
        } catch { reusedView = true; }
      }
      setSaved(updated); setDraft(optionsFor(updated)); setSource(sourceFor(updated)); setEvaluation(undefined);
      setNotice(reusedView
        ? '世界书设置已保存；会话状态刷新失败，当前显示可能仍是旧来源的数据。请关闭后重新打开或稍后刷新。'
        : '世界书设置已保存；原角色卡绑定保持不变。');
      onSaved(updated);
    } catch (cause) { if (isCurrent()) setError(errorMessage(cause)); }
    finally { active.current = false; if (isCurrent()) setBusy(undefined); }
  };
  const preview = async (): Promise<void> => {
    if (!canAct() || !text.trim()) return;
    active.current = true; setBusy('preview'); setError(undefined); setEvaluation(undefined);
    try {
      const result = await api<{ evaluation: Evaluation }>(`${endpoint}/preview`, { method: 'POST', body: JSON.stringify({ text }) });
      if (isCurrent()) setEvaluation(result.evaluation);
    } catch (cause) { if (isCurrent()) setError(errorMessage(cause)); }
    finally { active.current = false; if (isCurrent()) setBusy(undefined); }
  };

  const artifactIds = [...new Set(versions.map(item => item.id))].sort();
  if (source.kind === 'artifact' && source.ref.id && !artifactIds.includes(source.ref.id)) artifactIds.unshift(source.ref.id);
  const revisions = source.kind === 'artifact'
    ? versions.filter(item => item.id === source.ref.id).map(item => item.revision)
    : [];
  if (source.kind === 'artifact' && source.ref.revision && !revisions.includes(source.ref.revision)) revisions.unshift(source.ref.revision);
  const effective = binding.effectiveWorldbook;
  const entryText = knownEntryCount === undefined ? '保存时校验' : `${knownEntryCount} 条`;

  return <>
    <Button size="sm" icon="settings" disabled={locked || disabled} onClick={openDialog}>世界书 · {entryText}</Button>
    <Modal open={open && visible} title={`${binding.kind === 'private' ? '私聊' : '群聊'} ${binding.peerId} · 世界书`} closeDisabled={frozen} onClose={() => void close()}>
      <div className="ui-modal-content">
        <p>本设置只影响账号 {binding.accountId} 的当前会话。角色卡内置书与公共独立书二选一；独立书固定一个版本，不自动跟随最新。</p>
        <p className="field-hint">支持关键词触发、常驻条目与角色前后插入；不支持递归、正则或概率触发。</p>
        {effective ? <div className="worldbook-effective" role="status">
          <p><strong>当前保存状态</strong>：{effective.source.kind === 'role-card' ? '角色卡内置书' : `公共独立书 ${effective.source.ref.id}@${effective.source.ref.revision}`} · <Tag tone={effective.state === 'ready' ? 'ok' : effective.state === 'empty' ? 'idle' : 'bad'}>{STATE_LABELS[effective.state]}</Tag></p>
          <p className="field-hint">{effective.name ? `${effective.name} · ` : ''}{effective.entryCount} 条，其中启用 {effective.enabledEntryCount} 条{effective.revision ? ` · 固定版本 ${effective.revision}` : ''}</p>
          {effective.error ? <p className="inline-error">{effective.error}</p> : null}
        </div> : null}
        {sourceDirty ? <p className="notice notice-warn">来源改动尚未保存；下方“测试关键词”仍使用已保存来源和参数，不混用当前选择。</p> : null}
        {stale ? <p className="notice notice-warn">该会话绑定已更新，当前草稿已保留。请取消本次修改并重新打开后再保存。</p> : null}

        <Field label="世界书来源">
          <Select aria-label="世界书来源" value={source.kind} disabled={frozen} onChange={event => void chooseKind(event.target.value as ConversationWorldbookSource['kind'])}>
            <option value="role-card">角色卡内置书</option>
            <option value="artifact">公共独立书（固定版本）</option>
          </Select>
        </Field>
        {source.kind === 'artifact' ? <>
          <Field label="世界书">
            <Select aria-label="选择世界书" value={source.ref.id} disabled={frozen || versionsLoading} onChange={event => chooseBook(event.target.value)}>
              <option value="">请选择世界书…</option>
              {artifactIds.map(id => {
                const summary = versions.find(item => item.id === id);
                return <option key={id} value={id}>{summary?.name ? `${summary.name}（${id}）` : id}</option>;
              })}
            </Select>
          </Field>
          <Field label="固定版本">
            <Select aria-label="选择固定版本" value={source.ref.revision} disabled={frozen || versionsLoading} onChange={event => chooseRevision(event.target.value)}>
              {revisions.length === 0 ? <option value="">请先选择世界书</option> : revisions.map(revision => {
                const summary = versions.find(item => item.id === source.ref.id && item.revision === revision);
                return <option key={revision} value={revision}>{revision}{summary ? ` · ${summary.entryCount} 条 · 启用 ${summary.enabledEntryCount}` : ' · 当前引用'}</option>;
              })}
            </Select>
          </Field>
          {versionsLoading ? <p className="muted" role="status">正在读取世界书版本…</p> : null}
          {versionsError ? <ErrorNote message={`无法读取世界书列表：${versionsError}。已保存引用不会被清空。`} onRetry={() => void loadVersions(versions.length > 0 && versionsNextRef.current !== undefined)} /> : null}
          {detailBusy ? <p className="muted" role="status">正在读取指定版本…</p> : null}
          {detailError ? <ErrorNote message={`无法读取该版本：${detailError}。可以重新选择版本，或明确关闭世界书；关闭会保留当前引用。`} /> : null}
          {detailMatches ? <p className="field-hint">草稿来源：{detail!.manifest.name ?? detail!.manifest.id} @ {detail!.manifest.revision} · {detail!.manifest.worldbook.entries.length} 条 · 建议扫描 {detail!.manifest.worldbook.scanDepth} 条、预算 {detail!.manifest.worldbook.budgetChars} 字符。</p> : null}
          <p className="field-hint">已加载 {versions.length} 个版本{versionsNextOffset !== undefined ? '，仍有更多' : ''}；列表只含摘要，不读取正文。</p>
          <div className="banner-actions">
            <Button size="sm" variant="ghost" disabled={frozen || !suggested} onClick={() => update({ scanDepth: suggested!.scanDepth, budgetChars: suggested!.budgetChars })}>采用书中建议参数</Button>
            <Button size="sm" variant="ghost" disabled={frozen || versionsLoading} onClick={() => void loadVersions()}>刷新版本列表</Button>
            {versionsNextOffset !== undefined ? <Button size="sm" variant="ghost" busy={versionsMoreBusy} disabled={frozen || versionsLoading} onClick={() => void loadVersions(true)}>加载更多版本</Button> : null}
          </div>
          <p className="field-hint">“采用书中建议参数”只修改当前草稿，不会自动启用；来源列表读取失败时不会清除已保存引用。超过一页时用“加载更多版本”继续查找。</p>
        </> : <>
          {suggested ? <div className="banner-actions"><Button size="sm" variant="ghost" disabled={frozen} onClick={() => update({ scanDepth: suggested.scanDepth, budgetChars: suggested.budgetChars })}>采用书中建议参数</Button></div> : null}
          <p className="field-hint">角色卡内置书随当前绑定的角色卡版本提供；此处只调整当前会话参数。</p>
        </>}

        <label className="check-row"><Checkbox checked={draft.enabled} disabled={frozen || !sourceValid || (knownEntryCount === 0 && !draft.enabled)} onChange={event => update({ enabled: event.target.checked })} /><span>为当前会话启用世界书</span></label>
        {knownEntryCount === 0 ? <p className="notice">该来源没有可用条目，不能启用。可改用其他版本、角色卡内置书，或保持关闭。</p> : null}
        <Field label="扫描最近历史条数（0–20）"><Input type="number" min={0} max={20} step={1} value={draft.scanDepth} disabled={frozen} onChange={event => update({ scanDepth: Number(event.target.value) })} /></Field>
        <Field label="注入预算字符数（0–8000）"><Input type="number" min={0} max={8000} step={1} value={draft.budgetChars} disabled={frozen} onChange={event => update({ budgetChars: Number(event.target.value) })} /></Field>
        {!valid ? <ErrorNote message="历史条数必须是0–20的整数，预算必须是0–8000的整数。" /> : null}
        {!sourceValid ? <ErrorNote message="请选择公共独立书的 id 和固定版本，或切换回角色卡内置书。" /> : null}
        <div className="form-submit"><ConfirmButton disabled={frozen || !valid || !sourceValid || stale || (!optionsDirty && !sourceDirty) || (draft.enabled && knownEntryCount === 0)} busy={busy === 'save'} onClick={() => void save()}>保存世界书设置</ConfirmButton></div>
        <Field label="关键词测试文本"><Textarea value={text} disabled={frozen} onChange={event => { if (canAct()) { setText(event.target.value); setEvaluation(undefined); } }} placeholder="输入要测试的当前文本" /></Field>
        <p className="field-hint">测试使用已保存配置（包括已保存来源），只检查上方当前文本，不读取真实历史、不调用付费模型、不发送消息。未保存的来源、开关、历史条数和预算不参与本次测试。</p>
        {optionsFor(saved).budgetChars === 0 ? <p className="notice">预算为0，不注入也不执行关键词扫描。</p> : null}
        <Button disabled={frozen || !text.trim()} busy={busy === 'preview'} onClick={() => void preview()}>测试关键词</Button>
        {evaluation ? worldbookEvaluationView(evaluation, '已保存配置测试') : null}
        {error ? <ErrorNote message={error} /> : null}
        {error && onReload ? <Button disabled={frozen} onClick={() => void reload()}>重新读取已保存设置</Button> : null}
        {notice ? <p className="notice" role="status">{notice}</p> : null}
        <div className="form-submit"><CancelButton disabled={frozen} onClick={() => void close()}>关闭</CancelButton></div>
      </div>
    </Modal>
  </>;
}
