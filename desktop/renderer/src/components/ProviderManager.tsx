import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage } from '../hooks';
import type { ProviderDto } from '../types';
import { Button, Card, ControlButton, ErrorNote, Field, Input, Tag, useConfirm } from '../ui';
import { useDraftProtection } from './DraftProtectionProvider';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { hashRevision } from '../lib/drafts/registry';
import { previewAndDeleteProvider, providerEditDraft, providerEditPayload, type ProviderEditDraft } from '../lib/provider-management';
import type { ServiceWriteGuard } from '../lib/service-write-coordinator';

const DRAFT_ID = 'models:provider-manager';
const SERVICE_DRAFT_ID = 'models:services';
export function ProviderManager({ providers, refresh, writeGuard, onGoAccountModels }: { providers: ProviderDto[]; refresh: () => Promise<unknown>; writeGuard: ServiceWriteGuard; onGoAccountModels?: () => void }) {
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<ProviderDto>();
  const [draft, setDraft] = useState<ProviderEditDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);
  const gate = useRef(false);
  const mounted = useRef(true);
  const lifetime = useRef(new AbortController());
  const confirm = useConfirm();
  const { requestTransition } = useDraftProtection();
  useEffect(() => {
    mounted.current = true;
    if (lifetime.current.signal.aborted) lifetime.current = new AbortController();
    return () => { mounted.current = false; lifetime.current.abort(); };
  }, []);
  const dirty = Boolean(baseline && draft && JSON.stringify(draft) !== JSON.stringify(providerEditDraft(baseline)));
  const currentProvider = providers.find(provider => provider.id === baseline?.id);
  const stale = Boolean(baseline && JSON.stringify(currentProvider) !== JSON.stringify(baseline));
  useEffect(() => {
    if (!baseline || busy || dirty || !stale) return;
    setBaseline(currentProvider ? structuredClone(currentProvider) : undefined);
    setDraft(currentProvider ? providerEditDraft(currentProvider) : undefined);
  }, [baseline, currentProvider, busy, dirty, stale]);
  useDraftRegistration({ id: DRAFT_ID, owner: 'page', label: '已有服务编辑', dirty, busy,
    revision: hashRevision({ baseline, draft }), discard: () => { setDraft(baseline ? providerEditDraft(baseline) : undefined); setError(''); } });
  useEffect(() => {
    writeGuard.setIntents('advanced', baseline && dirty ? [baseline.id] : []);
  }, [writeGuard.setIntents, baseline?.id, dirty]);
  useEffect(() => () => { writeGuard.setIntents('advanced', []); }, [writeGuard.setIntents]);
  const lockedBySimpleFor = (providerId: string): boolean => {
    const lock = Object.hasOwn(writeGuard.locks, providerId) ? writeGuard.locks[providerId] : undefined;
    const write = Object.hasOwn(writeGuard.writes, providerId) ? writeGuard.writes[providerId] : undefined;
    return Boolean((lock && lock !== 'advanced') || (write && write !== 'advanced'));
  };
  const lockedBySimple = Boolean(baseline && lockedBySimpleFor(baseline.id));

  const edit = async (provider?: ProviderDto) => {
    if (gate.current) return;
    const result = await requestTransition({ scope: { kind: 'ids', ids: [DRAFT_ID, SERVICE_DRAFT_ID] }, actionLabel: '切换服务' });
    if (!result.ok) { if (result.message) setError(result.message); return; }
    setBaseline(provider ? structuredClone(provider) : undefined); setDraft(provider ? providerEditDraft(provider) : undefined); setError(''); setNotice(''); setSaved(false);
  };
  const update = (patch: Partial<ProviderEditDraft>) => { if (!gate.current) { setDraft(current => current && ({ ...current, ...patch })); setSaved(false); setError(''); } };
  const run = async (action: () => Promise<void>) => {
    if (gate.current) return;
    gate.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { if (mounted.current) setError(errorMessage(failure)); }
    finally { gate.current = false; if (mounted.current) setBusy(false); }
  };
  const save = () => {
    if (!baseline || !draft || gate.current) return;
    if (lockedBySimple) {
      setError('该服务在“服务与模型”中有未保存修改；请先保存或撤销简易草稿，再保存高级修改。');
      return;
    }
    if (!writeGuard.begin(baseline.id, 'advanced')) {
      setError('该服务正在被其他编辑保存，请稍后再试。');
      return;
    }
    const providerId = baseline.id;
    void run(async () => {
      try {
        if (!baseline || !draft) return;
        const latest = providers.find(provider => provider.id === baseline.id);
        if (!latest || JSON.stringify(latest) !== JSON.stringify(baseline)) {
          throw new Error('此服务已在其他位置更新，请重新读取当前服务后再保存。当前草稿仍保留。');
        }
        const response = await api<{ provider: ProviderDto }>(`/providers/${encodeURIComponent(baseline.id)}`, { method: 'PUT', body: JSON.stringify(providerEditPayload(baseline, draft)) });
        if (!mounted.current) return;
        setBaseline(response.provider); setDraft(providerEditDraft(response.provider)); setSaved(true); setNotice('服务已保存。账号模型选择和工具授权仍需单独配置。'); await refresh();
      } finally {
        writeGuard.end(providerId, 'advanced');
      }
    });
  };
  const beginExclusive = (providerId: string): boolean => {
    if (lockedBySimpleFor(providerId)) {
      setError('该服务在“服务与模型”中有未保存修改；请先保存或撤销简易草稿，再执行此操作。');
      return false;
    }
    if (!writeGuard.begin(providerId, 'advanced')) {
      setError('该服务正在被其他编辑保存，请稍后再试。');
      return false;
    }
    return true;
  };
  const runExclusive = (providerId: string, action: () => Promise<void>): void => {
    if (gate.current) return;
    if (!beginExclusive(providerId)) return;
    void run(async () => {
      try { await action(); } finally { writeGuard.end(providerId, 'advanced'); }
    });
  };
  const clearKey = (provider: ProviderDto) => runExclusive(provider.id, async () => {
    const signal = lifetime.current.signal;
    if (!await confirm({ title: `清除 ${provider.id} 的密钥？`, description: '服务和账号配置会保留，需要密钥的请求将不可用。', confirmLabel: '清除密钥', tone: 'danger', signal }) || !mounted.current || signal.aborted) return;
    const response = await api<{ provider: ProviderDto }>(`/providers/${encodeURIComponent(provider.id)}/credential`, { method: 'DELETE' });
    if (!mounted.current) return;
    // Update only credential metadata; never discard another field or capability draft.
    setBaseline(current => current?.id === provider.id ? { ...current, credential: response.provider.credential } : current);
    setNotice(`${provider.id} 的密钥已清除，服务已保留。`); await refresh();
  });
  const remove = (provider: ProviderDto) => runExclusive(provider.id, async () => {
    const signal = lifetime.current.signal;
    const result = await previewAndDeleteProvider(provider.id, api, impact => confirm({
      title: `删除服务 ${provider.id}？`, tone: 'danger', confirmLabel: '删除服务', signal,
      description: <div><p>影响 {impact.affectedAccounts.length} 个账号；相关授权、模型选择及回退项将被清理。</p>{impact.affectedAccounts.length ? <ul>{impact.affectedAccounts.map(id => <li key={id}>{id}</li>)}</ul> : <p>当前没有账号引用此服务。</p>}<p>服务及其专用密钥会被删除。</p></div>
    }), () => mounted.current && !signal.aborted);
    if (!result || !mounted.current) return;
    if (baseline?.id === provider.id) { setBaseline(undefined); setDraft(undefined); }
    setNotice(`${result.removed ? '服务已删除' : '服务已不存在'}；实际影响 ${result.affectedAccounts.length} 个账号${result.affectedAccounts.length ? `：${result.affectedAccounts.join('、')}` : '。'}`); await refresh();
  });
  return <Card title="高级服务管理" subtitle="查看服务标识、地址、模型和密钥状态；需要时再展开管理。">
    <ControlButton type="button" className="extension-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>管理全部服务（{providers.length}）</ControlButton>
    <div hidden={!open}>
      {providers.length === 0 && !baseline ? <p className="muted">还没有保存的模型服务。</p> : [...providers, ...(baseline && !currentProvider ? [baseline] : [])].map(provider => <section className="simple-model-row" key={provider.id}>
        <div className="simple-model-editor">
          <strong>{provider.id}</strong><span className="muted">{provider.baseUrl}</span>
          <span>模型：{provider.models.map(model => model.id).join(' / ') || '无'}</span>
          <Tag tone={provider.credential.configured ? 'ok' : 'idle'}>{provider.credential.configured ? '密钥已保存' : '未保存密钥'}</Tag>
          <div className="model-editor-actions"><Button disabled={busy} onClick={() => void edit(provider)}>编辑服务</Button><Button disabled={busy || lockedBySimpleFor(provider.id) || !provider.credential.configured} variant="ghost" onClick={() => void clearKey(provider)}>清除密钥</Button><Button disabled={busy || lockedBySimpleFor(provider.id) || (baseline?.id === provider.id && dirty)} variant="danger" onClick={() => void remove(provider)}>删除服务</Button></div>
          {baseline?.id === provider.id && draft ? <div className="model-fields">
            {lockedBySimple ? <div className="notice notice-warn"><p>该服务在“服务与模型”中有未保存修改；保存或撤销简易草稿后才能保存高级修改。</p></div> : null}
            {stale ? <div className="notice notice-warn"><p>{currentProvider ? '此服务已在其他位置更新。当前草稿保留；重新读取后再修改，避免覆盖新配置。' : '此服务已不存在。当前草稿仍保留，请放弃草稿后选择其他服务。'}</p><Button disabled={busy} onClick={() => void edit(currentProvider)}>{currentProvider ? '重新读取当前服务' : '放弃已删除服务的草稿'}</Button></div> : null}
            <Field label="Base URL"><Input disabled={busy} value={draft.baseUrl} onChange={event => update({ baseUrl: event.target.value })} /></Field>
            <Field label="适配器" hint="沿用当前协议，或填写服务支持的适配器标识。"><Input disabled={busy} value={draft.adapterId} onChange={event => update({ adapterId: event.target.value })} /></Field>
            {draft.modelIds.map((id, index) => <Field key={index} label={`模型 ${index + 1}`} hint="模型能力和高级参数会保留。修改模型名后，请检查账号模型选择。"><Input disabled={busy} value={id} onChange={event => update({ modelIds: draft.modelIds.map((value, i) => i === index ? event.target.value : value) })} /></Field>)}
            <Field label="API Key" hint="已保存的密钥不会回填；同一来源留空保持，换来源必须重新输入。"><Input type="password" autoComplete="new-password" disabled={busy} value={draft.secret} onChange={event => update({ secret: event.target.value })} /></Field>
            <Button variant="primary" disabled={busy || !dirty || stale || lockedBySimple} busy={busy} onClick={() => void save()}>保存服务修改</Button>
          </div> : null}
        </div>
      </section>)}
      {busy ? <p className="muted" role="status">正在处理服务操作，请稍候…</p> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {saved && onGoAccountModels ? <Button disabled={busy} onClick={onGoAccountModels}>去账号模型配置</Button> : null}
    </div>
  </Card>;
}
