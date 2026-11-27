import { useEffect, useRef, useState } from 'react';
import { Icon, readMotionPx, useMotionPolicy } from '../../ui';
import scene from '../../assets/themes/xiacheng/scene-ink.png';
import nightScene from '../../assets/themes/xiacheng/scene-night.png';
import { useThemePreset } from '../../ui/presets';
import { createOutfitDisplay, type DisplayedOutfit } from '../../outfit-display';

export function HomeScene({ outfitHomeUrl, outfitName, hasOutfits, ready }: { outfitHomeUrl?: string | null; outfitName?: string | null; hasOutfits: boolean; ready: boolean }) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const policy = useMotionPolicy();
  const reduced = useRef(policy.reduced);
  reduced.current = policy.reduced;
  const [artPreset, setArtPreset] = useState(preset);
  const artNight = artPreset === 'nightwave';
  const artReady = useRef(new Map<string, Promise<void>>());
  const [failed, setFailed] = useState(false);
  const display = useRef(createOutfitDisplay());
  const [displayedOutfit, setDisplayedOutfit] = useState<DisplayedOutfit | null>(null);
  const figure = useRef<HTMLElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const reset = () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    figure.current?.style.setProperty('--home-parallax-x', '0px');
    figure.current?.style.setProperty('--home-parallax-y', '0px');
  };
  useEffect(() => {
    if (policy.reduced) reset();
  }, [policy.reduced]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) reset(); };
    const blur = () => reset();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', blur);
      reset();
    };
  }, []);
  useEffect(() => {
    let current = true;
    // 两套本地原画预解码；冷加载时保留上一套完整插画，避免空白或只换一半。
    const warm = (selected: typeof preset) => {
      let ready = artReady.current.get(selected);
      if (!ready) {
        ready = Promise.all((selected === 'nightwave' ? [nightScene] : [scene]).map(source => {
          const image = new Image(); image.src = source; return image.decode();
        })).then(() => {});
        artReady.current.set(selected, ready);
        void ready.catch(() => { artReady.current.delete(selected); });
      }
      return ready;
    };
    reset();
    void warm(preset).then(() => { if (current) { setArtPreset(preset); setFailed(false); } }).catch(() => { if (current) setFailed(true); });
    void warm(preset === 'nightwave' ? 'daylight' : 'nightwave').catch(() => {});
    return () => { current = false; };
  }, [preset]);
  useEffect(() => {
    let active = true;
    void display.current.load(outfitHomeUrl, outfitName, url => {
      const image = new Image();
      image.src = url;
      return image.decode();
    }).then(next => {
      if (!active) return;
      setDisplayedOutfit(next);
      if (next) setFailed(false);
    });
    return () => { active = false; };
  }, [outfitHomeUrl, outfitName]);
  return <figure ref={figure} className="home-scene" aria-label={ready && displayedOutfit?.name ? `${displayedOutfit.name}主页立绘` : '角色主页'} onPointerLeave={reset} onPointerMove={event => {
    if (event.pointerType !== 'mouse' || reduced.current) { reset(); return; }
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const x = Math.max(-1, Math.min(1, (event.clientX - box.left) / box.width * 2 - 1));
    const y = Math.max(-1, Math.min(1, (event.clientY - box.top) / box.height * 2 - 1));
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      const element = figure.current;
      if (!element || reduced.current) return;
      const distance = readMotionPx(element, '--nd-semantic-motion-detail-page-offset', 4);
      element.style.setProperty('--home-parallax-x', `${x * distance}px`);
      element.style.setProperty('--home-parallax-y', `${y * distance}px`);
    });
  }}>
    <div className="home-scene-art">
      {failed ? <div className="home-art-fallback"><Icon name="user" size={40} /><p>主题插画暂时不可用</p></div> : <>
        <img className="home-scene-background" src={artNight ? nightScene : scene} alt="" onError={() => setFailed(true)} />
        {ready && (displayedOutfit?.url
          ? <img className="home-scene-character" src={displayedOutfit.url} alt={displayedOutfit.name ? `${displayedOutfit.name}主页立绘` : '角色主页立绘'} onError={() => setDisplayedOutfit(display.current.fail(displayedOutfit.url))} />
          : !hasOutfits && <div className="home-scene-empty" role="status"><Icon name="user" size={34} /><p>这个角色还没有主页立绘</p><small>在角色配置的外观里添加一套服饰后，这里会显示她的样子。</small></div>)}
      </>}
    </div>
    {ready && <figcaption className="home-scene-caption">
      <div className="home-scene-label">
        <span>{night ? '晚风电台 / NIGHT EDITION' : '白昼来信 / DAY EDITION'}</span>
        {displayedOutfit && <strong title={displayedOutfit.name || undefined}>{displayedOutfit.name ? `当前服饰 · ${displayedOutfit.name}` : '当前服饰'}</strong>}
      </div>
    </figcaption>}
  </figure>;
}
