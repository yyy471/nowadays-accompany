import { errorText } from '../../lib/error-text';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, apiUpload, ApiError } from '../../api';
import type { Outfit, OutfitAsset, RoleStateResponse } from '../../types';
import { appearanceAssetUrl } from '../../types';
import { Button, createMotionScope, Field, Select, useMotionPolicy } from '../../ui';
import { PhotoDevelopment, PhotoImage } from '../../ui/photo-development';
import { Sheet } from '../config/sheet/Sheet';
import { animateSheetExit } from '../config/sheet/sheet-motion';
import { useSheet } from '../config/sheet/sheet-context';
import { MediaStateRow, RoleSaveActions } from '../config/MediaSheet';
import { ConfigNotice } from '../config/ConfigNotice';
import { useWrite } from '../config/write-runner';
import { T22, T25, T27, T29, T31, T36 } from '../config/config-texts';
import { announceLive } from '../../ui/live-announcer';
import {
  markImportedPlans,
  mergeOutfitEntries,
  planOutfitImport,
  scanAppearanceFolder,
  summarizeOutfitPlan,
  type AppearanceImportPlan,
  type AppearanceScanResult,
} from '../../appearance-import';

type Props = {
  roleId: string;
  /** 只有当前激活的编辑器才能认领纸笺；访问过的角色会保留组件以保住草稿（R11-1）。 */
  active?: boolean;
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

/** 纸笺内的编辑草稿：服饰名称、说明与素材显示名走草稿，其余素材操作即时写入。 */
type OutfitDraft = { name: string; description: string; assetNames: Record<string, string> };
type OutfitUpload = { file: File; kind: 'home' | 'sprite'; replaceAssetId?: string | null };

function draftOf(outfit: Outfit): OutfitDraft {
  return { name: outfit.name, description: outfit.description ?? '', assetNames: {} };
}

function changedAssetNames(outfit: Outfit, draft: OutfitDraft): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const asset of [outfit.home, ...outfit.sprites]) {
    if (!asset) continue;
    const name = draft.assetNames[asset.assetId]?.trim();
    if (name !== undefined && name !== asset.displayName) changes[asset.assetId] = name;
  }
  return changes;
}

