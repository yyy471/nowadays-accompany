import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Outfit, RoleStateResponse } from '../types';
import { appearanceAssetUrl } from '../types';
import { useMotionPolicy } from '../ui';

type PortraitImages = { current: string; previous: string; pending: string };
const emptyImages: PortraitImages = { current: '', previous: '', pending: '' };

/**
 * 角色立绘缩略图：优先当前服饰，其次任意有主页图的服饰。
 * 没有任何主页图时显示明确空态，不回退到内置主题插画（DL-153）。
 */
export function RolePortrait({ roleId, version = 0, previewAssetId, onOutfitName }: { roleId: string; version?: number; previewAssetId?: string | null; onOutfitName?: (name: string) => void }) {
  const [images, setImages] = useState<PortraitImages>(emptyImages);
  const currentRole = useRef('');
  // 立绘框上方只写当前服饰名（规范 §二.1）；回调用 ref 保存避免每次渲染重触发读取。
  const reportName = useRef(onOutfitName);
  reportName.current = onOutfitName;
  const { reduced } = useMotionPolicy();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  useEffect(() => {
    let live = true;
    if (currentRole.current !== roleId) { currentRole.current = roleId; setImages(emptyImages); }
    const show = (assetId?: string) => {
      const next = assetId ? appearanceAssetUrl(roleId, assetId) : '';
      setImages(previous => {
        if (!next) return emptyImages;
        if (next === previous.current) return { ...previous, pending: '' };
        if (next === previous.previous) return { current: next, previous: reducedRef.current ? '' : previous.current, pending: '' };
        return { ...previous, pending: next };
      });
    };
    if (previewAssetId !== undefined) { show(previewAssetId ?? undefined); return; }
    if (roleId) Promise.allSettled([api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`), api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`)]).then(([outfits, state]) => {
      if (!live || outfits.status !== 'fulfilled') return;
      const available = outfits.value.items.filter(item => item.home);
      const current = state.status === 'fulfilled' ? state.value.state.outfitId : null;
      const picked = (reportName.current ? outfits.value.items : available).find(item => item.outfitId === current) || available[0];
      show(picked?.home?.assetId);
      reportName.current?.(picked?.name ?? '');
    });
    return () => { live = false; };
  }, [roleId, version, previewAssetId]);
  useEffect(() => { if (reduced) setImages(previous => previous.previous ? { ...previous, previous: '' } : previous); }, [reduced]);
  const ready = (url: string, image: HTMLImageElement) => {
    void image.decode().then(() => {
      setImages(previous => previous.pending === url
        ? { current: url, previous: reducedRef.current ? '' : previous.current, pending: '' }
        : previous);
    }, () => setImages(previous => previous.pending === url ? { ...previous, pending: '' } : previous));
  };
  // 预备和显示使用同一个 img 节点；等新图可绘制后，旧图才开始淡出。
  return <div className="config-portrait">
    {[images.current, images.previous, images.pending].filter(Boolean).map(url => {
      const pending = url === images.pending;
      const previous = url === images.previous;
      return <img key={url} src={url} alt={pending || previous ? '' : '角色立绘'}
        aria-hidden={pending || previous || undefined} className={pending ? 'config-portrait-pending' : previous ? 'config-portrait-old' : undefined}
        onLoad={pending ? event => ready(url, event.currentTarget) : undefined}
        onError={pending ? () => setImages(state => state.pending === url ? { ...state, pending: '' } : state) : undefined}
        onAnimationEnd={previous ? () => setImages(state => state.previous === url ? { ...state, previous: '' } : state) : undefined}/>;
    })}
    {!images.current && <span>还没有立绘</span>}
  </div>;
}
