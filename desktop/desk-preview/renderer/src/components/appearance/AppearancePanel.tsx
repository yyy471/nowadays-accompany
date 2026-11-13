import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUpload, ApiError } from '../../api';
import type { Outfit } from '../../types';
import { appearanceAssetUrl } from '../../types';
import { Button, Field, LoadingNote, Select } from '../../ui';
import {
  markImportedPlans,
  mergeOutfitEntries,
  planOutfitImport,
  scanAppearanceFolder,
  summarizeOutfitPlan,
  type AppearanceImportPlan,
  type AppearanceScanResult,
} from '../../appearance-import.js';

type Props = {
  roleId: string;
  currentOutfitId?: string;
  canWrite?: boolean;
  onChanged?: () => void;
  onPreview?: (outfit: Outfit) => void;
  onPreviewAsset?: (assetId: string) => void;
  /** 受保护写入前先暂停角色；由角色编辑器注入。 */
  guardWrite?: <T>(action: () => Promise<T>) => Promise<T>;
  /** 角色当前未停止：按钮显示「暂停并…」。 */
  pausedWrite?: boolean;
};

const folderAttributes = {
  webkitdirectory: '',
  directory: '',
} as unknown as Record<string, string>;

const SKIP_REASON_LABELS: Record<string, string> = {
  DOCUMENT: '说明文件',
  NOT_IMAGE: '非图片',
  HIDDEN: '隐藏文件',
  OUTFITS_SKIPPED: 'outfits 锚点目录',
  OUTSIDE_SOURCE: '素材目录外',
  UNRECOGNIZED: '无法归类',
};

