import { useEffect, useMemo, useRef, useState } from 'react';
import { api, apiUpload, ApiError } from '../../api';
import type { Outfit } from '../../types';
import { assetLocked, outfitWritePolicy } from './preset-lock.js';
import { appearanceAssetUrl } from '../../types';
import { Button, Field, LoadingNote, Select } from '../../ui';
import { Sheet } from '../config/sheet/Sheet';
import { useSheet } from '../config/sheet/sheet-context';
import { useWrite } from '../config/write-runner';
import { T22, T25, T27, T29, T31, T36 } from '../config/config-texts.js';
import { announceLive } from '../../ui/live-announcer';
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
  canWrite?: boolean;
  onChanged?: () => void;
  onPreview?: (outfit: Outfit) => void;
  onPreviewAsset?: (assetId: string) => void;
  /** 兼容旧调用方：写入已统一走 WriteProvider 的暂停管线。 */
  guardWrite?: <T>(action: () => Promise<T>) => Promise<T>;
  pausedWrite?: boolean;
  /** 「去生图设置 →」跳转设置页的生图服务。 */
  onOpenImageSettings?: () => void;
};

const folderAttributes = {
  webdirectory: '',
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

/** 纸笺内的编辑草稿：只有名称与说明走草稿，其余素材操作即时写入。 */
type OutfitDraft = { name: string; description: string };

function draftOf(outfit: Outfit): OutfitDraft {
  return { name: outfit.name, description: outfit.description ?? '' };
}

function draftChanges(outfit: Outfit, draft: OutfitDraft): number {
  const saved = draftOf(outfit);
  return (draft.name.trim() !== saved.name ? 1 : 0) + (draft.description.trim() !== saved.description ? 1 : 0);
}

export function AppearancePanel({
  roleId,
  canWrite = true,
  onChanged,
  onPreview,
  onPreviewAsset,
  pausedWrite = false,
  onOpenImageSettings,
}: Props) {
  const { sheet, open, requestClose, setDirty, setBusy } = useSheet();
  const write = useWrite();
  const [items, setItems] = useState<Outfit[]>([]);
  const [currentOutfitId, setCurrentOutfitId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<OutfitDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const renameInput = useRef<HTMLInputElement>(null);

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
    try {
      const result = await api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`);
      if (isStale(token)) return;
      setItems(result.items);
      setError('');
    } catch (e) {
      if (isStale(token)) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!isStale(token)) setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setItems([]); setError(''); setNotice(''); setLoading(true);
    setScan(null); setMerges({}); setRenames({}); setHomePicks({}); setImportFailures({}); setImportedIds({});
    void api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`).then(result => {
      if (!active) return;
      setItems(result.items);
      setLoading(false);
    }).catch(e => {
      if (active) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
    });
    // 当前穿着用于卡片状态点；读不到时不显示状态，不影响衣柜本身。
    void api<{ state: Record<string, unknown> }>(`/v1/roles/${encodeURIComponent(roleId)}/state`).then(result => {
      if (active) setCurrentOutfitId(typeof result.state.outfitId === 'string' ? result.state.outfitId : null);
    }).catch(() => { /* 状态读取失败只是少了「当前服饰」标记。 */ });
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
    if (ready.length === 0 || write.busy || !canWrite) return;
    const token = roleToken.current;
    setNotice(''); setError('');
    const imported: string[] = [];
    const failed: string[] = [];
    const importedIds: string[] = [];
    const failureDetails: Record<string, string> = {};
    setBusy(true);
    try {
      for (const plan of ready) {
        const form = new FormData();
        form.append('name', plan.name);
        const home = homeFor(plan);
        if (home) form.append('home', home, home.name);
        for (const sprite of plan.sprites) form.append('sprites', sprite, sprite.name);
        const result = await write.runWrite({
          roleIds: [roleId],
          verb: '导入服饰',
          commit: async () => {
            await apiUpload<Outfit>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`, form);
          },
        });
        if (result.ok) {
          imported.push(plan.name);
          importedIds.push(plan.id);
        } else {
          const reason = result.failure.message;
          failed.push(`「${plan.name}」${reason}`);
          failureDetails[plan.id] = reason;
        }
      }
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
      if (!isStale(token)) setBusy(false);
    }
  };

  const activeOutfit = sheet !== null && sheet.id.startsWith('outfit:')
    ? items.find(item => item.outfitId === sheet.id.slice('outfit:'.length)) ?? null
    : null;
  const activePolicy = outfitWritePolicy(activeOutfit);
  const presetLocked = !!activeOutfit && activeOutfit.isPreset === true;
  const dirtyCount = activeOutfit && draft ? draftChanges(activeOutfit, draft) : 0;

  // 草稿改动同步到纸笺状态：关闭时才会出 T9 确认，页脚才会出 T8。
  useEffect(() => {
    setDirty(dirtyCount > 0, dirtyCount);
  }, [dirtyCount, setDirty]);

  const openOutfit = (outfit: Outfit, trigger: HTMLElement) => {
    setDraft(draftOf(outfit));
    setConfirmDelete(false);
    setError(''); setNotice('');
    open({ id: `outfit:${outfit.outfitId}`, title: '编辑服饰', shape: 'full', anchor: trigger });
    onPreview?.(outfit);
  };

  const errorMessage = (reason: unknown) => reason instanceof ApiError && reason.code === 'LAST_OUTFIT_REQUIRED'
    ? T27
    : reason instanceof ApiError && reason.code === 'ROLE_NOT_STOPPED'
      ? '角色尚未停止，请先到角色状态中停止。'
      : reason instanceof ApiError && reason.code === 'PRESET_APPEARANCE_LOCKED'
        ? '预置服饰与素材随应用交付，不能改名、替换或删除；可以新增自己的服饰。'
        : reason instanceof Error ? reason.message : String(reason);

  const saveOutfit = async () => {
    if (!activeOutfit || !draft || write.busy || !canWrite) return;
    const name = draft.name.trim();
    if (!name) return;
    const description = draft.description.trim();
    const changes = draftChanges(activeOutfit, draft);
    if (changes === 0) return;
    setBusy(true);
    const result = await write.runWrite({
      roleIds: [roleId],
      verb: '保存服饰',
      commit: async () => {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}`, {
          method: 'PATCH',
          body: { name, description: description.length === 0 ? null : description },
        });
      },
    });
    setBusy(false);
    if (!result.ok) { setError(result.failure.message); return; }
    setDirty(false);
    announceLive(`已保存服饰「${name}」`);
    // 以服务端返回的列表为准更新卡片与草稿，避免用旧的 items 把草稿又算成脏。
    const list = await api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`).catch(() => null);
    if (isStale(roleToken.current)) return;
    if (list !== null) setItems(list.items);
    const refreshed = list?.items.find(item => item.outfitId === activeOutfit.outfitId);
    setDraft(refreshed ? draftOf(refreshed) : { name, description });
    // 先让外层清掉旧预览，再把纸笺当前服饰设为左页预览：左页在纸笺打开期间始终显示正在编辑的那套。
    onChanged?.();
    if (refreshed) onPreview?.(refreshed);
  };

  const deleteOutfit = async () => {
    if (!activeOutfit || write.busy || !canWrite || items.length <= 1) return;
    setBusy(true);
    const removedName = activeOutfit.name;
    const result = await write.runWrite({
      roleIds: [roleId],
      verb: '删除服饰',
      commit: async () => {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}`, { method: 'DELETE' });
      },
    });
    setBusy(false);
    if (!result.ok) { setError(result.failure.message); return; }
    setConfirmDelete(false);
    announceLive(`已删除服饰「${removedName}」`);
    requestClose();
    await load();
    if (!isStale(roleToken.current)) onChanged?.();
  };

  const uploadSprite = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || write.busy || !canWrite || !activeOutfit) return;
    if (!activePolicy.uploadSprite) { setError('预置服饰不能补传差分，请选择自己的服饰。'); return; }
    setBusy(true); setError(''); setNotice('');
    const result = await write.runWrite({
      roleIds: [roleId],
      verb: '上传差分',
      commit: async () => {
        const form = new FormData();
        form.append('sprite', file, file.name);
        await apiUpload(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}/sprites`, form);
      },
    });
    setBusy(false);
    if (spriteInput.current) spriteInput.current.value = '';
    if (!result.ok) { setError(result.failure.message); return; }
    setNotice(`已添加差分「${file.name.replace(/\.[^.]+$/, '')}」`);
    await load();
    if (!isStale(roleToken.current)) onChanged?.();
  };

  const replaceHome = async (file: File) => {
    if (!activeOutfit || write.busy || !canWrite || !activePolicy.replaceHome) return;
    setBusy(true); setError(''); setNotice('');
    const result = await write.runWrite({
      roleIds: [roleId],
      verb: '更新主页立绘',
      commit: async () => {
        const body = new FormData();
        body.append('home', file, file.name);
        await apiUpload(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}/home`, body);
      },
    });
    setBusy(false);
    if (homeInput.current) homeInput.current.value = '';
    if (!result.ok) { setError(result.failure.message); return; }
    setNotice('主页立绘已更新，历史句段保留原图。');
    await load();
    if (!isStale(roleToken.current)) onChanged?.();
  };

  const removeSprite = async (assetId: string, displayName: string) => {
    if (!activeOutfit || write.busy || !canWrite) return;
    setBusy(true); setError(''); setNotice('');
    const result = await write.runWrite({
      roleIds: [roleId],
      verb: '删除差分',
      commit: async () => {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}/sprites/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
      },
    });
    setBusy(false);
    if (!result.ok) { setError(result.failure.message); return; }
    announceLive(`已删除差分「${displayName}」`);
    setNotice('差分已删除，历史引用的素材会保留。');
    await load();
    if (!isStale(roleToken.current)) onChanged?.();
  };

  const skippedSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of scan?.skipped ?? []) {
      counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    }
    return [...counts.entries()].map(([reason, count]) => `${SKIP_REASON_LABELS[reason] ?? reason} ${count}`);
  }, [scan]);

  const sheetFooter = activeOutfit ? (confirmDelete
    ? <div className="config-sheet-actions">
      {error && <p className="config-sheet-error" role="alert">{error}</p>}
      <span className="config-sheet-spacer" />
      <button type="button" disabled={write.busy} onClick={() => { setConfirmDelete(false); setError(''); }}>{T31.cancel}</button>
      <Button variant="danger" busy={write.busy} disabled={write.busy || items.length <= 1} onClick={() => void deleteOutfit()}>
        {write.busy ? T29.deleting : pausedWrite ? T31.pauseAndDelete : T31.delete}
      </Button>
    </div>
    : <div className="config-sheet-actions">
      {error && <p className="config-sheet-error" role="alert">{error}</p>}
      {!error && notice && <p className="config-sheet-note" role="status">{notice}</p>}
      <span className="config-sheet-spacer" />
      <button type="button" disabled={write.busy} onClick={() => requestClose()}>{T31.cancel}</button>
      <Button
        disabled={write.busy || !canWrite || presetLocked || dirtyCount === 0 || !draft?.name.trim()}
        busy={write.busy}
        onClick={() => void saveOutfit()}
      >{write.busy ? T29.saving : '保存'}</Button>
    </div>) : null;

  return <div className="nd-appearance">
    <input ref={folderInput} type="file" multiple {...folderAttributes} className="nd-visually-hidden" onChange={event => scanFolder(event.target.files)} />

    {loading ? <LoadingNote label="正在读取衣柜…" /> : <>
      {items.length === 0 && scan === null ? <p className="config-sheet-note config-wardrobe-empty">{T36.kind('服饰')}</p> : null}
      <div className="config-outfit-grid">
        {items.map(outfit => {
          const wearing = outfit.outfitId === currentOutfitId;
          return <button
            key={outfit.outfitId}
            type="button"
            className="config-outfit-card"
            data-edit={outfit.outfitId}
            title={outfit.name}
            aria-label={`编辑服饰：${outfit.name}`}
            onClick={event => openOutfit(outfit, event.currentTarget)}
          >
            <span className="config-outfit-thumb">
              {outfit.home ? <img src={appearanceAssetUrl(roleId, outfit.home.assetId)} alt="" /> : <i>{T22}</i>}
            </span>
            <span className="config-outfit-meta">
              <strong>{outfit.name}</strong>
              <span className="config-outfit-state" data-wearing={wearing || undefined} role="img" aria-label={wearing ? '当前服饰' : '可穿'} title={wearing ? '当前服饰' : '可穿'}><i aria-hidden="true" /></span>
            </span>
            <small>{outfit.sprites.length} 张差分{outfit.isPreset ? ' · 预置' : ''}</small>
            <span className="config-outfit-edit" aria-hidden="true">编辑</span>
          </button>;
        })}
        <button type="button" className="config-outfit-card config-outfit-new" disabled={!canWrite || write.busy} onClick={() => folderInput.current?.click()}>
          <span className="config-outfit-thumb"><i>＋</i></span>
          <strong>导入服饰</strong>
          <small>选择角色素材文件夹</small>
        </button>
      </div>
    </>}

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
        <Button variant="primary" disabled={write.busy || !canWrite || summary.ready === 0} onClick={() => void confirmImport()}>
          {write.busy ? '正在导入…' : `${pausedWrite ? '暂停并导入' : '确认导入'} ${summary.ready} 套`}
        </Button>
        <Button disabled={write.busy} onClick={cancelScan}>取消</Button>
        {pausedWrite ? <small className="nd-appearance-hint">导入时会先暂停角色。</small> : null}
      </div>
    </section> : null}

    {notice && scan === null ? <p className="config-sheet-note" role="status">{notice}</p> : null}
    {error && scan === null ? <p className="config-sheet-error" role="alert">{error}</p> : null}

    <Sheet idPrefix="outfit:" footer={sheetFooter}>
      {activeOutfit && draft ? (confirmDelete
        ? <div className="config-sheet-groups">
          <div className="config-grp" data-sheet-group>
            <div className="config-grp-label"><b>删除</b></div>
            <div>
              <p className="config-sheet-ask">{T31.outfit.ask(activeOutfit.name)}</p>
              {activeOutfit.outfitId === currentOutfitId && <p className="config-sheet-note">{T31.outfit.current}</p>}
              <button type="button" className="config-sheet-link" data-sheet-focus onClick={() => { setConfirmDelete(false); requestAnimationFrame(() => renameInput.current?.focus()); }}>返回编辑</button>
            </div>
          </div>
        </div>
        : <div className="config-sheet-groups">
          <div className="config-grp" data-sheet-group>
            <div className="config-grp-label"><b>服饰</b></div>
            <div className="config-outfit-hero">
              <span className="config-outfit-hero-thumb">
                {activeOutfit.home ? <img src={appearanceAssetUrl(roleId, activeOutfit.home.assetId)} alt="" /> : <i>{T22}</i>}
              </span>
              <div className="config-grp-fields">
                <Field label="名称">
                  <input ref={renameInput} className="ui-input" data-sheet-focus value={draft.name} maxLength={200} disabled={write.busy || presetLocked} onChange={event => setDraft({ ...draft, name: event.target.value })} />
                </Field>
                <Field label="说明">
                  <textarea className="ui-textarea" rows={3} maxLength={500} value={draft.description} disabled={write.busy || presetLocked} onChange={event => setDraft({ ...draft, description: event.target.value })} />
                </Field>
                {presetLocked && <p className="config-sheet-note">预置服饰随应用交付，不能改名、替换立绘或删除；可以新增自己的服饰。</p>}
              </div>
            </div>
          </div>

          <div className="config-grp">
            <div className="config-grp-label"><b>差分</b><small>{activeOutfit.sprites.length} 张</small></div>
            <div>
              <div className="config-faces">
                {activeOutfit.sprites.slice(0, 6).map(sprite => <button key={sprite.assetId} type="button" className="config-face" title={sprite.displayName} aria-label={`查看差分：${sprite.displayName}`} onClick={() => onPreviewAsset?.(sprite.assetId)}>
                  <img src={appearanceAssetUrl(roleId, sprite.assetId)} alt="" />
                </button>)}
                {activeOutfit.sprites.length > 6 ? <span className="config-face config-face-more">+{activeOutfit.sprites.length - 6}</span> : null}
              </div>
              <div className="config-sheet-row">
                <input ref={spriteInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => void uploadSprite(event.target.files)} />
                <input ref={homeInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void replaceHome(file); }} />
                <Button disabled={write.busy || !canWrite || !activePolicy.uploadSprite} onClick={() => spriteInput.current?.click()}>上传差分</Button>
                <Button disabled={write.busy || !canWrite || !activePolicy.replaceHome} onClick={() => homeInput.current?.click()}>{activeOutfit.home ? '替换主页立绘' : '补传主页立绘'}</Button>
              </div>
              {activeOutfit.sprites.length > 0 && <ul className="config-sprite-list">
                {activeOutfit.sprites.map(sprite => <li key={sprite.assetId}>
                  <button type="button" className="config-sprite-open" onClick={() => onPreviewAsset?.(sprite.assetId)}>{sprite.displayName}</button>
                  <button type="button" disabled={write.busy || !canWrite || assetLocked(sprite)} onClick={() => void removeSprite(sprite.assetId, sprite.displayName)}>删除</button>
                </li>)}
              </ul>}
            </div>
          </div>

          <div className="config-grp">
            <div className="config-grp-label"><b>生图锚点</b></div>
            <div>
              <button type="button" className="config-sheet-link" onClick={() => requestClose(() => onOpenImageSettings?.())}>{T25.image}</button>
            </div>
          </div>

          <div className="config-grp">
            <div className="config-grp-label"><b>删除</b></div>
            <div>
              <div className="config-danger-row">
                <Button
                  variant="danger"
                  disabled={write.busy || !canWrite || items.length <= 1 || presetLocked}
                  aria-describedby={items.length <= 1 ? 'outfit-last' : undefined}
                  onClick={() => { setConfirmDelete(true); setError(''); }}
                >删除服饰…</Button>
                {items.length <= 1 && <span className="config-sheet-note" id="outfit-last">{T27}</span>}
              </div>
            </div>
          </div>
        </div>): null}
    </Sheet>
  </div>;
}