export function AppearancePanel({
  roleId,
  active = true,
  canWrite = true,
  onChanged,
  onPreview,
  onPreviewAsset,
  pausedWrite = false,
  onOpenImageSettings,
}: Props) {
  const { sheet, open, requestClose, closeNow, setDirty, setBusy } = useSheet();
  const write = useWrite();
  const { reduced } = useMotionPolicy();
  const [items, setItems] = useState<Outfit[]>([]);
  const [currentOutfitId, setCurrentOutfitId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const [error, setError] = useState('');
  const [deleteNotice, setDeleteNotice] = useState('');
  const [deleteNoticeKey, setDeleteNoticeKey] = useState(0);
  const [draft, setDraft] = useState<OutfitDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assetDelete, setAssetDelete] = useState<OutfitAsset | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState('');
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [assetUpload, setAssetUpload] = useState<{ input: OutfitUpload; pending: boolean; error: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const replacingSprite = useRef<string | null>(null);
  const [confirmationMotion] = useState(createMotionScope);
  const closingConfirmation = useRef<Animation | null>(null);
  const deleteTrigger = useRef('');
  const cancelConfirmation = () => {
    if (write.busy || closingConfirmation.current) return;
    const restore = () => {
      flushSync(() => { setConfirmDelete(false); setAssetDelete(null); setError(''); setBusy(false); });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`.config-sheet [data-delete-trigger="${CSS.escape(deleteTrigger.current)}"]`)?.focus({ preventScroll: true });
      }));
    };
    const frame = document.querySelector<HTMLElement>('.config-sheet[data-shape="confirm"]');
    const animation = frame && !reduced ? animateSheetExit(frame, confirmationMotion) : null;
    if (!animation) { restore(); return; }
    closingConfirmation.current = animation;
    setBusy(true);
    void animation.finished.then(() => {
      closingConfirmation.current = null;
      restore();
      animation.cancel();
    }, () => {});
  };
  useEffect(() => () => confirmationMotion.cancelAll(), [confirmationMotion]);
  useEffect(() => { if (reduced) closingConfirmation.current?.finish(); }, [reduced]);
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
      return result.items;
    } catch (e) {
      if (isStale(token)) return;
      setError(errorMessage(e));
    } finally {
      if (!isStale(token)) setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setItems([]); setError(''); setReadError(''); setLoading(true);
    setScan(null); setMerges({}); setRenames({}); setHomePicks({}); setImportFailures({}); setImportedIds({});
    void api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`).then(result => {
      if (!active) return;
      setItems(result.items);
      setLoading(false);
    }).catch(e => {
      if (active) { setReadError(errorMessage(e)); setLoading(false); }
    });
    // 当前穿着用于卡片状态点；读不到时不显示状态，不影响衣柜本身。
    void api<{ state: Record<string, unknown> }>(`/v1/roles/${encodeURIComponent(roleId)}/state`).then(result => {
      if (active) setCurrentOutfitId(typeof result.state.outfitId === 'string' ? result.state.outfitId : null);
    }).catch(() => { /* 状态读取失败只是少了「当前服饰」标记。 */ });
    return () => { active = false; };
  }, [roleId, readAttempt]);

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
    setError('');
    if (folderInput.current) folderInput.current.value = '';
    if (result.entries.length === 0) {
      setError('请选择包含 standees 或 expressions 的角色素材文件夹。');
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
    setError('');
    const imported: string[] = [];
    const failed: string[] = [];
    const importedIds: string[] = [];
    const failureDetails: Record<string, string> = {};
    setBusy(true);
    setImporting(true);
    try {
      for (const plan of ready) {
        const form = new FormData();
        form.append('name', plan.name);
        const home = homeFor(plan);
        if (home) form.append('home', home, home.name);
        for (const sprite of plan.sprites) form.append('sprites', sprite, sprite.name);
        const result = await write.runWrite({
          errorMessage,
          verb: '导入服饰',
          announceSuccess: false,
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
      write.reportResult(parts.join('。'), failed.length ? 'warning' : 'success');
      // 部分失败时保留预览：已成功的服饰重读后会显示为重名，
      // 原处再次导入只提交仍未成功的套（283 R09）。
      if (failed.length === 0) cancelScan();
      await load(token);
      if (isStale(token)) return;
      if (failed.length > 0) {
        // load 会清掉通用错误；逐套原因保存在 importFailures 里，这里再给摘要。
        setError(`列表中可查看 ${failed.length} 套服饰的失败原因，再次导入时会重试这些服饰。`);
      }
      onChanged?.();
    } finally {
      if (!isStale(token)) { setBusy(false); setImporting(false); }
    }
  };

  const ownsSheet = active && Boolean(sheet?.id.startsWith('outfit:'));
  const activeOutfit = ownsSheet && sheet
    ? items.find(item => item.outfitId === sheet.id.slice('outfit:'.length)) ?? null
    : null;
  const assets = activeOutfit ? [activeOutfit.home, ...activeOutfit.sprites].filter((asset): asset is OutfitAsset => asset !== null) : [];
  const previewAsset = assets.find(asset => asset.assetId === previewAssetId) ?? activeOutfit?.home;
  const selectedAsset = assets.find(asset => asset.assetId === selectedAssetId) ?? assets[0];
  const assetNames = activeOutfit && draft ? changedAssetNames(activeOutfit, draft) : {};
  const invalidAssetName = Object.values(assetNames).includes('');
  const dirtyCount = activeOutfit && draft
    ? Number(draft.name.trim() !== activeOutfit.name) + Number(draft.description.trim() !== (activeOutfit.description ?? '')) + Object.keys(assetNames).length
    : 0;

  // 草稿改动同步到纸笺状态：关闭时才会出 T9 确认，页脚才会出 T8。
  useEffect(() => {
    if (ownsSheet) { setDirty(dirtyCount > 0, dirtyCount); setBusy(write.busy); }
  }, [ownsSheet, dirtyCount, write.busy, setBusy, setDirty]);

  const openOutfit = (outfit: Outfit, trigger: HTMLElement) => {
    setDraft(draftOf(outfit));
    setSelectedAssetId('');
    setPreviewAssetId(null); setAssetUpload(null);
    setConfirmDelete(false); setAssetDelete(null);
    setError('');
    open({ id: `outfit:${outfit.outfitId}`, title: '编辑服饰', shape: 'full', anchor: trigger, focusReturn: trigger });
    onPreview?.(outfit);
  };

  const locateAsset = (assetId: string) => {
    setPreviewAssetId(assetId);
    onPreviewAsset?.(assetId);
  };

  const errorMessage = (reason: unknown) => reason instanceof ApiError && reason.code === 'LAST_OUTFIT_REQUIRED'
    ? T27
    : reason instanceof ApiError && reason.code === 'ROLE_NOT_STOPPED'
      ? '请先在「角色状态」停止角色活动，再试一次。'
      : errorText(reason);

  const saveOutfit = async () => {
    if (!activeOutfit || !draft || write.busy || !canWrite) return;
    const name = draft.name.trim();
    if (!name || invalidAssetName) return;
    const description = draft.description.trim();
    if (dirtyCount === 0) return;
    const token = roleToken.current;
    setBusy(true);
    const result = await write.runWrite({
      errorMessage,
      verb: '保存服饰',
      announceSuccess: false,
      commit: async () => {
        const saved = await api<Outfit>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}`, {
          method: 'PATCH',
          body: { name, description: description.length === 0 ? null : description, ...(Object.keys(assetNames).length ? { assetNames } : {}) },
        });
        if (isStale(token)) return;
        setItems(previous => previous.map(outfit => outfit.outfitId === saved.outfitId ? saved : outfit));
        setDraft(draftOf(saved));
      },
    });
    if (!result.ok) { setBusy(false); setError(result.failure.message); return; }
    if (isStale(token)) return;
    // 先让外层清掉旧预览，再把纸笺当前服饰设为左页预览：左页在纸笺打开期间始终显示正在编辑的那套。
    onChanged?.();
    closeNow(undefined, '已保存服饰');
  };

  const deleteOutfit = async () => {
    if (!activeOutfit || write.busy || closingConfirmation.current || !canWrite || items.length <= 1) return;
    setBusy(true);
    const removedName = activeOutfit.name;
    const currentRemoved = activeOutfit.outfitId === currentOutfitId;
    const result = await write.runWrite({
      roleIds: [roleId],
      errorMessage,
      verb: '删除服饰',
      announceSuccess: false,
      commit: async () => {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}`, { method: 'DELETE' });
      },
    });
    setBusy(false);
    if (!result.ok) { setError(result.failure.message); return; }
    setConfirmDelete(false);
    closeNow(() => {
      const token = roleToken.current;
      const current = currentRemoved ? api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`).catch(() => null) : Promise.resolve(null);
      void Promise.all([load(token), current]).then(([wardrobe, state]) => {
        if (isStale(token)) return;
        const next = wardrobe?.find(item => item.outfitId === state?.state.outfitId);
        if (next) setCurrentOutfitId(next.outfitId);
        const text = next ? `已删除「${removedName}」，现在穿着「${next.name}」` : `已删除服饰「${removedName}」`;
        setDeleteNoticeKey(v => v + 1); setDeleteNotice(text); announceLive(text); onChanged?.();
      });
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.config-leaf-body .config-prose:not([hidden]) h2')?.focus({ preventScroll: true }));
    });
  };

  const uploadAsset = async (input: OutfitUpload) => {
    if (!activeOutfit || write.busy || !canWrite || assetUpload?.pending) return;
    const { file, kind, replaceAssetId } = input;
    const outfitId = activeOutfit.outfitId;
    const token = roleToken.current;
    const home = kind === 'home';
    setAssetUpload({ input, pending: true, error: '' });
    setBusy(true); setError('');
    const uploadResult: { asset?: OutfitAsset } = {};
    const result = await write.runWrite({
      errorMessage,
      verb: home ? '更新主页立绘' : replaceAssetId ? '替换差分' : '上传差分',
      announceSuccess: false,
      commit: async () => {
        const body = new FormData();
        body.append(kind, file, file.name);
        if (replaceAssetId) body.append('replaceAssetId', replaceAssetId);
        uploadResult.asset = await apiUpload<OutfitAsset>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(outfitId)}/${home ? 'home' : 'sprites'}`, body);
      },
    });
    if (isStale(token)) return;
    setBusy(false);
    if (!result.ok) {
      setAssetUpload({ input, pending: false, error: result.failure.message || '上传暂未完成，请再试一次。' });
      return;
    }
    const asset = uploadResult.asset;
    if (asset?.assetId) {
      setItems(previous => previous.map(outfit => outfit.outfitId !== outfitId ? outfit : home
        ? { ...outfit, home: asset }
        : { ...outfit, sprites: [...outfit.sprites.filter(sprite => sprite.assetId !== replaceAssetId), asset] }));
      setPreviewAssetId(asset.assetId);
    }
    setAssetUpload(null);
    write.reportResult(home ? '主页立绘已更新，历史句段保留原图。' : `已${replaceAssetId ? '替换' : '添加'}差分「${file.name.replace(/\.[^.]+$/, '')}」`);
    await load(token);
    if (!isStale(token)) onChanged?.();
  };

  const removeAsset = async ({ assetId, displayName, usage }: OutfitAsset) => {
    const label = usage === 'home' ? '主页立绘' : '差分';
    if (!activeOutfit || write.busy || closingConfirmation.current || !canWrite) return;
    setBusy(true); setError('');
    const result = await write.runWrite({
      roleIds: [roleId],
      errorMessage,
      verb: `删除${label}`,
      announceSuccess: false,
      commit: async () => {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(activeOutfit.outfitId)}/${usage === 'home' ? 'home' : 'sprites'}/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
      },
    });
    setBusy(false);
    if (!result.ok) { setError(result.failure.message); return; }
    setAssetDelete(null);
    const text = `已删除${label}「${displayName}」，历史引用的素材已保留。`;
    setDeleteNoticeKey(v => v + 1); setDeleteNotice(text); announceLive(text);
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

  const confirmationTitle = confirmDelete ? '删除服饰' : assetDelete ? (assetDelete.usage === 'home' ? '删除主页立绘' : '删除差分') : undefined;
  const sheetFooter = activeOutfit ? (confirmationTitle
    ? <div className="config-sheet-actions">
      {error && <p className="config-sheet-error" role="alert">{error}</p>}
      <span className="config-sheet-spacer" />
      <button type="button" data-sheet-focus disabled={write.busy} onClick={cancelConfirmation}>{T31.cancel}</button>
      <Button variant="danger" busy={write.busy} disabled={write.busy || (confirmDelete && items.length <= 1)}
        onClick={() => assetDelete ? void removeAsset(assetDelete) : void deleteOutfit()}>
        {write.busy ? write.phase === 'pause' ? T29.pausing : T29.deleting : error ? T29.retry('删除') : pausedWrite ? T31.pauseAndDelete : T31.delete}
      </Button>
    </div>
    : <RoleSaveActions count={dirtyCount} pause={false} busy={write.busy} invalid={!canWrite || invalidAssetName || !draft?.name.trim()} error={error} onSave={() => void saveOutfit()}/>) : null;

  return <div className="nd-appearance">
    <ConfigNotice message={deleteNotice} noticeKey={deleteNoticeKey} tone="success" onDismiss={() => setDeleteNotice('')}/>
    <input ref={folderInput} type="file" multiple {...folderAttributes} className="nd-visually-hidden" onChange={event => scanFolder(event.target.files)} />

    {loading ? <div className="config-outfit-grid" aria-busy="true" aria-label="正在读取衣柜">{[0, 1, 2].map(item => <div className="config-outfit-card config-skel" key={item} aria-hidden="true"><div className="config-outfit-thumb"/><i/><i className="short"/></div>)}</div>
      : readError ? <MediaStateRow label="衣柜" loading={false} error={readError} onRetry={() => setReadAttempt(value => value + 1)}/> : <>
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
          <strong>新服饰</strong>
        </button>
      </div>
    </>}

    {scan !== null ? <section className="nd-import" aria-label="导入预览">
      <div className="nd-import-summary">
        <b>识别到 {summary.total} 套服饰{scan.root ? `（${scan.root}）` : ''}</b>
        <small>可导入 {summary.ready} · 重名 {summary.duplicate} · 缺主页图 {summary.missingHome} · 缺差分 {summary.missingSprites} · 差分共 {summary.spriteCount} 张</small>
        {skippedSummary.length > 0 ? <small>已跳过：{skippedSummary.join('、')}</small> : null}
        {scan.issues.some(issue => issue.code === 'MULTIPLE_ROOTS') ? <small className="nd-import-warn">文件夹中有多个角色，本次只预览第一个角色的服饰。</small> : null}
      </div>
      <ul className="nd-import-list">
        {plans.map(plan => {
          const home = homeFor(plan);
          const thumb = home === null ? undefined : thumbs.get(home);
          const mergeTargets = plans.filter(other => other.id !== plan.id && (
            (plan.home === null && other.home !== null) || (plan.sprites.length === 0 && other.sprites.length > 0)
          ));
          return <li key={plan.id} className={'nd-import-item' + (plan.status === 'duplicate' ? ' duplicate' : '') + (plan.status === 'ready' ? '' : ' blocked')}>
            {thumb ? <PhotoImage key={thumb} className="nd-import-thumb" src={thumb} alt={`${plan.name}的立绘预览`} /> : <span className="nd-import-thumb">无主页图</span>}
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
      {importing && <PhotoDevelopment state="pending" pendingLabel="正在导入服饰，相纸显影中…" />}
      <div className="nd-appearance-actions">
        <Button variant="primary" disabled={write.busy || !canWrite || summary.ready === 0} onClick={() => void confirmImport()}>
          {write.busy ? '正在导入…' : `确认导入 ${summary.ready} 套`}
        </Button>
        <Button disabled={write.busy} onClick={cancelScan}>取消</Button>
      </div>
    </section> : null}

    {error && scan === null ? <p className="config-sheet-error" role="alert">{error}</p> : null}

    <Sheet idPrefix="outfit:" enabled={active} footer={sheetFooter} confirmationTitle={confirmationTitle} onCancelConfirmation={confirmationTitle ? cancelConfirmation : undefined}>
      {activeOutfit && draft ? (confirmationTitle
        ? <div className="config-sheet-groups">
          <div className="config-grp" data-sheet-group>
            <div className="config-grp-label"><b>删除</b></div>
            <div>
              <p className="config-sheet-ask">{assetDelete ? `删除「${assetDelete.displayName}」？历史消息里引用的图仍保留。` : T31.outfit.ask(activeOutfit.name)}</p>
              {confirmDelete && activeOutfit.outfitId === currentOutfitId && <p className="config-sheet-note">{T31.outfit.current}</p>}
            </div>
          </div>
        </div>
        : <div className="config-sheet-groups">
          <div className="config-grp" data-sheet-group>
            <div className="config-grp-label"><b>服饰</b></div>
            <div className="config-outfit-hero">
              {previewAsset ? <PhotoImage key={previewAsset.assetId} className="config-outfit-hero-thumb"
                src={appearanceAssetUrl(roleId, previewAsset.assetId)} alt={previewAsset.displayName || activeOutfit.name} />
                : <span className="config-outfit-hero-thumb"><i>{T22}</i></span>}
              <div className="config-grp-fields">
                <Field label="名称">
                  <input ref={renameInput} className="ui-input" data-sheet-focus value={draft.name} maxLength={200} disabled={write.busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />
                </Field>
                <Field label="说明">
                  <textarea className="ui-textarea" rows={3} maxLength={500} value={draft.description} disabled={write.busy} onChange={event => setDraft({ ...draft, description: event.target.value })} />
                </Field>
              </div>
            </div>
          </div>

          <div className="config-grp">
            <div className="config-grp-label"><b>差分</b><small>{activeOutfit.sprites.length} 张</small></div>
            <div>
              <div className="config-faces">
                {activeOutfit.sprites.slice(0, 6).map(sprite => <button key={sprite.assetId} type="button" className="config-face" title={sprite.displayName} aria-label={`查看差分：${sprite.displayName}`} onClick={() => locateAsset(sprite.assetId)}>
                  <img src={appearanceAssetUrl(roleId, sprite.assetId)} alt="" />
                </button>)}
                {activeOutfit.sprites.length > 6 ? <span className="config-face config-face-more">+{activeOutfit.sprites.length - 6}</span> : null}
              </div>
              <div className="config-sheet-row">
                <input ref={spriteInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => {
                  const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
                  const replaceAssetId = replacingSprite.current; replacingSprite.current = null;
                  if (file) void uploadAsset({ file, kind: 'sprite', replaceAssetId });
                }} />
                <input ref={homeInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => {
                  const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
                  if (file) void uploadAsset({ file, kind: 'home' });
                }} />
                <Button disabled={write.busy || !canWrite || assetUpload?.pending} onClick={() => { replacingSprite.current = null; spriteInput.current?.click(); }}>上传差分</Button>
                <Button disabled={write.busy || !canWrite || assetUpload?.pending} onClick={() => homeInput.current?.click()}>{activeOutfit.home ? '替换主页立绘' : '补传主页立绘'}</Button>
              </div>
              {assetUpload && <div className="config-outfit-upload">
                {assetUpload.pending ? <PhotoDevelopment state="pending" pendingLabel={`正在上传 ${assetUpload.input.file.name}…`} />
                  : <PhotoDevelopment state="failed" failureLabel="图片上传失败" reason={assetUpload.error} onRetry={canWrite && !write.busy ? () => void uploadAsset(assetUpload.input) : undefined} />}
              </div>}
              {selectedAsset && <div className="config-grp-fields">
                <Field label="编辑素材">
                  <Select aria-label="编辑素材" value={selectedAsset.assetId} onChange={event => setSelectedAssetId(event.target.value)}>
                    {assets.map(asset => <option key={asset.assetId} value={asset.assetId}>{asset.usage === 'home' ? '立绘' : '差分'} · {asset.displayName}</option>)}
                  </Select>
                </Field>
                <Field label="素材显示名">
                  <input className="ui-input" aria-label="素材显示名" maxLength={100} disabled={write.busy || !canWrite} value={draft.assetNames[selectedAsset.assetId] ?? selectedAsset.displayName}
                    onChange={event => setDraft({ ...draft, assetNames: { ...draft.assetNames, [selectedAsset.assetId]: event.target.value } })}/>
                </Field>
                <div className="config-sheet-row">{selectedAsset.usage === 'home'
                  ? <Button data-delete-trigger={selectedAsset.assetId} disabled={write.busy || !canWrite} onClick={() => { deleteTrigger.current = selectedAsset.assetId; setAssetDelete(selectedAsset); setError(''); }}>删除主页立绘</Button>
                  : <Button disabled={write.busy || !canWrite} onClick={() => { replacingSprite.current = selectedAsset.assetId; spriteInput.current?.click(); }}>替换此差分</Button>}</div>
              </div>}
              {activeOutfit.sprites.length > 0 && <ul className="config-sprite-list">
                {activeOutfit.sprites.map(sprite => <li key={sprite.assetId}>
                  <button type="button" className="config-sprite-open" onClick={() => locateAsset(sprite.assetId)}>{sprite.displayName}</button>
                  <button type="button" data-delete-trigger={sprite.assetId} disabled={write.busy || !canWrite} onClick={() => { deleteTrigger.current = sprite.assetId; setAssetDelete(sprite); setError(''); }}>删除</button>
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
                  disabled={write.busy || !canWrite || items.length <= 1}
                  aria-describedby={items.length <= 1 ? 'outfit-last' : undefined}
                  data-delete-trigger="outfit"
                  onClick={() => { deleteTrigger.current = 'outfit'; setConfirmDelete(true); setError(''); }}
                >删除服饰…</Button>
                {items.length <= 1 && <span className="config-sheet-note" id="outfit-last">{T27}</span>}
              </div>
            </div>
          </div>
        </div>): null}
    </Sheet>
  </div>;
}
