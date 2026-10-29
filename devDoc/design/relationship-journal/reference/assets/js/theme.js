/* 主题过渡：白天 → 夜里，手账页暗下去，纸面横线升起变成调频刻度；夜里 → 白天反过来。
 * 用 View Transition（旧画面快照变暗 / 变亮）＋ 一层真实 DOM 线段做形变；减少动效时直接切换。状态不经过重渲染，账号、页、草稿、选中全部保留。 */
(function () {
  'use strict';
  const V = window.WJView; const root = document.documentElement;
  const KEY = V.LS;
  function mark() { document.querySelectorAll('[data-act="theme"]').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === root.dataset.uiPreset)); }
  mark();
  // 横线位置：与 day.css 中 .leaf.right::before 的 inset / 行距一致
  const RULE = { top: 104, bottom: 72, side: 30, pitch: 30 };
  function ruledLines() {
    const leaf = document.querySelector('.leaf.right') || document.querySelector('#book'); const r = leaf.getBoundingClientRect(); const out = [];
    for (let y = r.top + RULE.top + RULE.pitch - 1; y < r.bottom - RULE.bottom; y += RULE.pitch) out.push({ x: r.left + RULE.side, y, w: r.width - RULE.side * 2 });
    return out;
  }
  function ticks() { return [...document.querySelectorAll('#strip .tk')].map(t => { const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, h: r.height, w: Math.max(1, r.width) }; }); }
  function colorOf(v) { const s = getComputedStyle(root).getPropertyValue(v).trim(); return s || '#888'; }
  function segments() {
    const L = ruledLines(), T = ticks(); if (!L.length || !T.length) return [];
    const per = Math.ceil(T.length / L.length); const segs = [];
    L.forEach((l, li) => { for (let k = 0; k < per; k++) segs.push({ x: l.x + l.w * k / per, y: l.y, w: l.w / per, row: li }); });
    segs.sort((a, b) => (a.x + a.w / 2) - (b.x + b.w / 2) || a.y - b.y);
    const tk = T.slice().sort((a, b) => a.x - b.x);
    return segs.slice(0, tk.length).map((s, i) => ({ s, t: tk[i] }));
  }
  // 横线的真实颜色：用探针元素读 day.css 里同一个 color-mix
  function lineColor() {
    const leaf = document.querySelector('.leaf.right'); if (!leaf) return colorOf('--nd-semantic-color-line-decorative');
    const p = document.createElement('i'); p.style.cssText = 'position:absolute;width:1px;height:1px;background:color-mix(in srgb,var(--line) 85%,transparent)'; leaf.appendChild(p);
    const c = getComputedStyle(p).backgroundColor; p.remove(); return c;
  }
  function tickColors() { return [...document.querySelectorAll('#strip .tk')].map(t => ({ x: t.getBoundingClientRect().left, c: getComputedStyle(t).backgroundColor })).sort((a, b) => a.x - b.x).map(o => o.c); }
  function settle() { const l = document.querySelector('.morph'); if (l) l.remove(); delete root.dataset.tx; delete root.dataset.txpre; }
  function set(t) {
    if (t === root.dataset.uiPreset) return;
    try { localStorage.setItem(KEY, t); } catch (e) {}
    const reduce = root.dataset.motion === 'reduced' || (root.dataset.motion !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    const toNight = t === 'nightwave';
    const msg = toNight ? '已换到晚风电台：账号、页面与草稿都还在' : '已换到白昼来信：账号、页面与草稿都还在';
    const reOv = () => { if (V.S.ov && V.S.ov.open && V.ovRerender) V.ovRerender(); };
    if (reduce || !V.startVT(null, true)) { settle(); root.dataset.uiPreset = t; mark(); reOv(); V.toast && V.toast(msg); return; }
    settle();
    const inOv = V.S.ov && V.S.ov.open;
    const pairs = inOv ? [] : segments();
    // 1) 快照之前：用一模一样的线段替换真实横线（或刻度），旧画面看起来没有任何变化
    const startCol = toNight ? lineColor() : null; const oldTick = toNight ? null : tickColors();
    const layer = document.createElement('div'); layer.className = 'morph'; layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = pairs.map(() => '<i></i>').join(''); document.body.appendChild(layer);
    [...layer.children].forEach((el, i) => { const { s, t: k } = pairs[i]; place(el, toNight ? { x: s.x, y: s.y, w: s.w, h: 1 } : { x: k.x, y: k.y, w: k.w, h: k.h }); el.style.backgroundColor = toNight ? startCol : oldTick[i] || '#888'; });
    root.dataset.txpre = toNight ? 'to-night' : 'to-day'; root.dataset.vt = 'theme';
    const anims = []; let endTick = null;
    const vt = window.WJTheme.last = V.startVT(() => {
      root.dataset.uiPreset = t; root.dataset.tx = toNight ? 'to-night' : 'to-day'; delete root.dataset.txpre; mark(); reOv();
      endTick = toNight ? tickColors() : null;
    });
    if (!vt) { layer.remove(); delete root.dataset.txpre; delete root.dataset.vt; root.dataset.uiPreset = t; delete root.dataset.tx; mark(); reOv(); V.toast && V.toast(msg); return; }
    vt.ready.then(() => {
      const D = 1500, HOLD = 180;
      const endLine = toNight ? null : lineColor();
      // 2) 旧画面：先静止一拍，再暗下去 / 亮起来
      root.animate(toNight
        ? [{ filter: 'brightness(1) saturate(1)', opacity: 1 }, { filter: 'brightness(.97) saturate(.97)', opacity: 1, offset: .16 }, { filter: 'brightness(.55) saturate(.75)', opacity: 1, offset: .5 }, { filter: 'brightness(.25) saturate(.6)', opacity: 0 }]
        : [{ filter: 'brightness(1) sepia(0)', opacity: 1 }, { filter: 'brightness(1.04) sepia(.02)', opacity: 1, offset: .16 }, { filter: 'brightness(1.35) sepia(.3) saturate(.85)', opacity: .9, offset: .55 }, { filter: 'brightness(1.8) sepia(.45) saturate(.6)', opacity: 0 }],
        { duration: D * .74, easing: 'cubic-bezier(.3,0,.2,1)', pseudoElement: '::view-transition-old(root)', fill: 'forwards' });
      root.animate([{ opacity: 0 }, { opacity: 0, offset: toNight ? .5 : .4 }, { opacity: 1 }], { duration: D, easing: 'ease-out', pseudoElement: '::view-transition-new(root)', fill: 'forwards' });
      if (!pairs.length) return;
      const xs = pairs.map(p => toNight ? p.s.x : p.t.x); const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1;
      // 3) 线段：从左到右一道波，先收成短划，再升起成刻度（反向则落下铺成横线）
      [...layer.children].forEach((el, i) => {
        const { s, t: k } = pairs[i]; const night = toNight ? (endTick[i] || colorOf('--nd-semantic-color-entry')) : oldTick[i];
        const lineC = toNight ? startCol : endLine;
        const from = toNight ? { x: s.x, y: s.y, w: s.w, h: 1, c: lineC } : { x: k.x, y: k.y, w: k.w, h: k.h, c: night };
        const to = toNight ? { x: k.x, y: k.y, w: k.w, h: k.h, c: night } : { x: s.x, y: s.y, w: s.w, h: 1, c: lineC };
        const dash = toNight ? { x: s.x + s.w / 2 - 6, y: s.y, w: 12, h: 1.5, c: lineC } : { x: k.x - 1, y: k.y + k.h + 14, w: 3, h: 2, c: night };
        const lift = toNight ? { x: (s.x + k.x) / 2, y: (s.y + k.y) / 2 - 30, w: 2, h: 5, c: night } : { x: (s.x + k.x) / 2, y: (s.y + k.y) / 2, w: 6, h: 1.5, c: lineC };
        const wave = ((toNight ? s.x : k.x) - x0) / (x1 - x0 || 1);
        const delay = HOLD + wave * 380;
        anims.push(el.animate([tf(from, from.c, 1), tf(dash, dash.c, 1, .3), tf(lift, lift.c, 1, .62), tf(to, to.c, 1)], { duration: 900, delay, easing: 'cubic-bezier(.5,0,.25,1)', fill: 'both' }));
      });
      window.WJTheme.anims = anims;
    }).catch(() => {});
    vt.finished.finally(() => Promise.all(anims.map(a => a.finished.catch(() => {}))).then(() => { delete root.dataset.tx; delete root.dataset.vt; setTimeout(() => layer.remove(), 340); }));
  }
  function place(el, r) { el.style.transform = `translate(${r.x}px,${r.y}px) scale(${r.w},${r.h})`; }
  function tf(r, c, o, offset) { const k = { transform: `translate(${r.x}px,${r.y}px) scale(${r.w},${r.h})`, backgroundColor: c, opacity: o }; if (offset != null) k.offset = offset; return k; }
  window.WJTheme = { set, settle, last: null };
})();
