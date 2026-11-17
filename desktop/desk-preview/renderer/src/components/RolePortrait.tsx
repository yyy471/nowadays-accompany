import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Outfit, RoleStateResponse } from '../types';
import { appearanceAssetUrl } from '../types';
import { useMotionPolicy } from '../ui';

/**
 * 角色立绘缩略图：优先当前服饰，其次任意有主页图的服饰。
 * 没有任何主页图时显示明确空态，不回退到内置主题插画（DL-153）。
 */
export function RolePortrait({ roleId, version = 0, previewAssetId, cycle }: { roleId: string; version?: number; previewAssetId?: string; cycle?: string }) {
  const [url, setUrl] = useState('');
  const [previousUrl, setPreviousUrl] = useState('');
  const lastUrl = useRef('');
  const stageChoice = useRef<{ roleId: string; cycle?: string; assetId: string }>({ roleId: '', assetId: '' });
  const motion = useMotionPolicy();
  useEffect(() => {
    let live = true;
    if (previewAssetId) { stageChoice.current = { roleId, cycle, assetId: previewAssetId }; setUrl(appearanceAssetUrl(roleId, previewAssetId)); return; }
    if (stageChoice.current.roleId !== roleId) setUrl('');
    if (roleId) Promise.allSettled([api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`), api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`)]).then(([outfits, state]) => {
      if (!live || outfits.status !== 'fulfilled') return;
      const available = outfits.value.items.filter(item => item.home);
      const current = state.status === 'fulfilled' ? state.value.state.outfitId : null;
      const prior = stageChoice.current;
      const reroll = cycle !== undefined && prior.roleId === roleId && prior.cycle !== cycle;
      const pool = reroll && available.length > 1 ? available.filter(item => item.home?.assetId !== prior.assetId) : [];
      const picked = pool.length ? pool[Math.floor(Math.random() * pool.length)] : available.find(item => item.outfitId === current) || available[0];
      const asset = picked?.home;
      stageChoice.current = { roleId, cycle, assetId: asset?.assetId || '' };
      setUrl(asset ? appearanceAssetUrl(roleId, asset.assetId) : '');
    });
    return () => { live = false; };
  }, [roleId, version, previewAssetId, cycle]);
  useEffect(() => {
    const old = lastUrl.current; lastUrl.current = url;
    if (!url || !old || old === url || motion.reduced) { setPreviousUrl(''); return; }
    setPreviousUrl(old);
    const timer = window.setTimeout(() => setPreviousUrl(''), 240);
    return () => window.clearTimeout(timer);
  }, [url, motion.reduced]);
  return <div className="config-portrait">{url ? <><img src={url} alt="角色立绘"/>{previousUrl && <img className="config-portrait-old" src={previousUrl} alt="" aria-hidden="true"/>}</> : <span>还没有配置立绘</span>}</div>;
}
