import { useEffect, useRef, useState } from 'react';
import type { PerformanceSnapshot, PerfScene, SceneLayerMode } from './performance.js';
import type { PerfRow } from './history.js';
import { spriteForRow } from './window-model.js';
import { Icon, useMotionPolicy } from '../ui';

export interface StageSources {
  /** 当前默认背景（随明暗主题）。 */
  backgroundUrl: string;
  /** 句段当轮保存的主页立绘快照。 */
  segmentHomeUrl?: string | null;
  /** 当前服饰的主页立绘。 */
  outfitUrl?: string | null;
  /** 主题角色图。 */
  themeUrl?: string | null;
  /** 句段差分素材按真实素材编号解析为图片地址。 */
  resolveSprite?: (assetId: string) => string;
}

function decodeImage(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('decode'));
    image.src = src;
  });
}

/** 双缓冲图层：新图解码成功后淡入，旧图留在非活动缓冲槽。 */
function CrossfadeLayer({ src, alt, className, onDecodeError }: { src: string | null; alt: string; className: string; onDecodeError?: (src: string) => void }) {
  const [slots, setSlots] = useState<[string, string]>([src ?? '', '']);
  const [active, setActive] = useState(0);
  const generation = useRef(0);
  const errorRef = useRef(onDecodeError);
  errorRef.current = onDecodeError;
  useEffect(() => {
    const version = ++generation.current;
    if (!src) { if (slots[0] || slots[1]) setSlots(['', '']); if (active !== 0) setActive(0); return; }
    const current = slots[active];
    const other = slots[1 - active];
    if (src === current) return;
    // 目标图仍在另一缓冲槽时直接切回，不必重新解码。
    if (src === other) { setActive(1 - active); return; }
    void decodeImage(src).then(() => {
      if (generation.current !== version) return;
      const nextActive = 1 - active;
      const nextSlots: [string, string] = [...slots];
      nextSlots[nextActive] = src;
      setSlots(nextSlots);
      setActive(nextActive);
    }).catch(() => { errorRef.current?.(src); });
    return () => { generation.current += 1; };
  }, [src, slots, active]);
  const first = active === 0;
  return <div className={className} aria-hidden="true">
    {slots[0] ? <img className={`layer-image${first ? ' active' : ''}`} src={slots[0]} alt={first ? alt : ''} onError={() => onDecodeError?.(slots[0])} /> : null}
    {slots[1] ? <img className={`layer-image${first ? '' : ' active'}`} src={slots[1]} alt={first ? '' : alt} onError={() => onDecodeError?.(slots[1])} /> : null}
  </div>;
}

function sceneLabel(mode: SceneLayerMode): string {
  return mode === 'background' ? '背景图' : '人物场景图';
}

export function ConversationStage({
  snapshot,
  current,
  sources,
  visibleScene,
  live,
  cue,
  onDismiss,
}: {
  snapshot: PerformanceSnapshot;
  current: PerfRow | null;
  sources: StageSources;
  visibleScene: PerfScene | null;
  /** 是否处于实时演出（非回看、非历史）。 */
  live: boolean;
  /** 上一段为动作时点亮舞台提示。 */
  cue: boolean;
  onDismiss: () => void;
}) {
  const policy = useMotionPolicy();
  const visible = visibleScene;
  const full = visible?.mode === 'full_scene';
  // 差分按句段素材编号使用：已有标注就应用，不再要求句段带 outfitId。
  const poseId = spriteForRow(snapshot.messages, current);
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(() => new Set());
  const poseUrl = poseId !== null ? sources.resolveSprite?.(poseId) ?? null : null;
  // 实时回退顺序：差分 → 句段主页快照 → 当前服饰立绘 → 主题图；读取失败继续下一张。
  const chain = [poseUrl, sources.segmentHomeUrl ?? null, sources.outfitUrl ?? null, sources.themeUrl ?? null];
  const characterUrl = chain.find((src): src is string => typeof src === 'string' && src.length > 0 && !failedSources.has(src)) ?? null;
  const sceneAsset = visible?.assetUrl ?? null;
  const backgroundSrc = visible && !full ? (sceneAsset ?? sources.backgroundUrl) : sources.backgroundUrl;
  const day = !policy.reduced && current?.action && live && cue;
  // 任一层图片读取失败时标记该地址，下一次渲染继续尝试后面的回退图。
  const handleCharacterError = (src: string) => {
    if (!chain.includes(src)) return;
    setFailedSources(previous => {
      if (previous.has(src)) return previous;
      const next = new Set(previous);
      next.add(src);
      return next;
    });
  };
  return <section className="dialogue-stage" data-scene={visible?.mode ?? ''} aria-label="背景与角色独立的演出画布">
    <CrossfadeLayer className="dialogue-background" src={backgroundSrc} alt="" />
    <CrossfadeLayer className="dialogue-character" src={characterUrl} alt="角色立绘" onDecodeError={handleCharacterError} />
    {full && sceneAsset ? <div className="dialogue-scene-full"><img src={sceneAsset} alt="过场图" /></div> : null}
    <div className="dialogue-stage-cue" aria-hidden="true" data-live={day ? 'cue' : ''} />
    <i className="dialogue-sun-beam" aria-hidden="true" />
    {visible ? <button type="button" className="dialogue-scene-dismiss" onClick={onDismiss}>收起过场图</button> : null}
    {visible ? <span className="dialogue-stage-note" aria-hidden="true">{sceneLabel(visible.mode)}</span> : null}
  </section>;
}
