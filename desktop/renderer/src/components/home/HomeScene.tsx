import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui';
import character from '../../assets/themes/xiacheng/character.png';
import nightCharacter from '../../assets/themes/xiacheng/character-night.png';
import scene from '../../assets/themes/xiacheng/scene-ink.png';
import nightScene from '../../assets/themes/xiacheng/scene-night.png';
import { useThemePreset } from '../../ui/presets';
export function HomeScene() {
  const { preset } = useThemePreset();
  const night = preset === 'nightwave';
  const [artPreset, setArtPreset] = useState(preset);
  const artNight = artPreset === 'nightwave';
  const artReady = useRef(new Map<string, Promise<void>>());
  const [failed,setFailed]=useState(false);
  const figure=useRef<HTMLElement>(null);
  const frame=useRef<number|undefined>(undefined);
  const reset=()=>{if(frame.current!==undefined)cancelAnimationFrame(frame.current);frame.current=undefined;figure.current?.style.setProperty('--home-parallax-x','0px');figure.current?.style.setProperty('--home-parallax-y','0px');};
  useEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const observer=new MutationObserver(reset);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-motion']});
    media.addEventListener('change',reset);
    return()=>{reset();observer.disconnect();media.removeEventListener('change',reset);};
  },[]);
  useEffect(()=>{
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
    void warm(preset).then(()=>{if(current){setArtPreset(preset);setFailed(false);}}).catch(()=>{if(current)setFailed(true);});
    void warm(preset === 'nightwave' ? 'daylight' : 'nightwave').catch(()=>{});
    return () => { current = false; };
  },[preset]);
  return <figure ref={figure} className="home-scene" aria-label="夏澄主页主题展示" onPointerLeave={reset} onPointerMove={event=>{
    if(event.pointerType!=='mouse'||window.matchMedia('(prefers-reduced-motion: reduce)').matches||event.currentTarget.closest('[data-motion="reduced"]')){reset();return;}
    const box=event.currentTarget.getBoundingClientRect(),x=Math.max(-4,Math.min(4,(event.clientX-box.left-box.width/2)/box.width*8)),y=Math.max(-4,Math.min(4,(event.clientY-box.top-box.height/2)/box.height*8));
    if(frame.current!==undefined)cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{frame.current=undefined;figure.current?.style.setProperty('--home-parallax-x',`${x}px`);figure.current?.style.setProperty('--home-parallax-y',`${y}px`);});
  }}>
    {failed?<div className="home-art-fallback"><Icon name="user" size={40}/><p>主题插画暂时不可用</p></div>:<>
      <img className="home-scene-background" src={artNight ? nightScene : scene} alt="" onError={()=>setFailed(true)}/>
      <img className="home-scene-character" src={artNight ? nightCharacter : character} alt={artNight ? '夏澄夜间插画：坐在木凳上戴耳机听歌，手托脸颊，膝上放着红色手账' : '夏澄日间插画：粉色开衫与红色手账'} onError={()=>setFailed(true)}/>
    </>}
    <figcaption className="home-scene-label"><span>{night ? '晚风电台 / NIGHT EDITION' : '白昼来信 / DAY EDITION'}</span><strong>夏澄 · XIA CHENG</strong></figcaption>
    <aside className="home-scene-note"><span>{night ? '留给夜晚的一页' : '她的角色设定摘录'}</span><p>{night ? <>白天没说完的话，<br/>今晚也有人听。</> : <>喜欢傍晚的光，<br/>也喜欢听你慢慢说。</>}</p></aside>
  </figure>;
}