export function AppearancePanel({ roleId, currentOutfitId, canWrite = true, onChanged, onPreview, onPreviewAsset, guardWrite = action => action(), pausedWrite = false }: Props) {
  const [items, setItems] = useState<Outfit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const [rename, setRename] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'outfit' | 'sprite'; id: string; name: string } | null>(null);
  const confirmTrigger = useRef<HTMLButtonElement | null>(null);
  const [scan, setScan] = useState<AppearanceScanResult | null>(null);
  const [merges, setMerges] = useState<Record<string, string>>({});
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [homePicks, setHomePicks] = useState<Record<string, number>>({});
  /** 按套保存上次导入失败原因；刷新列表后仍保留，重试成功才清除（283 §4 R09）。 */
  const [importFailures, setImportFailures] = useState<Record<string, string>>({});
  /** 本轮已确认上传成功的套；列表刷新失败时仍据此只重试未成功的套（283 §5 R09）。 */
  const [importedIds, setImportedIds] = useState<Record<string, true>>({});
  const folderInput = useRef<HTMLInputElement>(null);
  const spriteInput = useRef<HTMLInputElement>(null);
  const homeInput = useRef<HTMLInputElement>(null);

  // 角色切换令牌：导入或补图晚到的回调不能写进另一个角色的页面状态。
  const roleToken = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const lastRole = useRef(roleId);
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
  }
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  const load = async (token: number = roleToken.current) => {
    setLoading(true);
    try {
      const result = await api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`);
      if (isStale(token)) return;
      setItems(result.items);
      setError('');
      setSelected(previous => result.items.some(item => item.outfitId === previous) ? previous : (result.items[0]?.outfitId ?? ''));
    } catch (e) {
      if (isStale(token)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale(token)) setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setItems([]); setSelected(''); setError(''); setNotice(''); setLoading(true); setBusy(false);
    setScan(null); setMerges({}); setRenames({}); setHomePicks({}); setImportFailures({}); setImportedIds({});
    void api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`).then(result => {
      if (!active) return;
      setItems(result.items);
      setSelected(result.items[0]?.outfitId ?? '');
      setLoading(false);
    }).catch(e => {
      if (active) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
    });
    return () => { active = false; };
  }, [roleId]);

  const plans = useMemo<AppearanceImportPlan[]>(() => {
    if (scan === null) return [];
    const merged = mergeOutfitEntries(scan.entries, merges);
    const renamed = merged.map(entry => renames[entry.id] === undefined ? entry : { ...entry, name: renames[entry.id]! });
    const planned = planOutfitImport(renamed, { existingNames: items.map(item => item.name) });
    // 本轮已经上传成功的套不再进入可重试集合，即使列表刷新失败拿不到新名称。
    return markImportedPlans(planned, importedIds);
  }, [scan, merges, renames, items, importedIds]);

  const summary = useMemo(() => summarizeOutfitPlan(plans), [plans]);

  // 缩略图只跟随扫描结果重建，改名和归并不会让图片重新解码。
  const thumbs = useMemo(() => {
    const map = new Map<File, string>();
    for (const entry of scan?.entries ?? []) {
      for (const file of [entry.home, ...entry.homeCandidates]) {
        if (file !== null && file !== undefined && !map.has(file)) map.set(file, URL.createObjectURL(file));
      }
    }
    return map;
  }, [scan]);

  useEffect(() => () => {
    for (const url of thumbs.values()) URL.revokeObjectURL(url);
  }, [thumbs]);

  const scanFolder = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const entries = [...files].map(file => ({
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      file,
    }));
    const result = scanAppearanceFolder(entries);
    setScan(result); setMerges(result.suggestedMerges); setRenames({}); setHomePicks({});
    setImportFailures({}); setImportedIds({});
    setNotice(''); setError('');
    if (folderInput.current) folderInput.current.value = '';
    if (result.entries.length === 0) {
      setError('所选文件夹里没有 standees 或 expressions 素材。请选择角色自己的素材文件夹。');
    }
  };

  const cancelScan = () => {
    setScan(null); setMerges({}); setRenames({}); setHomePicks({});
    setImportFailures({}); setImportedIds({});
  };

  const homeFor = (plan: AppearanceImportPlan): File | null => {
    const picked = homePicks[plan.id];
    if (picked !== undefined) return plan.homeCandidates[picked] ?? plan.home;
    return plan.home;
  };

  const mergeInto = (fromId: string, toId: string) => {
    if (toId.length === 0) return;
    setMerges(previous => ({ ...previous, [fromId]: toId }));
  };

  const undoMerge = (toId: string) => {
    setMerges(previous => {
      const next = { ...previous };
      for (const [fromId, target] of Object.entries(next)) {
        if (target === toId) delete next[fromId];
      }
      return next;
    });
  };

  const confirmImport = async () => {
    const ready = plans.filter(plan => plan.status === 'ready');
    if (ready.length === 0 || busy || !canWrite) return;
    const token = roleToken.current;
    setBusy(true); setNotice(''); setError('');
    const imported: string[] = [];
    const failed: string[] = [];
    const importedIds: string[] = [];
    const failureDetails: Record<string, string> = {};
    try {
      for (const plan of ready) {
        const form = new FormData();
        form.append('name', plan.name);
        const home = homeFor(plan);
        if (home) form.append('home', home, home.name);
        for (const sprite of plan.sprites) form.append('sprites', sprite, sprite.name);
        try {
          await guardWrite(() => apiUpload<Outfit>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`, form));
          imported.push(plan.name);
          importedIds.push(plan.id);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          failed.push(`「${plan.name}」${reason}`);
          failureDetails[plan.id] = reason;
        }
      }
      setImportFailures(previous => {
        const next = { ...previous };
        for (const id of importedIds) delete next[id];
        for (const [id, reason] of Object.entries(failureDetails)) next[id] = reason;
        return next;
      });
      // 已经切到别的角色：上传仍归属原角色，但不再改动当前页面。
      if (isStale(token)) return;
      setImportedIds(previous => {
        const next = { ...previous };
        for (const id of importedIds) next[id] = true;
        return next;
      });
      setImportFailures(previous => {
        const next = { ...previous };
        for (const id of importedIds) delete next[id];
        for (const [id, reason] of Object.entries(failureDetails)) next[id] = reason;
        return next;
      });
      const duplicates = plans.filter(plan => plan.status === 'duplicate').map(plan => plan.name);
      const missing = plans.filter(plan => plan.status === 'ready' && (plan.missingHome || plan.missingSprites)).map(plan => plan.name);
      const parts: string[] = [];
      if (imported.length > 0) parts.push(`已导入 ${imported.length} 套：${imported.join('、')}`);
      if (duplicates.length > 0) parts.push(`跳过重名 ${duplicates.length} 套：${duplicates.join('、')}`);
      if (missing.length > 0) parts.push(`缺项待补：${missing.join('、')}`);
      if (failed.length > 0) parts.push(`失败 ${failed.length} 套`);
      setNotice(parts.join('。'));
      // 部分失败时保留预览：已成功的服饰重读后会显示为重名，
      // 原处再次导入只提交仍未成功的套（283 R09）。
      if (failed.length === 0) cancelScan();
      await load(token);
      if (isStale(token)) return;
      if (failed.length > 0) {
        // load 会清掉通用错误；逐套原因保存在 importFailures 里，这里再给摘要。
        setError(`部分服饰导入失败（${failed.length} 套），原因见列表；再次确认导入只会重试未成功的套。`);
      }
      onChanged?.();
    } finally {
      // 过期操作不能清掉当前角色的忙碌状态。
      if (!isStale(token)) setBusy(false);
    }
  };

  const uploadSprite = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy || !canWrite) return;
    if (!selected) { setNotice('请先选择一套已有服饰。'); return; }
    const token = roleToken.current;
    setBusy(true); setNotice(''); setError('');
    try {
      const form = new FormData();
      form.append('sprite', file, file.name);
      await guardWrite(() => apiUpload(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(selected)}/sprites`, form));
      if (isStale(token)) return;
      setNotice(`已添加差分「${file.name.replace(/\.[^.]+$/, '')}」`);
      await load(token);
      if (isStale(token)) return;
      onChanged?.();
    } catch (e) {
      if (isStale(token)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale(token)) {
        setBusy(false);
        if (spriteInput.current) spriteInput.current.value = '';
      }
    }
  };

  const selectedOutfit = items.find(item => item.outfitId === selected);
  useEffect(() => { setRename(selectedOutfit?.name ?? ''); setConfirm(null); }, [selected, selectedOutfit?.name]);
  const errorMessage = (reason: unknown) => reason instanceof ApiError && reason.code === 'LAST_OUTFIT_REQUIRED' ? '至少保留一套服饰。' : reason instanceof ApiError && reason.code === 'ROLE_NOT_STOPPED' ? '角色尚未停止，请先到角色状态中停止。' : reason instanceof Error ? reason.message : String(reason);
  const updateOutfit = async (operation: 'rename' | 'home' | 'outfit' | 'sprite', file?: File, assetId?: string) => {
    if (busy || !canWrite || !selected || (operation === 'rename' && !rename.trim())) return;
    const token = roleToken.current;
    const outfitId = selected;
    const path = `/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(outfitId)}`;
    setBusy(true); setNotice(''); setError('');
    try {
      await guardWrite(async () => {
        if (operation === 'rename') await api(path, { method: 'PATCH', body: { name: rename.trim() } });
        else if (operation === 'home' && file) { const body = new FormData(); body.append('home', file, file.name); await apiUpload(`${path}/home`, body); }
        else if (operation === 'outfit') await api(path, { method: 'DELETE' });
        else if (operation === 'sprite' && assetId) await api(`${path}/sprites/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
      });
      if (isStale(token)) return;
      setConfirm(null);
      setNotice(operation === 'rename' ? '服饰已改名。' : operation === 'home' ? '主页立绘已更新，历史句段保留原图。' : operation === 'outfit' ? '服饰已删除，历史引用的素材会保留。' : '差分已删除，历史引用的素材会保留。');
      await load(token);
      if (!isStale(token)) onChanged?.();
    } catch (reason) { if (!isStale(token)) setError(errorMessage(reason)); }
    finally { if (!isStale(token)) { setBusy(false); if (homeInput.current) homeInput.current.value = ''; } }
  };

  const skippedSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of scan?.skipped ?? []) {
      counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    }
    return [...counts.entries()].map(([reason, count]) => `${SKIP_REASON_LABELS[reason] ?? reason} ${count}`);
  }, [scan]);

  return <div className="nd-appearance">
    <p className="nd-appearance-hint">选择角色自己的素材文件夹，读取 <code>standees/&lt;服饰&gt;/</code> 作为主页立绘、<code>expressions/&lt;服饰&gt;/</code> 作为对话差分。素材库里的 <code>outfits/</code> 是生图锚点，不会导入。旧格式的 <code>outfits/&lt;服饰名&gt;/home.*</code> 仍然可用。</p>
    <div className="nd-appearance-actions">
      <input ref={folderInput} type="file" multiple {...folderAttributes} className="nd-visually-hidden" onChange={event => scanFolder(event.target.files)} />
      <Button disabled={busy || !canWrite} onClick={() => folderInput.current?.click()}>{scan === null ? '选择角色素材文件夹' : '重新选择'}</Button>
      {currentOutfitId ? <span className="nd-appearance-current">当前穿着：{items.find(item => item.outfitId === currentOutfitId)?.name ?? '未知服饰'}</span> : null}
    </div>

    {scan !== null ? <section className="nd-import" aria-label="导入预览">
      <div className="nd-import-summary">
        <b>识别到 {summary.total} 套服饰{scan.root ? `（${scan.root}）` : ''}</b>
        <small>可导入 {summary.ready} · 重名 {summary.duplicate} · 缺主页图 {summary.missingHome} · 缺差分 {summary.missingSprites} · 差分共 {summary.spriteCount} 张</small>
        {skippedSummary.length > 0 ? <small>已跳过：{skippedSummary.join('、')}</small> : null}
        {scan.issues.some(issue => issue.code === 'MULTIPLE_ROOTS') ? <small className="nd-import-warn">所选目录包含多个角色，只按第一个角色识别。</small> : null}
      </div>
      <ul className="nd-import-list">
        {plans.map(plan => {
          const home = homeFor(plan);
          const thumb = home === null ? undefined : thumbs.get(home);
          const mergeTargets = plans.filter(other => other.id !== plan.id && (
            (plan.home === null && other.home !== null) || (plan.sprites.length === 0 && other.sprites.length > 0)
          ));
          return <li key={plan.id} className={'nd-import-item' + (plan.status === 'duplicate' ? ' duplicate' : '') + (plan.status === 'ready' ? '' : ' blocked')}>
            <span className="nd-import-thumb">{thumb ? <img src={thumb} alt="" /> : <span>无主页图</span>}</span>
            <div className="nd-import-meta">
              <input
                className="nd-import-name"
                aria-label="服饰名称"
                value={renames[plan.id] ?? plan.name}
                onChange={event => setRenames(previous => ({ ...previous, [plan.id]: event.target.value }))}
              />
              <small>{plan.sprites.length} 张差分{plan.standeeDir ? ` · 立绘目录 ${plan.standeeDir}` : ''}{plan.expressionDir ? ` · 差分目录 ${plan.expressionDir}` : ''}</small>
              {plan.homeCandidates.length > 1 ? <Select
                value={String(homePicks[plan.id] ?? 0)}
                onChange={event => setHomePicks(previous => ({ ...previous, [plan.id]: Number(event.target.value) }))}
              >
                {plan.homeCandidates.map((file, index) => <option key={file.name + String(index)} value={String(index)}>主页图：{file.name}</option>)}
              </Select> : null}
              {mergeTargets.length > 0 ? <Select value="" onChange={event => mergeInto(plan.id, event.target.value)}>
                <option value="">归并到…</option>
                {mergeTargets.map(other => <option key={other.id} value={other.id}>{other.name}</option>)}
              </Select> : null}
              {plan.notes.length > 0 ? <small className="nd-import-notes">{plan.notes.join('；')}</small> : null}
              {importFailures[plan.id] ? <small className="nd-import-error" role="alert">上次导入失败：{importFailures[plan.id]}</small> : null}
              {plan.mergedFrom !== undefined && plan.mergedFrom.length > 0
                ? <button type="button" className="nd-import-undo" onClick={() => undoMerge(plan.id)}>撤销归并</button>
                : null}
            </div>
          </li>;
        })}
      </ul>
      <div className="nd-appearance-actions">
        <Button variant="primary" disabled={busy || !canWrite || summary.ready === 0} onClick={() => void confirmImport()}>
          {busy ? '正在导入…' : `${pausedWrite ? '暂停并导入' : '确认导入'} ${summary.ready} 套`}
        </Button>
        <Button disabled={busy} onClick={cancelScan}>取消</Button>
        {pausedWrite ? <small className="nd-appearance-hint">导入时会先暂停角色。</small> : null}
      </div>
    </section> : null}

    {loading ? <LoadingNote label="正在读取衣柜…" /> : items.length === 0 ? <p className="nd-appearance-empty">这个角色还没有导入服饰。</p> : <ul className="nd-outfit-list">
      {items.map(outfit => <li key={outfit.outfitId} className={'nd-outfit' + (outfit.outfitId === selected ? ' selected' : '') + (outfit.outfitId === currentOutfitId ? ' current' : '')}>
        <button type="button" className="nd-outfit-card" aria-pressed={outfit.outfitId === selected} onClick={() => { setSelected(outfit.outfitId); onPreview?.(outfit); }}>
          <span className="nd-outfit-thumb">{outfit.home ? <img src={appearanceAssetUrl(roleId, outfit.home.assetId)} alt="" /> : <span>无主页图</span>}</span>
          <span className="nd-outfit-meta"><b>{outfit.name}</b><small>{outfit.description ?? '未填写用途'} · {outfit.sprites.length} 张差分</small></span>
        </button>
        {outfit.sprites.length > 0 ? <p className="nd-outfit-sprites">{outfit.sprites.map(sprite => sprite.displayName).join('、')}</p> : null}
      </li>)}
    </ul>}
    {selectedOutfit && <section className="nd-outfit-manage" aria-label="服饰管理">
      <h3>{selectedOutfit.name}</h3>
      <Field label="服饰名称"><input value={rename} disabled={busy} maxLength={100} onChange={event => setRename(event.target.value)} /></Field>
      <div className="nd-appearance-actions"><Button disabled={busy || !canWrite || !rename.trim() || rename.trim() === selectedOutfit.name} onClick={() => void updateOutfit('rename')}>保存名称</Button>
        <input ref={homeInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void updateOutfit('home', file); }}/>
        <Button disabled={busy || !canWrite} onClick={() => homeInput.current?.click()}>{selectedOutfit.home ? '替换主页立绘' : '补传主页立绘'}</Button>
        <Button disabled={busy || !canWrite || items.length <= 1} onClick={event => { confirmTrigger.current = event.currentTarget; setConfirm({ kind: 'outfit', id: selectedOutfit.outfitId, name: selectedOutfit.name }); }}>删除服饰</Button>
      </div>
      {items.length <= 1 && <p>至少保留一套服饰。</p>}
      {selectedOutfit.sprites.length > 0 && <ul className="nd-outfit-assets">{selectedOutfit.sprites.map(sprite => <li key={sprite.assetId}><button type="button" className="nd-sprite-preview" onClick={() => onPreviewAsset?.(sprite.assetId)}><img src={appearanceAssetUrl(roleId, sprite.assetId)} alt=""/><span>{sprite.displayName}</span></button><button type="button" disabled={busy || !canWrite} onClick={event => { confirmTrigger.current = event.currentTarget; setConfirm({ kind: 'sprite', id: sprite.assetId, name: sprite.displayName }); }}>删除差分</button></li>)}</ul>}
      {confirm && <div role="alert" className="nd-outfit-confirm"><p>删除{confirm.kind === 'outfit' ? '服饰' : '差分'}「{confirm.name}」？历史消息引用的素材将保留。</p><Button disabled={busy || !canWrite} onClick={() => void updateOutfit(confirm.kind, undefined, confirm.id)}>确认删除</Button> <button type="button" disabled={busy} onClick={() => { setConfirm(null); requestAnimationFrame(() => confirmTrigger.current?.focus()); }}>取消</button></div>}
    </section>}
    <div className="nd-sprite-upload">
      <Field label="补一张差分到已有服饰"><Select value={selected} disabled={busy || items.length === 0} onChange={event => setSelected(event.target.value)}>
        {items.length === 0 ? <option value="">暂无服饰</option> : items.map(outfit => <option key={outfit.outfitId} value={outfit.outfitId}>{outfit.name}</option>)}
      </Select></Field>
      <input ref={spriteInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => void uploadSprite(event.target.files)} />
      <Button disabled={busy || !canWrite || !selected} onClick={() => spriteInput.current?.click()}>上传差分图片</Button>
    </div>
    {notice ? <p className="nd-appearance-notice" role="status">{notice}</p> : null}
    {error ? <p className="nd-appearance-error" role="alert">{error}</p> : null}
  </div>;
}
