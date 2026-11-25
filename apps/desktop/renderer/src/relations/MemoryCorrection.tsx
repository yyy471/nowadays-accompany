import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Button, Checkbox, ErrorNote, Field, Input, Modal, Textarea } from '../ui';
import '../styles/memory-correction.css';

export interface MemoryTarget { type: 'event' | 'daily_summary'; id: string }
interface RecordText { title: string; summary: string; subjectiveExperience: string }
interface Claim { claimId?: string; kind: string; text: string; correctionSource?: 'user_correction' | 'agent_correction' }
interface Detail extends RecordText { version: number; claims?: Claim[] }
interface SearchHit extends MemoryTarget { title: string; snippet: string; experienceDate?: string }
const claimLabels: Record<string, string> = {
  observation: '观察', interest: '兴趣', released: '已经释怀', user_quote: '用户原话', impression: '当时的印象',
  past_feeling: '当时的感受', reflection: '后来的理解', practice: '实践经验', cherished_detail: '珍惜的细节',
  shared_detail: '曾经说过的细节', commitment: '角色承诺', unknown: '尚不清楚的事'
};
function claimLabel(claim: Claim) {
  if (claim.correctionSource) return claim.correctionSource === 'user_correction' ? '用户更正' : '角色更正';
  return claimLabels[claim.kind] ?? '线索';
}

