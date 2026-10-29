/* 手绘 SVG：资源图标、角色人像（虚构插画）、麦克风。全部内联，file:// 可用。 */
window.WJArt = (function () {
  'use strict';
  const G = {
    P: '<circle cx="9.5" cy="9" r="3.6"/><path d="M9.5 2.8v1.4M3.6 9H5M5.3 4.8l1 1M13.7 4.8l-1 1"/><path d="M7.5 19h9.3a3.4 3.4 0 0 0 .3-6.8 5 5 0 0 0-9.4 1.4A2.7 2.7 0 0 0 7.5 19z"/>',
    Q: '<rect x="3.5" y="5" width="17" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.8"/><path d="m4.2 17.4 5-5 3.8 3.8 2.4-2.4 4.4 4.2"/>',
    S: '<circle cx="12" cy="12.5" r="1.9"/><path d="M8.3 8.8a5.3 5.3 0 0 0 0 7.4M15.7 8.8a5.3 5.3 0 0 1 0 7.4M5.4 5.9a9.4 9.4 0 0 0 0 13.2M18.6 5.9a9.4 9.4 0 0 1 0 13.2"/>',
    X: '<path d="M3 6.6c3-1.4 6-1.3 9 .6v12c-3-1.9-6-2-9-.6zM21 6.6c-3-1.4-6-1.3-9 .6v12c3-1.9 6-2 9-.6z"/><path d="M5.6 10.2c1.4-.4 2.7-.3 4 .3M5.6 13.2c1.4-.4 2.7-.3 4 .3"/>',
    U: '<path d="M3.5 7.6a2 2 0 0 1 2-2H10l2 2.1h6.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M8.5 13.4h7M12 10v7"/>',
    T: '<path d="M5 4.8h14a2 2 0 0 1 2 2v8.1a2 2 0 0 1-2 2h-6.6L8 20v-3.1H5a2 2 0 0 1-2-2V6.8a2 2 0 0 1 2-2z"/><path d="M12 13.6s-3-1.8-3-3.7a1.6 1.6 0 0 1 3-.8 1.6 1.6 0 0 1 3 .8c0 1.9-3 3.7-3 3.7z"/>',
    W: '<path d="M18.8 14.6A7.6 7.6 0 1 1 9.4 5.2a6 6 0 0 0 9.4 9.4z"/><path d="M15.5 4.5v2.4M14.3 5.7h2.4"/>'
  };
  const glyph = (id, cls) => `<svg class="${cls || 'gl'}" viewBox="0 0 24 24" aria-hidden="true">${G[id] || G.X}</svg>`;

  // 人像：六位虚构角色，孔版印刷（riso）风格插画：两色油墨＋纸色、网点阴影、轻微套色错位。颜色是插画固有色，不承担状态语义。
  const LOOK = {
    clerk: { a: '#2B3768', b: '#E27884', p: '#FFF7EE', skin: '#FCEDE2' },
    host: { a: '#3A2D5E', b: '#E9A25C', p: '#FBF5EE', skin: '#FBEBDF' },
    post: { a: '#21483C', b: '#E8BD45', p: '#FCF7EA', skin: '#FCEEE0' },
    keeper: { a: '#2C3553', b: '#D9605E', p: '#FBF4EC', skin: '#FBEBE0' },
    garden: { a: '#334423', b: '#E792A8', p: '#FCF6EE', skin: '#FCEDE3' },
    announcer: { a: '#1F3A6C', b: '#58B2A4', p: '#F7F7F0', skin: '#FBECE1' }
  };
  function portrait(look, uid) {
    const c = LOOK[look] || LOOK.clerk; const u = 'p' + uid + look[0]; const A = c.a, B = c.b, P = c.p;
    const defs = `<defs><pattern id="${u}h" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><circle cx="1.6" cy="1.6" r=".95" fill="${B}"/></pattern>
      <pattern id="${u}k" width="2.6" height="2.6" patternUnits="userSpaceOnUse" patternTransform="rotate(-20)"><circle cx="1.3" cy="1.3" r=".7" fill="${A}" opacity=".55"/></pattern>
      <pattern id="${u}s" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.4" height="4" fill="${A}" opacity=".16"/></pattern></defs>`;
    // 背景：纸色 + 网点圆 + 角色小图样
    const motif = {
      clerk: `<g fill="${A}" opacity=".9"><rect x="9" y="118" width="22" height="5" rx="1"/><rect x="11" y="112" width="18" height="5" rx="1" fill="${B}"/><rect x="8" y="106" width="20" height="5" rx="1"/></g>`,
      host: `<g fill="none" stroke="${A}" stroke-width="1.6" stroke-linecap="round" opacity=".75"><path d="M95 28a14 14 0 0 1 0 20"/><path d="M100 23a21 21 0 0 1 0 30"/><path d="M105 18a28 28 0 0 1 0 40"/></g>`,
      post: `<g><rect x="88" y="16" width="20" height="24" fill="${P}" stroke="${A}" stroke-width="1.2" stroke-dasharray="2 1.6"/><rect x="92" y="20" width="12" height="13" fill="${B}"/><path d="M92 37h12" stroke="${A}" stroke-width="1"/></g>`,
      keeper: `<g opacity=".8"><rect x="99" y="86" width="9" height="34" fill="${A}"/><path d="M97 86h13l-2-6h-9z" fill="${B}"/><rect x="100" y="96" width="7" height="3" fill="${P}"/></g>`,
      garden: `<g fill="${A}" opacity=".85"><path d="M14 30c10-12 22-10 24 0-8 6-18 7-24 0z"/><path d="M22 44c8-9 18-6 18 2-7 4-14 4-18-2z" fill="${B}"/><path d="M14 30c8 2 16 3 24 0" stroke="${P}" stroke-width=".8" fill="none"/></g>`,
      announcer: `<g fill="${A}"><path d="m98 20 2 5 5 1-4 3 1 5-4-3-4 3 1-5-4-3 5-1z"/><path d="m86 40 1.2 3 3 .6-2.4 1.8.6 3-2.4-1.8-2.4 1.8.6-3-2.4-1.8 3-.6z" fill="${B}"/><circle cx="18" cy="28" r="2" fill="${B}"/></g>`
    }[look] || '';
    const bg = `<rect width="120" height="150" fill="${P}"/><circle cx="62" cy="64" r="46" fill="url(#${u}h)"/><circle cx="66" cy="60" r="46" fill="none" stroke="${B}" stroke-width="1" opacity=".5"/>${motif}`;
    // 衣服（每人不同）
    const cloth = {
      clerk: `<path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="${A}"/><path d="M42 150v-26c0-6 4-10 10-10h16c6 0 10 4 10 10v26z" fill="${B}"/><path d="M50 114 44 104M70 114l6-10" stroke="${B}" stroke-width="3.2" stroke-linecap="round"/><rect x="53" y="128" width="14" height="9" rx="2" fill="none" stroke="${A}" stroke-width="1.3"/>`,
      host: `<path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="${B}"/><path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="url(#${u}k)"/><path d="M48 113l12 14 12-14" fill="none" stroke="${A}" stroke-width="2.4" stroke-linejoin="round"/>`,
      post: `<path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="${A}"/><path d="M60 112v38" stroke="${P}" stroke-width="1" opacity=".5"/><path d="M26 124 88 150" stroke="${B}" stroke-width="5"/><rect x="72" y="126" width="24" height="17" rx="2" fill="${P}" stroke="${A}" stroke-width="1"/><path d="m72.5 126.5 11.5 8.6 11.5-8.6" fill="none" stroke="${A}" stroke-width="1.3"/>`,
      keeper: `<path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="${A}"/><path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="url(#${u}s)"/><path d="M40 107c9 10 31 10 40 0l4 11c-13 8-35 8-48 0z" fill="${B}"/><path d="M70 115l9 25-7 2-7-23z" fill="${B}"/><path d="M42 111h36" stroke="${P}" stroke-width=".8" opacity=".6"/>`,
      garden: `<path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="${B}"/><path d="M30 150c2-15 12-24 30-24s28 9 30 24z" fill="${A}" opacity=".9"/><path d="M36 128v22M84 128v22" stroke="${A}" stroke-width="5"/><circle cx="60" cy="138" r="3" fill="${B}"/>`,
      announcer: `<path d="M12 150c3-25 22-38 48-38s45 13 48 38z" fill="${A}"/><path d="M47 113h26l-4 10H51z" fill="${P}"/><path d="M56 123h8l-4 22z" fill="${B}"/><circle cx="84" cy="128" r="5" fill="${B}"/><circle cx="84" cy="128" r="2" fill="${P}"/>`
    }[look];
    const skin = c.skin;
    const neck = `<path d="M51 94h18v18c-4 5-14 5-18 0z" fill="${skin}"/><path d="M51 100c6 4 12 4 18 0v-6H51z" fill="url(#${u}k)" opacity=".7"/>`;
    const head = `<ellipse cx="60.8" cy="71.6" rx="22" ry="25" fill="${B}" opacity=".55"/><ellipse cx="60" cy="71" rx="22" ry="25" fill="${skin}"/>
      <ellipse cx="38.5" cy="74" rx="3.5" ry="5" fill="${skin}"/><ellipse cx="81.5" cy="74" rx="3.5" ry="5" fill="${skin}"/>`;
    const cheeks = `<circle cx="47.5" cy="81" r="5" fill="url(#${u}h)"/><circle cx="72.5" cy="81" r="5" fill="url(#${u}h)"/>`;
    const eyesArc = `<path d="M47.5 73.5q3.2-3 6.4 0M66.1 73.5q3.2-3 6.4 0" fill="none" stroke="${A}" stroke-width="2" stroke-linecap="round"/>`;
    const eyesDot = `<ellipse cx="51" cy="73" rx="1.9" ry="2.4" fill="${A}"/><ellipse cx="69" cy="73" rx="1.9" ry="2.4" fill="${A}"/><path d="M47 67.5q4-2 7 0M66 67.5q3-2 7 0" fill="none" stroke="${A}" stroke-width="1.3" stroke-linecap="round"/>`;
    const mouth = (w) => `<path d="M56.5 85q3.5 ${w} 7 0" fill="none" stroke="${A}" stroke-width="1.7" stroke-linecap="round"/><path d="M60 76v4l-1.4.8" fill="none" stroke="${A}" stroke-width="1.1" stroke-linecap="round" opacity=".6"/>`;
    // 头发与配饰：先用 B 色错位印一层，再用 A 色正印
    const hair = {
      clerk: { back: '', front: `M36 80C33 50 46 40 60 40s28 10 24.6 40l.4 11c-3.6 2.4-7 1-8-2.6L76.4 64C70 59 56 57.5 45.4 62.5L44.2 88c-1.2 3.8-4.8 4.8-8.4 2.5z`, extra: `<g fill="none" stroke="${A}" stroke-width="1.5"><circle cx="51" cy="73.6" r="6.2"/><circle cx="69" cy="73.6" r="6.2"/><path d="M57.2 73.4h5.6M44.8 72.6 39 71M75.2 72.6 81 71"/></g>`, eyes: eyesDot, m: 2.4 },
      host: { back: `M29 76C26 42 45 33 60 33s35 9 31 43l5 52c-14 8-58 8-72 0z`, front: `M37.4 67C40 45 51 40 61 40c12 0 22.6 8 22 27-8-8.6-16-12-26-11.4-8 .5-14 4.6-19.6 11.4z`, extra: `<path d="M33 73c0-31 54-31 54 0" fill="none" stroke="${B}" stroke-width="4.2" stroke-linecap="round"/><path d="M33 73c0-31 54-31 54 0" fill="none" stroke="${P}" stroke-width="1" stroke-dasharray="2 3" opacity=".7"/><rect x="26" y="64" width="12" height="20" rx="6" fill="${B}"/><rect x="82" y="64" width="12" height="20" rx="6" fill="${B}"/><rect x="28.5" y="67" width="7" height="14" rx="3.5" fill="${A}"/><rect x="84.5" y="67" width="7" height="14" rx="3.5" fill="${A}"/><circle cx="32.5" cy="74.5" r="2.4" fill="${B}"/><circle cx="87.5" cy="74.5" r="2.4" fill="${B}"/>`, eyes: eyesArc, m: 3 },
      post: { back: '', front: `M38 76c-2-18 8-27 22-27s24 9 22 27c-4-7-11-11.4-22-11.4S42 69 38 76z`, extra: `<path d="M34.6 57c2-17.6 49-17.6 50.8 0z" fill="${B}"/><path d="M34.6 57c2-17.6 49-17.6 50.8 0z" fill="url(#${u}k)"/><path d="M30 57h60c0 4.4-3 7-7.4 7H37.4C33 64 30 61.4 30 57z" fill="${A}"/><rect x="55" y="45" width="10" height="7" rx="1.5" fill="${P}" stroke="${A}" stroke-width="1"/>`, eyes: eyesDot, m: 3.2 },
      keeper: { back: `M70 44c16-4 26 6 24 22-1 10-6 18-4 30-7-4-11-14-11-24 0-8-3-14-9-28z`, front: `M36.6 71C35 47 47 38 61 38c15 0 25.4 10 22.4 33-7-10.6-16-14.6-25.4-14-8 .4-15 5-21.4 14z`, extra: `<path d="M84 52c3 1 5 3 6 6" fill="none" stroke="${B}" stroke-width="4" stroke-linecap="round"/>`, eyes: eyesArc, m: 2.6 },
      garden: { back: `M34 82c-5-18 2-38 26-38s32 20 26 38c-2 10-4 18-9 22H43c-5-4-7-12-9-22z`, front: `M38 70c1-15 10-22 22-22s21 7 22 22c-6-6-13-9-22-9s-16 3-22 9z`, extra: `<ellipse cx="60" cy="52" rx="38" ry="7" fill="${B}"/><path d="M38 51c2-16 42-16 44 0z" fill="${B}"/><path d="M38 51c2-16 42-16 44 0z" fill="url(#${u}s)"/><path d="M38.5 49.5h43" stroke="${A}" stroke-width="2.4"/><circle cx="78" cy="46" r="4" fill="${P}" stroke="${A}" stroke-width="1"/><circle cx="78" cy="46" r="1.4" fill="${A}"/>`, eyes: eyesDot, m: 2.2 },
      announcer: { back: `M60 23a10 10 0 1 1 0 20 10 10 0 0 1 0-20z`, front: `M37 72c-1-20 9-31 23-31s25 11 23 31c-5-9-12-14-23-14s-18 5-23 14z`, extra: `<path d="M66 26l12-8" stroke="${B}" stroke-width="2.4" stroke-linecap="round"/><path d="M81 78c4 4 4 10-1 14h-6" fill="none" stroke="${A}" stroke-width="1.6" stroke-linecap="round"/><circle cx="72.5" cy="92" r="2.2" fill="${B}"/>`, eyes: eyesDot, m: 3 }
    }[look] || {};
    const hairG = (d) => d ? `<path d="${d}" fill="${B}" transform="translate(1.4 1)" opacity=".85"/><path d="${d}" fill="${A}"/>` : '';
    const shine = look === 'host' || look === 'keeper' ? `<path d="M47 50c4-4 9-5.4 14-5" fill="none" stroke="${P}" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>` : '';
    return `<svg class="portrait-svg" viewBox="0 0 120 150" aria-hidden="true" preserveAspectRatio="xMidYMid slice">${defs}${bg}${hairG(hair.back)}${cloth}${neck}${head}${cheeks}${hair.eyes || eyesDot}${mouth(hair.m || 2.6)}${hairG(hair.front)}${shine}${hair.extra || ''}
      <rect width="120" height="150" fill="url(#${u}s)" opacity=".18"/></svg>`;
  }
  const mic = `<svg class="mic-svg" viewBox="0 0 48 96" aria-hidden="true"><rect x="13" y="4" width="22" height="38" rx="11" class="mic-head"/><path d="M17 14h14M17 20h14M17 26h14M17 32h14" class="mic-grille"/><path d="M8 26v4a16 16 0 0 0 32 0v-4" class="mic-yoke"/><path d="M24 46v34M12 90h24M24 80v10" class="mic-stand"/></svg>`;
  return { glyph, portrait, mic };
})();
