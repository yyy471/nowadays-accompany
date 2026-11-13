import { useEffect, useRef, useState } from 'react';
import { Icon, createMotionScope, readMotionPx, readMotionTime, readMotionValue, useMotionPolicy } from '../../ui';
import character from '../../assets/themes/xiacheng/character.png';
import nightCharacter from '../../assets/themes/xiacheng/character-night.png';
import scene from '../../assets/themes/xiacheng/scene-ink.png';
import nightScene from '../../assets/themes/xiacheng/scene-night.png';
import { useThemePreset } from '../../ui/presets';
import { createOutfitDisplay, type DisplayedOutfit } from '../../outfit-display.js';

export function HomeScene({ outfitHomeUrl, outfitName }: { outfitHomeUrl?: string | null; outfitName?: string | null }) {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const policy = useMotionPolicy();
  const reduced = useRef(policy.reduced);
  reduced.current = policy.reduced;
  const [scope] = useState(createMotionScope);
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
    if (reduced.current) return;
    const element = figure.current;
    if (!element) return;
    const duration = readMotionTime(element, '--nd-component-motion-page', 360);
    const offset = readMotionPx(element, '--nd-component-motion-page-offset', 4);
    const ease = readMotionValue(element, '--nd-component-motion-ease', 'cubic-bezier(0.2, 0.8, 0.2, 1)');
    scope.run(element, [
      { opacity: 0.35, transform: `translateY(${offset}px)` },
      { opacity: 1, transform: 'translateY(0)' }
    ], { duration, easing: ease, slot: 'scene', fill: 'backwards' });
    return () => scope.cancelAll();
  }, [scope]);
  useEffect(() => {
    if (!policy.reduced) return;
    reset();
    scope.cancelAll();
  }, [policy.reduced, scope]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) reset(); };
    const blur = () => reset();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', blur);
      reset();
      scope.cancelAll();
    };
  }, [scope]);
  useEffect(() => {
    let current = true;
    // 两套本地原画预解码；冷加载时保留上一套完整插画，避免空白或只换一半。
    const warm = (selected: typeof preset) => {
      let ready = artReady.current.get(selected);
      if (!ready) {
        ready = Promise.all((selected === 'nightwave' ? [nightScene, nightCharacter] : [scene, character]).map(source => {
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
  return <figure ref={figure} className="home-scene" aria-label={displayedOutfit ? (displayedOutfit.name ? `${displayedOutfit.name}主页立绘` : '角色主页立绘') : '夏澄主页主题展示'} onPointerLeave={reset} onPointerMove={event => {
    if (event.pointerType !== 'mouse' || reduced.current) { reset(); return; }
    const box = event.currentTarget.getBoundingClientRect(), x = Math.max(-4, Math.min(4, (event.clientX - box.left - box.width / 2) / box.width * 8)), y = Math.max(-4, Math.min(4, (event.clientY - box.top - box.height / 2) / box.height * 8));
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { frame.current = undefined; figure.current?.style.setProperty('--home-parallax-x', `${x}px`); figure.current?.style.setProperty('--home-parallax-y', `${y}px`); });
  }}>
    {failed ? <div className="home-art-fallback"><Icon name="user" size={40} /><p>主题插画暂时不可用</p></div> : <>
      <img className="home-scene-background" src={artNight ? nightScene : scene} alt="" onError={() => setFailed(true)} />
      <img className="home-scene-character" src={displayedOutfit?.url ?? (artNight ? nightCharacter : character)} alt={displayedOutfit ? (displayedOutfit.name ? `${displayedOutfit.name}主页立绘` : '角色主页立绘') : (artNight ? '夏澄夜间插画：坐在木凳上戴耳机听歌，手托脸颊，膝上放着红色手账' : '夏澄日间插画：粉色开衫与红色手账')} onError={() => { if (displayedOutfit) setDisplayedOutfit(display.current.fail(displayedOutfit.url)); else setFailed(true); }} />
    </>}
    <figcaption className="home-scene-label"><span>{night ? '晚风电台 / NIGHT EDITION' : '白昼来信 / DAY EDITION'}</span><strong>{displayedOutfit ? (displayedOutfit.name ? `当前服饰 · ${displayedOutfit.name}` : '当前服饰') : '主题插画 · 夏澄'}</strong></figcaption>
    <aside className="home-scene-note"><span>{night ? '留给夜晚的一页' : '主题寄语'}</span><p>{night ? <>白天没说完的话，<br />今晚也有人听。</> : <>喜欢傍晚的光，<br />也喜欢听你慢慢说。</>}</p></aside>
  </figure>;
}