export function MemoryCorrection({ open, roleId, target, source, onClose, onExited, onSaved }: {
  open: boolean; roleId: string; target: MemoryTarget | null; source: HTMLElement;
  onClose: () => void; onExited: () => void; onSaved: () => void;
}) {
  const [selected, select] = useState(target);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [base, setBase] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<RecordText | null>(null);
  const [claimEdits, setClaimEdits] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Detail | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const prefix = '/v1/roles/' + encodeURIComponent(roleId) + '/memory/';
  const route = selected ? prefix + (selected.type === 'event' ? 'events/' : 'summaries/') + encodeURIComponent(selected.id) : '';
  const event = selected?.type === 'event';
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!route) return;
    const controller = new AbortController();
    setError(''); setBase(null); setDraft(null); setConflict(null); setClaimEdits({});
    void api<Detail>(route, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setBase(value); setDraft(value);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); });
    return () => controller.abort();
  }, [route, attempt]);
  async function search() {
    if (lock.current || !query.trim()) return;
    lock.current = true; setBusy(true); setError(''); setHits(null);
    try {
      const result = await api<{ items: SearchHit[] }>(prefix + 'search', { method: 'POST',
        body: { query: query.trim(), types: ['event', 'daily_summary'], limit: 20 } });
      if (mounted.current) setHits(result.items);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const changes: Partial<RecordText> = {};
  if (base && draft) {
    for (const field of event ? ['title', 'summary', 'subjectiveExperience'] as const : ['summary'] as const) {
      if ((draft[field] ?? '').trim() !== (base[field] ?? '')) changes[field] = (draft[field] ?? '').trim();
    }
  }
  const superseded = Object.keys(claimEdits);
  const hasChanges = Object.keys(changes).length > 0 || superseded.length > 0;
  const claims = (base?.claims ?? []).filter((claim): claim is Claim & { claimId: string } => !!claim.claimId);
  const withdrawn = conflict ? claims.filter(claim => claim.claimId in claimEdits && !conflict.claims?.some(latest => latest.claimId === claim.claimId)) : [];
  async function save() {
    if (!base || !draft || !route || lock.current || conflict || !hasChanges) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const replacements = Object.fromEntries(Object.entries(claimEdits).flatMap(([id, value]) => value.trim() ? [[id, value.trim()]] : []));
      const body = event ? { expectedVersion: base.version,
        patch: superseded.length ? { ...changes, summary: draft.summary.trim() } : changes,
        ...(superseded.length ? { supersedeClaimIds: superseded } : {}),
        ...(Object.keys(replacements).length ? { claimReplacements: replacements } : {}) } : { expectedVersion: base.version, summary: draft.summary.trim() };
      await api(route, { method: 'PATCH', body });
      if (mounted.current) onSaved();
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError && reason.code === 'MEMORY_VERSION_CONFLICT') {
        try {
          const latest = await api<Detail>(route);
          if (mounted.current) setConflict(latest);
        } catch { if (mounted.current) setError('暂时无法读取最新版本，草稿已保留，可再次保存重试。'); }
      } else setError(reason instanceof Error ? reason.message : String(reason));
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <Modal open={open} title={selected ? (event ? '更正经历' : '更正日常摘要') : '查找要更正的记忆'}
    className="memory-correction" source={source} onClose={onClose} onExited={onExited} closeDisabled={busy}>
    <form className="memory-correction-form" onSubmit={e => { e.preventDefault(); void (selected ? save() : search()); }}>
      <div className="ui-modal-content memory-correction-fields">
      {!selected && <>
        <div className="memory-correction-search">
          <Field label="记忆关键词"><Input data-autofocus value={query} onChange={e => setQuery(e.target.value)} maxLength={500} /></Field>
          <Button type="submit" busy={busy} disabled={!query.trim()}>查找</Button>
        </div>
        {hits?.length === 0 && <p role="status">没有找到相关的经历或日常摘要。</p>}
        {!!hits?.length && <ul className="memory-correction-hits">{hits.map(hit => <li key={`${hit.type}:${hit.id}`}>
          <Button variant="entry" onClick={() => select(hit)}>{hit.title}{hit.experienceDate && ` · ${hit.experienceDate}`}</Button>
        </li>)}</ul>}
      </>}
      {error && <ErrorNote message={error} onRetry={selected && !base ? () => setAttempt(n => n + 1) : undefined} />}
      {selected && !base && !error && <p role="status" className="memory-correction-loading"><span className="spinner" aria-hidden="true" />正在读取记忆…</p>}
      {draft && base && <>
      {event && <Field label="经历标题"><Input required maxLength={500} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} /></Field>}
      <Field label={event ? '事情经过' : '日常摘要'}><Textarea required maxLength={20000} value={draft.summary} onChange={e => setDraft({ ...draft, summary: e.target.value })} /></Field>
      {event && <Field label="当时的感受"><Textarea maxLength={20000} value={draft.subjectiveExperience ?? ''} onChange={e => setDraft({ ...draft, subjectiveExperience: e.target.value })} /></Field>}
      {event && claims.length > 0 && <details>
        <summary>更正记忆线索（{claims.length}）</summary>
        <fieldset><legend>选择需要更正的线索</legend>
          <p>为勾选的线索填写新内容即可替换，留空则撤下。</p>
          {superseded.length >= 100 && <p role="status">每次最多更正 100 条线索。</p>}
          {claims.map(claim => <div className="memory-correction-clue" key={claim.claimId}><label>
            <Checkbox checked={claim.claimId in claimEdits} disabled={busy || (!(claim.claimId in claimEdits) && superseded.length >= 100)} onChange={e => {
              const checked = e.currentTarget.checked;
              setClaimEdits(previous => {
                const next = { ...previous };
                if (checked) next[claim.claimId] = ''; else delete next[claim.claimId];
                return next;
              });
            }} /> {claimLabel(claim)} · {claim.text}
          </label>
            {claim.claimId in claimEdits && <Field label="替换为"><Textarea maxLength={2000} value={claimEdits[claim.claimId]} disabled={busy}
              onChange={e => setClaimEdits({ ...claimEdits, [claim.claimId]: e.target.value })} /></Field>}
          </div>)}
        </fieldset>
      </details>}
      {conflict && <section className="memory-correction-conflict" aria-label="版本冲突">
        <p role="alert">这条记忆已有新的修改，你的草稿已保留。</p>
        <p>最新记录 · 第 {conflict.version} 版</p>
        {event && <p>{conflict.title}</p>}<p>{conflict.summary}</p>{event && <p>{conflict.subjectiveExperience}</p>}
        {withdrawn.length > 0 && <><p>以下线索已在最新版本中撤下或替换，合并后会取消这些勾选。</p>
          <ul>{withdrawn.map(claim => <li key={claim.claimId}>{claim.text}{claimEdits[claim.claimId] && <p>你的草稿：{claimEdits[claim.claimId]}</p>}</li>)}</ul></>}
        <div className="memory-correction-conflict-actions">
          <Button onClick={() => {
            setBase(conflict); setDraft({ ...conflict, ...changes });
            setClaimEdits(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => conflict.claims?.some(claim => claim.claimId === id))));
            setConflict(null);
          }}>保留我的修改，合并其余字段</Button>
          <Button onClick={() => { setBase(conflict); setDraft(conflict); setClaimEdits({}); setConflict(null); }}>采用最新记录</Button>
        </div>
      </section>}
      </>}
      </div>
      {draft && base && <footer className="ui-dialog-actions"><Button onClick={onClose} disabled={busy}>取消</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!!conflict || !draft.summary.trim() || (event && !draft.title.trim()) || !hasChanges}>保存更正</Button>
      </footer>}
    </form>
  </Modal>;
}
