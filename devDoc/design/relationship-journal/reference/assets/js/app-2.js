/* 封底贴纸 / 设备架、索引页 / 频率表、交互与动效编排 */
(function () {
  'use strict';
  const V = window.WJView; const { S, db, D, A, $, e, tl, acc, draft, page, pageOf } = V;

  // ---------- View Transition 的唯一入口（v3）：不支持 / 减少动效 / 页面在后台 / 调用抛错 时返回 null，调用方走无动画路径 ----------
  V.startVT = function (update, probe) {
    if (typeof document.startViewTransition !== 'function' || V.reduced() || document.visibilityState === 'hidden' || document.documentElement.dataset.novt === '1') return null;
    if (probe) return true;
    try { const vt = document.startViewTransition(update); ['ready', 'finished', 'updateCallbackDone'].forEach(k => vt[k] && vt[k].catch(() => {})); return vt; }
    catch (err) { return null; }
  };
  // ---------- 封底贴纸 / 设备架 ----------
  function sheetHtml(a, d, p) {
    const missing = missingOf(a);
    const sel = S.sheetSel && a.sheet.includes(S.sheetSel) ? S.sheetSel : null;
    const msel = S.sheetSel && missing.includes(S.sheetSel) ? S.sheetSel : null;
    const stickers = a.sheet.map(id => { const def = D.DEF[id]; const r = D.resolve(a, d, p, id); const src = D.srcLabel(a, id);
      const accIss = D.issues(a, d, { type: 'account', key: 'acc' }, id).filter(i => i.code === 'auth' || i.code === 'ready');
      const state = r.value === 'on' ? (r.own === 'on' ? tl('已贴在本页', '已直播') : tl('复写在本页', '转播中')) : tl('没贴', '空闲');
      return `<button type="button" class="stk ty-${def.type}${sel === id ? ' sel' : ''}${r.value === 'on' ? ' used' : ''}${S.fx && S.fx.hint === id ? ' fx-hint' : ''}" data-act="stk" data-id="${id}" data-k="stk-${id}" aria-pressed="${sel === id}" aria-label="${def.type === 'plugin' ? '插件' : 'Skill'} ${id} ${e(def.name)}，${src.d}，按 Enter 贴到这一页">
        <span class="glyph g-${id}">${A.glyph(id)}</span><span class="st-t"><b>${e(def.name)}</b><small>${def.type === 'plugin' ? '插件' : 'Skill'} ${id} · ${tl(src.d, src.n)}</small></span>
        <span class="st-s${r.value === 'on' ? ' on' : ''}">${state}</span>${accIss.length ? `<span class="st-bad">${tl(e(accIss[0].text), '故障')}</span>` : ''}</button>`; }).join('');
    let detail = `<p class="cap">${tl('选中一张贴纸按 Enter 贴到这一页，或直接拖到右页。拖出右页就是揭下。', '选中设备按 Enter 插进本台，或直接拖进右边的推子槽。拖出来就是拔掉。')}</p>`;
    if (msel) detail = installHtml(a, msel);
    if (sel) {
      const def = D.DEF[sel]; const src = D.srcLabel(a, sel); const iss = D.issues(a, d, p, sel).filter(i => i.code !== 'qq');
      const fix = iss.map(i => i.code === 'auth' ? `<div class="fixrow"><span class="pen-t">${tl(e(i.text), '故障：' + e(i.night.replace(/^.*?：/, '')))}</span><button type="button" class="btn entry compact" data-act="grant" data-id="${sel}" data-k="grant">授权给 ${a.id} ${tl('本', '台')}（模拟）</button></div>`
        : i.code === 'ready' ? `<div class="fixrow"><span class="pen-t">${tl('插件未就绪', '故障：插件未就绪')}：${e(i.sub || '')}</span><button type="button" class="btn entry compact" data-act="ready" data-id="${sel}" data-k="ready">重新载入插件 ${sel}（模拟）</button></div>`
        : i.code === 'dep' ? `<div class="fixrow"><span class="pen-t">${e(i.text)}</span><button type="button" class="btn compact" data-act="paste" data-id="${D.DEF[sel].plugin}" data-k="dep">${tl('把插件 ' + D.DEF[sel].plugin + ' 贴上', '接入插件 ' + D.DEF[sel].plugin)}</button></div>` : '').join('');
      detail = `<div class="dt-h"><b>${def.type === 'plugin' ? '插件' : 'Skill'} ${sel} · ${e(def.name)}</b><span class="src s-${src.cls}">${tl(src.d, src.n)}</span></div>
        <p class="cap">${def.type === 'plugin' ? e(def.note) : def.src === 'plugin' ? `由插件 ${def.plugin} 提供；插件 ${def.plugin} 也要在这一页开着` : def.tool ? `要用到「${def.tool[1]}」（<span class="mono">${def.tool[0]}</span>）` : '不需要额外授权'}${a.privateOverride[sel] ? ` · ${e(a.privateOverride[sel])}` : ''}</p>${fix}
        <div class="row"><button type="button" class="btn commit compact" data-act="paste" data-id="${sel}" data-k="paste-sel">${tl('贴到这一页', '插进本台')} <kbd>Enter</kbd></button></div>`;
    }
    return `<aside class="sheet" id="sheet" aria-label="${a.id} ${night() ? '台设备架' : '本封底贴纸'}">
      <header class="sh"><div><p class="kicker">${tl(`${a.id} 本 · 封底`, `${a.id} 台 · 设备架`)}</p><h2>${tl('已安装的贴纸', '已安装的设备')}</h2></div><button type="button" class="icon-btn" data-act="sheet" aria-label="收起">×</button></header>
      <p class="cap">${tl(`只印着 ${a.id} 本装好的插件和 Skill；别的本子的贴纸不在这里。`, `只放 ${a.id} 台装好的设备；别的收音机的设备不在这里。`)}</p>
      ${missing.length ? `<div class="miss" role="group" aria-label="没安装，但有页开着"><p class="miss-h">${tl('没安装，但有页开着它', '没装机，但有台在调用')}</p>${missing.map(id => { const def = D.DEF[id];
        return `<button type="button" class="stk missing ty-${def.type}${msel === id ? ' sel' : ''}" data-act="stk" data-id="${id}" data-k="stk-${id}" aria-pressed="${msel === id}" aria-label="${def.type === 'plugin' ? '插件' : 'Skill'} ${id} ${e(def.name)}，没安装，按 Enter 看怎么安装"><span class="glyph g-${id}">${A.glyph(id)}</span><span class="st-t"><b>${e(def.name)}</b><small>${def.type === 'plugin' ? '插件' : 'Skill'} ${id} · ${tl('没安装', '未装机')}</small></span><span class="st-s miss-s">${tl('去安装', '装机')}</span></button>`; }).join('')}</div>` : ''}
      <div class="stickers" data-k="stickers">${stickers}</div><div class="detail">${detail}</div></aside>`;
  }
  const night = V.night;
  // ---------- 安装（v3，原型流程）：某层开着、但这本没装的贴纸 / 设备 ----------
  function missingOf(a) { const ids = []; Object.values(a.layers).forEach(o => Object.entries(o).forEach(([id, v]) => { if (v === 'on' && !a.sheet.includes(id) && !ids.includes(id)) ids.push(id); })); return ids; }
  function installHtml(a, id) {
    const def = D.DEF[id]; const pages = a.pages.filter(p => p.type === 'conv' && D.resolve(a, S.drafts[a.id], p, id).value === 'on');
    const needAuth = def.tool && !a.auth.includes(def.tool[0]); const needPlugin = def.plugin && !a.sheet.includes(def.plugin);
    const busy = S.installing === id;
    return `<div class="dt-h"><b>${def.type === 'plugin' ? '插件' : 'Skill'} ${id} · ${e(def.name)}</b><span class="src s-missing">${tl('没安装', '未装机')}</span></div>
      <p class="cap">${tl(`${a.id} 本有 ${pages.length} 页开着它，但封底没有这张贴纸，所以这些页都用不了。`, `${a.id} 台有 ${pages.length} 个电台在调用它，但设备架上没有这台设备，所以都没信号。`)}</p>
      <ol class="inst-steps"><li class="${busy ? 'run' : ''}">${tl(`把「${e(def.name)}」装进 ${a.id} 本的封底`, `把「${e(def.name)}」装上 ${a.id} 台的设备架`)}</li>
        ${needAuth ? `<li><button type="button" class="inst-chk" data-act="inst-auth" data-k="inst-auth" aria-pressed="${S.instAuth !== false}">${S.instAuth !== false ? '✓' : ''}</button><span>同时授权「${e(def.tool[1])}」（<span class="mono">${def.tool[0]}</span>）给 ${a.id} ${tl('本', '台')}：它需要这个权限</span></li>` : ''}
        ${needPlugin ? `<li>还需要插件 ${def.plugin}：装好后会提示</li>` : ''}</ol>
      <div class="row"><button type="button" class="btn commit compact" data-act="install" data-id="${id}" data-k="install"${busy ? ' aria-disabled="true"' : ''}>${busy ? tl('安装中…', '装机中…') : tl(`安装到 ${a.id} 本（模拟）`, `装上 ${a.id} 台（模拟）`)}</button></div>`;
  }
  function install(id) {
    const a = acc(); if (S.installing) return; const def = D.DEF[id]; S.installing = id; S.focus = 'install'; render(); live('安装中');
    setTimeout(() => { if (!a.sheet.includes(id)) a.sheet.push(id); const granted = def.tool && S.instAuth !== false && !a.auth.includes(def.tool[0]); if (granted) a.auth.push(def.tool[0]);
      S.installing = null; S.sheetSel = id; S.fx = { type: 'fixed', id, hint: id }; S.focus = 'stk-' + id; render();
      const left = a.pages.some(p => p.type === 'conv' && D.issues(a, S.drafts[a.id], p, id).some(i => i.code !== 'qq'));
      toast(`已安装 ${e(nm(id))} 到 ${a.id} ${night() ? '台' : '本'}（模拟）${granted ? '，并授权「' + e(def.tool[1]) + '」' : ''}：${left ? `<span class="bad-t">${night() ? '还有故障，见设备卡' : '还有一条红笔，见贴纸'}</span>` : (night() ? '故障灯熄了' : '红笔批注划掉了')}`); }, V.reduced() ? 200 : 700);
  }

  // ---------- 索引页 / 节目频率表 ----------
  function refsFor(kind, id) {
    return db.order.map(aid => { const a = db.acc[aid]; const d = S.drafts[aid];
      const pages = a.pages.filter(p => p.type === 'conv').filter(p => kind === 'role' ? (D.roleOf(a, d, p) || {}).id === id : D.resolve(a, d, p, id).value === 'on')
        .map(p => ({ p, bad: kind === 'role' ? a.status !== 'online' : D.issues(a, d, p, id).length > 0, why: kind === 'role' ? '' : (D.issues(a, d, p, id)[0] || {}).text }));
      const offs = kind === 'role' ? [] : a.pages.filter(p => p.type === 'conv' && D.resolve(a, d, p, id).own === 'off');
      return { a, pages, offs };
    }).filter(x => x.pages.length || x.offs.length);
  }
  function refLine(kind, id) {
    const rs = refsFor(kind, id).filter(x => x.pages.length);
    if (!rs.length) return `<span class="cap">${tl('还没有哪一页用到', '还没有电台在播')}</span>`;
    return rs.map(x => `${tl(x.a.id + ' 本第 ', x.a.id + ' 台 ')}${x.pages.map(r => `<button type="button" class="pg${r.bad ? ' bad' : ''}" data-act="goto" data-acc="${x.a.id}" data-page="${r.p.key}" data-id="${kind === 'role' ? '' : id}" title="${e(V.pageTitle(r.p))}${r.bad ? ' · 用不了：' + e(r.why || 'QQ 没连上') : ''}">${tl(String(r.p.no), r.p.freq.toFixed(1))}${r.bad ? '<sup>!</sup>' : ''}</button>`).join(tl('、', ' · '))}${tl(' 页', '')}`).join('<span class="sep">；</span>');
  }
  function entry(kind, id, name, srcTxt, isPublic) {
    const imp = S.impact === kind + ':' + id ? impactHtml(kind, id) : '';
    return `<li class="ix-e"><div class="ix-l"><b>${e(name)}</b><small>${srcTxt}</small><i class="dots" aria-hidden="true"></i><span class="refs">${refLine(kind, id)}</span></div>
      ${isPublic ? `<button type="button" class="link small" data-act="impact" data-v="${kind}:${id}" data-k="imp-${kind}-${id}" aria-expanded="${!!imp}">${tl('改公共定义前，先看影响', '改公共节目前，先看覆盖范围')}</button>` : ''}${imp}</li>`;
  }
  function impactHtml(kind, id) {
    const rs = refsFor(kind, id);
    const hit = rs.filter(x => x.pages.length && !x.a.privateOverride[id]);
    const keep = [];
    rs.forEach(x => x.offs.forEach(p => keep.push(`${tl(x.a.id + ' 本第 ' + p.no + ' 页', x.a.id + ' 台 ' + p.freq.toFixed(1))}（${tl('本页手写关', '本台关')}）`)));
    db.order.forEach(aid => { if (db.acc[aid].privateOverride[id]) keep.push(`${tl(aid + ' 本', aid + ' 台')}（${tl('用自己的私有版本', '播自己的私有版本')}）`); });
    const n = hit.reduce((s, x) => s + x.pages.length, 0);
    return `<div class="impact" role="note"><p><b>${tl(`会改到 ${hit.length} 本手账里的 ${n} 页`, `会影响 ${hit.length} 台收音机的 ${n} 个电台`)}</b>：${hit.map(x => `${tl(x.a.id + ' 本 ', x.a.id + ' 台 ')}${x.pages.map(r => tl(r.p.no, r.p.freq.toFixed(1))).join('、')}`).join('；') || '无'}</p>
      ${keep.length ? `<p>${tl('不受影响', '照常播自己的')}：${keep.join('；')}</p>` : ''}<p class="cap">${kind === 'role' ? '各页绑定的版本不变时，跟随最新版本的页会一起变。' : '各本的开关不会被改动，改的只是这张贴纸本身的内容。'}原型不提供定义编辑。</p>
      <button type="button" class="btn compact" data-act="impact" data-v="${kind}:${id}">知道了</button></div>`;
  }
  function indexHtml() {
    const roles = Object.values(D.ROLES).map(r => entry('role', r.id, `角色 ${r.id} · ${r.name}`, r.src === 'public' ? '公共角色卡' : tl(r.owner + ' 本私有', r.owner + ' 台私有'), r.src === 'public'));
    const plugins = Object.values(D.DEF).filter(d => d.type === 'plugin').map(d => entry('item', d.id, `插件 ${d.id} · ${d.name}`, '公共插件', true));
    const skills = Object.values(D.DEF).filter(d => d.type === 'skill').map(d => entry('item', d.id, `Skill ${d.id} · ${d.name}`, d.src === 'plugin' ? '插件 ' + d.plugin + ' 提供' : d.src === 'private' ? tl('账号私有', '电台私有') : '公共', d.src === 'public'));
    return `<div class="leaf left ix"><header class="lh"><p class="kicker">${tl('手账末页 · 索引', '节目频率表')}</p><h1 id="page-title" tabindex="-1">${tl('索引', '频率表')}</h1>
        <p class="meta">${tl('点页码就翻过去。各本页码各自独立，账号之间互不相通。', '点频率就调过去。各台频率各自独立，收音机之间互不相通。')}<sup class="bad-t">!</sup> ${tl('＝那一页开着但用不了', '＝那个台开着但故障')}</p>
        <button type="button" class="btn ghost compact close-ix" data-act="index" data-k="close-ix">${tl('合上索引', '收起频率表')} <kbd>I</kbd></button></header>
        <h3>${tl('角色卡', '主持人')}</h3><ul class="ix-list">${roles.join('')}</ul><h3>插件</h3><ul class="ix-list">${plugins.join('')}</ul></div>
      <div class="gutter" aria-hidden="true"></div>
      <div class="leaf right ix"><h3>Skill</h3><ul class="ix-list">${skills.join('')}</ul></div>`;
  }

  V.refsFor = refsFor; V.impactHtml = impactHtml;
  // ---------- 渲染 ----------
  function render() {
    const a = acc(), d = draft(), p = page(); const book = $('#book');
    const ak = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
    V.renderShelf(); V.renderStrip();
    book.className = `book cover-${a.cover}${S.xray ? ' xray' : ''}${S.sheet ? ' sheet-open' : ''}${S.index ? ' index' : ''}${S.ov.open ? ' ov-open' : ''}${book.dataset.anim ? ' ' + book.dataset.anim : ''}`;
    book.classList.toggle('ov-open', S.ov.open);
    if (S.ov.open) { V.renderOv(book); }
    else if (S.index) book.innerHTML = `<div class="spread">${indexHtml()}</div>`;
    else book.innerHTML = `<div class="spread"><div class="leaf left">${p.type === 'conv' ? V.leftConv(a, d, p) : V.leftLayer(a, d, p)}</div><div class="gutter" aria-hidden="true"></div>
      <div class="leaf right"><span class="ribbon" aria-hidden="true"></span>${V.rightPage(a, d, p)}${S.save.state === 'conflict' ? conflictHtml(a) : ''}</div>${S.sheet ? sheetHtml(a, d, p) : ''}</div>`;
    coverInert();
    document.querySelectorAll('[data-act="xray"]').forEach(b => b.setAttribute('aria-pressed', S.xray));
    document.querySelectorAll('[data-act="ov"].tool').forEach(b => b.setAttribute('aria-pressed', S.ov.open));
    const chip = $('#data-chip'); if (chip) chip.innerHTML = S.big ? '示例数据 · 大量会话' : '示例数据';
    const want = S.focus || ak; S.focus = null;
    if (want) { const el = document.querySelector(`[data-k="${want}"]`) || document.getElementById(want); if (el) el.focus({ preventScroll: true }); }
    S.fx = null;
  }
  V.render = render;
  // 矮屏下总览会盖住书架 / 页签：被盖住的部分不能再被 Tab 到或点到
  const shortMQ = matchMedia('(max-height:820px)');
  function coverInert() { const on = S.ov.open && shortMQ.matches; ['#shelf', '#strip', '.stage > .tools'].forEach(q => { const el = $(q); if (el) el.inert = on; }); document.querySelector('.stage').classList.toggle('ov-cover', on); }
  shortMQ.addEventListener && shortMQ.addEventListener('change', coverInert);
  const live = (m) => { const l = $('#live'); l.textContent = ''; setTimeout(() => { l.textContent = m; }, 30); };
  let toastT;
  function toast(m) { const t = $('#toast'); t.innerHTML = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), Math.max(3200, t.textContent.length * 90)); live(t.textContent); }
  V.toast = toast;

  // ---------- 修改 ----------
  function setVal(id, v, fxType) {
    const p = page(); const d = draft(); d.layers[p.key] = d.layers[p.key] || {};
    const saved = (acc().layers[p.key] || {})[id] || null;
    if ((v || null) === saved) delete d.layers[p.key][id]; else d.layers[p.key][id] = v;
    if (!Object.keys(d.layers[p.key]).length) delete d.layers[p.key];
    S.fx = { type: fxType, id }; S.focus = 'cell-' + id; if (S.save.state !== 'pending') S.save.state = 'idle';
  }
  const nm = (id) => `${D.DEF[id].type === 'plugin' ? '插件' : 'Skill'} ${id} · ${D.DEF[id].name}`;
  function paste(id) {
    const p = page(); setVal(id, 'on', 'paste'); render();
    const r = D.resolve(acc(), draft(), p, id); const iss = D.issues(acc(), draft(), p, id);
    toast(`${night() ? '已插进本台' : '已贴到这一页'}：${e(nm(id))}${iss.length ? `<br><span class="bad-t">${night() ? '但故障灯亮着' : '但红笔批注'}：${e(iss[0].text)}</span>` : ''}`);
    sfx('paste'); return r;
  }
  function peel(id, noFly) {
    const c = document.querySelector(`#cells .cell[data-id="${id}"]`);
    if (c && !noFly && !V.reduced() && !c.classList.contains('m-peeled')) { const r = c.getBoundingClientRect(); const k = c.cloneNode(true); k.classList.add('peel-fly'); k.removeAttribute('data-k'); k.removeAttribute('tabindex');
      k.querySelectorAll('.acts,.strata,.note,.loop').forEach(n => n.remove()); Object.assign(k.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', margin: 0 }); document.body.appendChild(k); setTimeout(() => k.remove(), 620); }
    setVal(id, 'off', 'peel'); render(); toast(`${night() ? '已拔掉，本台关' : '已揭下，这一页关'}：${e(nm(id))}`); sfx('peel'); }
  function erase(id) {
    const p = page(); setVal(id, null, 'erase'); render();
    const r = D.resolve(acc(), draft(), p, id);
    const from = r.source === 'acc' ? (night() ? '总台' : '扉页') : r.source.startsWith('k:') ? (night() ? D.NIGHT_LAYER[r.source] : D.LAYER_NAME[r.source] + '页') : '默认';
    toast(`${night() ? '已切回转播' : '已擦掉本页墨迹'}：${e(nm(id))} 现在${r.value === 'on' ? '开' : '关'}，${night() ? '信号来自' : '透上来的是'}${from}`);
  }
  function setRole(rid) {
    const p = page(); const d = draft(); const saved = p.role || null;
    if ((rid || null) === saved) delete d.roles[p.key]; else d.roles[p.key] = rid || null;
    S.rolePick = false; S.fx = { type: 'role' }; S.focus = rid ? 'role-pick' : 'role-pick'; render();
    toast(rid ? `${night() ? '主持人上麦' : '人像贴好了'}：角色 ${rid} · ${e(D.ROLES[rid].name)}（只在这一页）` : (night() ? '主持人已下麦：这个台停播' : '人像已取下：这一页不会回复'));
  }
  function commit(a, d) {
    Object.entries(d.layers).forEach(([k, o]) => { a.layers[k] = a.layers[k] || {}; Object.entries(o).forEach(([id, v]) => { if (v) a.layers[k][id] = v; else delete a.layers[k][id]; }); });
    Object.entries(d.roles).forEach(([k, r]) => { const p = pageOf(a, k); if (p) p.role = r || null; });
    S.drafts[a.id] = { layers: {}, roles: {} };
  }
  function seal(kind, a) {
    const st = $('#seal'); st.className = 'seal'; void st.offsetWidth; st.classList.add('show', 'k-' + kind);
    const T = { ok: [tl('落款成功', '信号确认'), tl(a.id + ' 本 · 示例', 'ACK · ' + a.id + ' 台')], fail: [tl('没盖上', '信号中断'), tl('改动还在', 'NO ACK')], unknown: [tl('墨迹未干', '未收到回执'), tl('待核对', 'PENDING')], conflict: [tl('撞页了', '同频干扰'), tl('别处也改了', 'CONFLICT')] }[kind];
    st.innerHTML = `<b>${T[0]}</b><small>${T[1]}</small><i class="ink" aria-hidden="true"></i>`;
    clearTimeout(seal.t); seal.t = setTimeout(() => st.classList.remove('show'), kind === 'ok' ? 1800 : 2400);
  }
  function save() {
    if (S.save.state === 'conflict') { resolveConflicts(); return; }
    const a = acc(), d = draft(); if (!V.draftCount(a.id) || S.save.state === 'pending') return;
    S.save.state = 'pending'; S.focus = null; render(); live(night() ? '发送中' : '落款中');
    const outcome = S.save.next; const aid = a.id;
    setTimeout(() => {
      const a2 = db.acc[aid]; if (!a2) return;
      if (outcome === 'ok') { commit(a2, S.drafts[aid]); S.save.state = 'idle'; render(); seal('ok', a2); live(night() ? '信号确认：已播出保存（示例：只存在本页内存）' : '落款成功：已保存（示例：只存在本页内存）'); }
      else if (outcome === 'fail') { S.save.state = 'fail'; S.focus = 'save'; render(); seal('fail', a2); live(night() ? '信号中断：没有保存，改动还在，可以重新发送' : '落款没盖上：没有保存，改动还在，可以再盖一次'); }
      else if (outcome === 'conflict') { S.save.state = 'conflict'; S.save.cf = makeConflicts(a2, S.drafts[aid]); S.focus = 'cf-pick-0-mine'; render(); live(night() ? `同频干扰：另一台设备也改了 ${S.save.cf.length} 处，请逐条选播谁的` : `撞页了：别处也改了这本里的 ${S.save.cf.length} 处，请逐条选用谁的`); }
      else { S.save.state = 'unknown'; S.focus = 'verify'; render(); seal('unknown', a2); live(night() ? '未收到回执：不确定是否已保存，请核对' : '墨迹没干：不确定是否已保存，请核对'); }
    }, 900);
  }
  // ---------- 冲突（v3）：保存时发现别处（另一台电脑上的 Nowadays，示例）也改了同样的地方 ----------
  function makeConflicts(a, d) {
    const out = [];
    Object.entries(d.layers).forEach(([k, o]) => Object.entries(o).forEach(([id, v]) => { if (out.length >= 3) return;
      const base = (a.layers[k] || {})[id] || null; let th = v === 'on' ? 'off' : v === 'off' ? 'on' : (base === 'on' ? 'off' : 'on'); if (th === v) th = null;
      out.push({ kind: 'item', k, id, mine: v || null, theirs: th, pick: 'mine' }); }));
    Object.entries(d.roles).forEach(([k, r]) => { if (out.length >= 3) return; const alt = Object.values(D.ROLES).find(x => x.id !== r && (x.src === 'public' || x.owner === a.id));
      out.push({ kind: 'role', k, mine: r || null, theirs: alt ? alt.id : null, pick: 'mine' }); });
    return out;
  }
  const vLab = (c, v) => c.kind === 'role' ? (v ? `${night() ? '主持人' : '人像'}：角色 ${v} · ${e(D.ROLES[v].name)}` : (night() ? '空麦（不会回复）' : '没请人（不会回复）'))
    : v === 'on' ? tl('本页贴上 · 开', '本台直播 · 开') : v === 'off' ? tl('本页揭下 · 关', '本台关') : tl('擦掉 · 跟随上层', '切回转播 · 跟随上级');
  function conflictHtml(a) {
    const cf = S.save.cf || [];
    const row = (c, i) => { const p = pageOf(a, c.k); const where = p ? (p.type === 'conv' ? tl(`第 ${p.no} 页 · ${e(p.name)}`, `${p.freq.toFixed(1)} · ${e(p.name)}`) : tl(p.type === 'account' ? '扉页' : D.LAYER_NAME[p.key] + '页', p.type === 'account' ? '总台' : D.NIGHT_LAYER[p.key])) : c.k;
      const what = c.kind === 'role' ? tl('人像（角色卡）', '主持人') : `${D.DEF[c.id].type === 'plugin' ? '插件' : 'Skill'} ${c.id} · ${e(D.DEF[c.id].name)}`;
      const b = (v, t) => `<button type="button" class="cf-opt o-${v}" data-act="cf-pick" data-i="${i}" data-v="${v}" data-k="cf-pick-${i}-${v}" aria-pressed="${c.pick === v}"><small>${t}</small><b>${vLab(c, v === 'mine' ? c.mine : c.theirs)}</b></button>`;
      return `<li class="cf-row" role="group" aria-label="${e(what.replace(/<[^>]+>/g, ''))}：选用哪一边"><p class="cf-what"><b>${what}</b><span>${where}</span></p><div class="cf-pair">${b('mine', tl('你的笔迹', '你的信号'))}${b('theirs', tl('对方的笔迹 · 另一台电脑 · 刚刚', '对方信号 · 另一台设备 · 刚刚'))}</div></li>`; };
    const nTh = cf.filter(c => c.pick === 'theirs').length;
    return `<section class="cf" role="dialog" aria-modal="false" aria-labelledby="cf-t">
      <header><p class="kicker">${tl('落款前对一下', '发送前对一下频')}</p><h3 id="cf-t">${tl('撞页了：这几处在别处也被改过', '同频干扰：这几个频率上还有另一路信号')}</h3>
        <p class="cap">${tl('两张复写纸叠在一起，笔迹对不上。逐条选用谁的；没冲突的改动照常落款。', '两路信号同时打在一个频率上。逐条选播谁的；没冲突的改动照常播出。')}（示例：「对方」是模拟出来的）</p></header>
      <ol class="cf-list">${cf.map(row).join('')}</ol>
      <footer><button type="button" class="btn ghost compact" data-act="cf-all" data-v="mine" data-k="cf-all-mine">${tl('全用我的', '全播我的')}</button><button type="button" class="btn ghost compact" data-act="cf-all" data-v="theirs" data-k="cf-all-theirs">${tl('全用对方的', '全换成对方的')}</button>
        <span class="sp"></span><button type="button" class="link small" data-act="cf-later" data-k="cf-later">${tl('先不落款', '先不发送')}</button><button type="button" class="btn commit" data-act="cf-apply" data-k="cf-apply">${tl('按选择落款', '按选择发送')}${nTh ? `<small>（${nTh} 处用对方的）</small>` : ''}</button></footer></section>`;
  }
  function resolveConflicts() {
    const a = acc(), d = draft(); const cf = S.save.cf || []; let keep = 0, take = 0;
    cf.forEach(c => { if (c.pick === 'mine') { keep++; return; } take++;
      if (c.kind === 'role') { const p = pageOf(a, c.k); if (p) p.role = c.theirs; delete d.roles[c.k]; }
      else { a.layers[c.k] = a.layers[c.k] || {}; if (c.theirs) a.layers[c.k][c.id] = c.theirs; else delete a.layers[c.k][c.id]; if (d.layers[c.k]) { delete d.layers[c.k][c.id]; if (!Object.keys(d.layers[c.k]).length) delete d.layers[c.k]; } } });
    S.save.cf = null; S.save.state = 'pending'; S.focus = null; render();
    setTimeout(() => { commit(a, S.drafts[a.id]); S.save.state = 'idle'; S.focus = 'page-title'; render(); seal('ok', a); toast(`${night() ? '信号确认' : '落款成功'}：保留你的 ${keep} 处${take ? `，采用对方的 ${take} 处` : ''}（示例）`); }, 700);
  }
  V.conflictHtml = conflictHtml;
  function verify() {
    const a = acc(); S.save.state = 'pending'; render();
    setTimeout(() => { commit(a, S.drafts[a.id]); S.save.state = 'idle'; render(); seal('ok', a); toast(night() ? '核对完成：回执到了，改动已经播出（示例）' : '核对完成：墨迹已干，改动已经落款（示例）'); }, 700);
  }
  function sfx() { /* 无声：原型不播放声音 */ }

  // ---------- 账号 / 页 ----------
  function switchAcc(id, then) {
    if (id === S.acc) { if (then) then(); return; }
    const book = $('#book'); const from = S.acc;
    const go = () => { if (S.save.state === 'conflict') { S.save.state = 'idle'; S.save.cf = null; } S.acc = id; S.sheet = false; S.sheetSel = null; S.rolePick = false; S.index = then ? false : S.index; render(); if (then) then(); live(`已换到账号 ${id}`); };
    if (V.reduced()) { go(); return; }
    const spineOf = (a) => document.querySelector(`#shelf [data-k="acc-${a}"]`);
    const ok = V.startVT(() => {}, true) !== null;  // 只探测能力
    if (ok) {
      const sp = $('#book .spread'), toS = spineOf(id); if (sp) sp.style.viewTransitionName = 'wj-acc-out'; if (toS) toS.style.viewTransitionName = 'wj-acc-in';
      document.documentElement.dataset.vt = 'acc';
      const vt = V.startVT(() => { if (sp) sp.style.viewTransitionName = ''; if (toS) toS.style.viewTransitionName = ''; go(); const fs = spineOf(from), ns = $('#book .spread'); if (fs) fs.style.viewTransitionName = 'wj-acc-out'; if (ns) ns.style.viewTransitionName = 'wj-acc-in'; });
      if (vt) { V.lastVT = vt; vt.finished.finally(() => { delete document.documentElement.dataset.vt; const fs = spineOf(from), ns = $('#book .spread'); if (fs) fs.style.viewTransitionName = ''; if (ns) ns.style.viewTransitionName = ''; }); return; }
      delete document.documentElement.dataset.vt; if (sp) sp.style.viewTransitionName = ''; if (toS) toS.style.viewTransitionName = '';
    }
    // 退路（不支持 View Transition）：同一个方向的 2D 缩放，缩向 / 放自书架上那本的位置
    const ox = (a) => { const s = spineOf(a), b = book.getBoundingClientRect(); if (!s) return '8%'; const r = s.getBoundingClientRect(); return (r.left + r.width / 2 - b.left) + 'px'; };
    book.style.setProperty('--acc-ox', ox(from)); book.dataset.anim = 'closing'; book.classList.add('closing');
    setTimeout(() => { book.classList.remove('closing'); book.style.setProperty('--acc-ox', ox(id)); book.dataset.anim = 'opening'; go(); setTimeout(() => { delete book.dataset.anim; book.classList.remove('opening'); }, 480); }, 300);
  }
  function goPage(key, opts) {
    if (key === S.page[S.acc] && !opts) return;
    S.page[S.acc] = key; S.rolePick = false; S.sheet = S.sheet && page().type === 'conv' ? S.sheet : S.sheet;
    const book = $('#book'); book.dataset.anim = 'turning'; render(); setTimeout(() => { delete book.dataset.anim; book.classList.remove('turning'); }, V.reduced() ? 0 : 560);
    if (!opts) S.focus = null;
  }
  function stepPage(dir) { const a = acc(); const i = a.pages.findIndex(p => p.key === S.page[a.id]); const j = Math.max(0, Math.min(a.pages.length - 1, i + dir)); if (j !== i) { const onStn = document.activeElement && document.activeElement.classList.contains('stn'); if (onStn) S.focus = 'stn-' + a.pages[j].key; goPage(a.pages[j].key, onStn || undefined); } }
  function gotoRef(accId, key, id) {
    S.index = false; S.impact = null;
    const after = () => { S.page[S.acc] = key; S.fx = id ? { type: 'flash', id } : { type: 'role' }; S.focus = id ? 'cell-' + id : 'page-title'; render(); };
    if (accId !== S.acc) switchAcc(accId, after); else { const book = $('#book'); book.dataset.anim = 'turning'; after(); setTimeout(() => { delete book.dataset.anim; book.classList.remove('turning'); }, 560); }
  }
  V.switchAcc = switchAcc; V.goPage = goPage; V.paste = paste; V.peel = peel; V.erase = erase; V.save = save; V.gotoRef = gotoRef;

  function fix(code, id) {
    const p = page();
    if (code === 'qq') { const sp = document.querySelector(`[data-k="acc-${S.acc}"]`); if (sp) { sp.classList.remove('fx-ping'); void sp.offsetWidth; sp.classList.add('fx-ping'); }
      toast(`账号 ${S.acc} 的 QQ 没连上：在「更多 › 实例与监听」里由你手动启动 QQ 与 SnowLuma（原型不可操作）。配置照样可以看、可以改。`); return; }
    if (code === 'missing') { S.sheet = true; S.sheetSel = id; S.rolePick = false; S.fx = { hint: id }; S.focus = 'install'; render(); return; }
    const target = code === 'dep' ? D.DEF[id].plugin : id;
    S.sheet = true; S.sheetSel = target; S.fx = { hint: target }; S.focus = code === 'auth' ? 'grant' : code === 'ready' ? 'ready' : 'stk-' + target; render();
  }
  function grant(id) { const a = acc(); a.auth.push(D.DEF[id].tool[0]); S.fx = { type: 'fixed', id }; S.focus = 'stk-' + id; render(); toast(`已授权「${e(D.DEF[id].tool[1])}」给 ${a.id} ${night() ? '台' : '本'}（模拟）：${night() ? '故障灯熄了' : '红笔批注划掉了'}`); }
  function ready(id) { const a = acc(); a.ready[id] = true; S.fx = { type: 'fixed', id }; S.focus = 'stk-' + id; render(); toast(`插件 ${id} 已重新载入（模拟）：${night() ? '故障灯熄了' : '红笔批注划掉了'}`); }

  // ---------- 点击 ----------
  const ACT = {
    acc: (el) => { if (S.ov.open) V.closeOv(null, true); switchAcc(el.dataset.v); }, page: (el) => { S.index = false; if (S.ov.open) { V.openFromOv(S.acc, el.dataset.v); return; } goPage(el.dataset.v); },
    xray: () => { if (!S.ov.open) setXray(!S.xray, true); }, index: () => { S.index = !S.index; S.sheet = false; S.impact = null; S.focus = S.index ? 'close-ix' : null; const book = $('#book'); book.dataset.anim = 'turning'; render(); setTimeout(() => { delete book.dataset.anim; book.classList.remove('turning'); }, 560); },
    sheet: () => { S.sheet = !S.sheet; S.rolePick = false; S.focus = S.sheet ? 'stk-' + (S.sheetSel || acc().sheet[0]) : 'sheet-btn'; render(); },
    stk: (el) => { S.sheetSel = el.dataset.id; S.focus = 'stk-' + el.dataset.id; render(); },
    paste: (el) => paste(el.dataset.id), peel: (el) => peel(el.dataset.id), erase: (el) => erase(el.dataset.id),
    'role-pick': () => { S.rolePick = true; S.sheet = false; const r = D.roleOf(acc(), draft(), page()); S.focus = 'pick-' + (r ? r.id : 'R'); render(); },
    'role-close': () => { S.rolePick = false; S.focus = 'role-pick'; render(); }, 'role-set': (el) => setRole(el.dataset.v), 'role-clear': () => setRole(null),
    undo: () => { S.drafts[S.acc] = { layers: {}, roles: {} }; S.save.state = 'idle'; render(); toast(night() ? '已撤回待播出的改动' : '已撤销没落款的改动'); }, save: () => save(),
    install: (el) => install(el.dataset.id), 'inst-auth': () => { S.instAuth = S.instAuth === false; S.focus = 'inst-auth'; render(); },
    fix: (el) => fix(el.dataset.v, el.dataset.id || el.closest('.cell')?.dataset.id), grant: (el) => grant(el.dataset.id), ready: (el) => ready(el.dataset.id),
    goto: (el) => gotoRef(el.dataset.acc, el.dataset.page, el.dataset.id), impact: (el) => { S.impact = S.impact === el.dataset.v ? null : el.dataset.v; S.focus = 'imp-' + el.dataset.v.replace(':', '-'); render(); },
    verify: () => verify(), ov: () => V.toggleOv(), demo: () => toggleDemo(),
    'cf-pick': (el) => { const c = S.save.cf[+el.dataset.i]; c.pick = el.dataset.v; S.focus = el.dataset.k; render(); },
    'cf-all': (el) => { S.save.cf.forEach(c => { c.pick = el.dataset.v; }); S.focus = el.dataset.k; render(); },
    'cf-apply': () => resolveConflicts(), 'cf-later': () => { S.save.state = 'idle'; S.save.cf = null; S.focus = 'save'; render(); toast(night() ? '先不发送：你的改动还在，没有播出' : '先不落款：你的改动还在，没有保存'); },
    'demo-set': (el) => demoSet(el.dataset.g, el.dataset.v),
    theme: (el) => window.WJTheme.set(el.dataset.v), toast: (el) => toast(e(el.dataset.msg))
  };
  document.addEventListener('click', (ev) => {
    if (dragJustEnded) { dragJustEnded = false; return; }
    const el = ev.target.closest('[data-act]'); if (!el) return;
    const f = ACT[el.dataset.act]; if (f) { ev.preventDefault(); f(el); }
  });

  // ---------- 掀纸透光 / 信号来路 ----------
  function setXray(on, sticky) { if (S.xray === on) return; S.xray = on; S.xraySticky = on && sticky; const b = $('#book'); b.classList.toggle('xray', on); document.querySelectorAll('[data-act="xray"]').forEach(x => x.setAttribute('aria-pressed', on)); $('.xr-role') && $('.xr-role').setAttribute('aria-hidden', !on); live(on ? (night() ? '显示信号来路' : '掀开纸页：每一项来自哪一层') : '已放下'); }
  V.setXray = setXray;

  // ---------- 键盘 ----------
  document.addEventListener('keydown', (ev) => {
    const t = ev.target; const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && ev.key.toLowerCase() === 'd') { ev.preventDefault(); toggleDemo(); return; }
    if (typing) { if (ev.key === 'Escape' && S.ov.open) { ev.preventDefault(); if (t.value) { t.value = ''; V.ovSearch(''); } else t.blur(); } return; }
    if (t && t.closest && t.closest('#demo')) { if (ev.key === 'Escape') { ev.preventDefault(); toggleDemo(false); } return; }
    if (S.ov.open && V.ovKey(ev)) return;
    if (ev.code === 'Space' && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); if (!ev.repeat && !S.index) setXray(true, false); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); return; }
    if (ev.altKey && /^[1-3]$/.test(ev.key)) { ev.preventDefault(); switchAcc(db.order[+ev.key - 1]); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') { if ($('#demo') && !$('#demo').hidden) toggleDemo(false); else if (S.save.state === 'conflict') ACT['cf-later'](); else if (S.rolePick) ACT['role-close'](); else if (S.impact) { S.impact = null; render(); } else if (S.sheet) ACT.sheet(); else if (S.index) ACT.index(); else if (S.xray) setXray(false); return; }
    const k = ev.key.toLowerCase();
    if (k === 'o' || k === 'i') { V.toggleOv(); return; }
    const stn = t.closest && t.closest('.stn');
    if (stn && ['Home', 'End', 'PageUp', 'PageDown'].includes(ev.key)) { ev.preventDefault(); const ps = acc().pages; const i = ps.findIndex(q => q.key === S.page[S.acc]);
      const j = ev.key === 'Home' ? 0 : ev.key === 'End' ? ps.length - 1 : Math.max(0, Math.min(ps.length - 1, i + (ev.key === 'PageUp' ? -6 : 6))); S.focus = 'stn-' + ps[j].key; goPage(ps[j].key, true); return; }
    if (k === 'b' && !S.index) { ACT.sheet(); return; }
    const cell = t.closest && t.closest('.cell'); const stk = t.closest && t.closest('.stk');
    if (cell && !t.closest('button')) {
      const id = cell.dataset.id;
      if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); if (!cell.classList.contains('m-peeled')) peel(id); return; }
      if (k === 'e') { if (!cell.classList.contains('m-carbon')) erase(id); return; }
      if (ev.key === 'Enter') { ev.preventDefault(); if (!cell.classList.contains('m-ink')) paste(id); return; }
    }
    if (stk && ev.key === 'Enter') { ev.preventDefault(); if (stk.classList.contains('missing')) { S.sheetSel = stk.dataset.id; S.focus = 'install'; render(); } else paste(stk.dataset.id); return; }
    if (ev.key.startsWith('Arrow')) {
      const grid = cell ? [...document.querySelectorAll('#cells .cell')] : stk ? [...document.querySelectorAll('.stickers .stk')] : null;
      if (grid) { ev.preventDefault(); const cols = cell ? 3 : 2; const i = grid.indexOf(cell || stk); const dlt = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[ev.key]; const n = grid[Math.max(0, Math.min(grid.length - 1, i + dlt))]; if (n) n.focus(); return; }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { ev.preventDefault(); stepPage(ev.key === 'ArrowLeft' ? -1 : 1); }
    }
  });
  document.addEventListener('keyup', (ev) => { if (ev.code === 'Space' && S.xray && !S.xraySticky) setXray(false); });
  window.addEventListener('blur', () => { if (S.xray && !S.xraySticky) setXray(false); });

  // ---------- 拖拽：贴贴纸 / 插设备；拖出即揭下 / 拔掉 ----------
  let drag = null, dragJustEnded = false;
  document.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return; const src = ev.target.closest('.stk, .cell'); if (!src || ev.target.closest('button:not(.stk)')) return;
    if (src.classList.contains('cell') && src.classList.contains('m-peeled')) return;
    if (src.classList.contains('missing')) return;
    drag = { src, id: src.dataset.id, from: src.classList.contains('stk') ? 'sheet' : 'page', x0: ev.clientX, y0: ev.clientY, on: false, pid: ev.pointerId };
  });
  document.addEventListener('pointermove', (ev) => {
    if (!drag) return; const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
    if (!drag.on && Math.hypot(dx, dy) > 6) startDrag(ev);
    if (drag.on) { moveGhost(ev.clientX, ev.clientY); const over = overRight(ev.clientX, ev.clientY); $('#book').classList.toggle('drop-hot', drag.from === 'sheet' && over); $('#book').classList.toggle('peel-hot', drag.from === 'page' && !over); }
  });
  document.addEventListener('pointerup', (ev) => {
    if (!drag) return; const d0 = drag; drag = null; if (!d0.on) return;
    dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 0);
    const book = $('#book'); book.classList.remove('dragging', 'drop-hot', 'peel-hot', 'drag-in', 'drag-out');
    const over = overRight(ev.clientX, ev.clientY); const g = d0.ghost;
    if (d0.from === 'sheet' && over) { g.classList.add('land'); setTimeout(() => g.remove(), 260); paste(d0.id); }
    else if (d0.from === 'page' && !over) { g.style.transform += ' translate(40px,-70px) rotate(16deg)'; g.classList.add('fly'); setTimeout(() => g.remove(), 440); peel(d0.id, true); }
    else { const r = d0.src.getBoundingClientRect(); g.style.transition = 'transform 260ms cubic-bezier(.2,0,0,1), opacity 260ms'; g.style.transform = `translate(${r.left}px,${r.top}px) rotate(0deg)`; g.style.opacity = '0'; d0.src.classList.remove('lifted'); setTimeout(() => g.remove(), 280); }
  });
  function overRight(x, y) { const r = $('.leaf.right') && $('.leaf.right').getBoundingClientRect(); return r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }
  function startDrag(ev) {
    drag.on = true; const r = drag.src.getBoundingClientRect(); drag.ox = drag.x0 - r.left; drag.oy = drag.y0 - r.top;
    const g = document.createElement('div'); g.className = 'dragghost ' + (drag.from === 'sheet' ? 'from-sheet' : 'from-page') + ' ty-' + D.DEF[drag.id].type;
    g.innerHTML = `<span class="glyph g-${drag.id}">${A.glyph(drag.id)}</span><span><b>${e(D.DEF[drag.id].name)}</b><small>${D.DEF[drag.id].type === 'plugin' ? '插件' : 'Skill'} ${drag.id}</small></span><i class="cable" aria-hidden="true"></i>`;
    g.style.width = Math.min(r.width, 240) + 'px'; document.body.appendChild(g); drag.ghost = g; drag.src.classList.add('lifted');
    $('#book').classList.add('dragging', drag.from === 'sheet' ? 'drag-in' : 'drag-out'); moveGhost(ev.clientX, ev.clientY);
  }
  function moveGhost(x, y) { const g = drag.ghost; const rot = Math.max(-8, Math.min(8, (x - drag.x0) / 40)); g.style.transform = `translate(${x - Math.min(drag.ox, 200)}px,${y - drag.oy}px) rotate(${rot}deg)`; }

  // ---------- 演示开关（隐藏面板：设置按钮 / Ctrl+Shift+D） ----------
  function demoHtml() {
    const g = (key, label, opts, cur) => `<fieldset><legend>${label}</legend><div class="seg">${opts.map(([v, t]) => `<button type="button" data-act="demo-set" data-g="${key}" data-v="${v}" data-k="demo-${key}-${v}" aria-pressed="${cur === v}">${t}</button>`).join('')}</div></fieldset>`;
    const m = document.documentElement.dataset.motion || 'system';
    return `<header><b>演示开关</b><small>只给评审用，不是产品功能</small><button type="button" class="icon-btn" data-act="demo" aria-label="关闭演示开关">×</button></header>
      ${g('data', '示例数据', [['std', '标准（3 本 · 16 页）'], ['big', '大量会话（60 个会话）']], S.big ? 'big' : 'std')}
      ${g('save', '下一次保存的结果', [['ok', '成功'], ['fail', '失败'], ['unknown', '结果未知'], ['conflict', '冲突']], S.save.next)}
      ${g('vt', '页面过渡（View Transition）', [['on', '浏览器原生'], ['off', '模拟不支持']], document.documentElement.dataset.novt === '1' ? 'off' : 'on')}
      ${g('motion', '动效', [['system', '跟随系统'], ['full', '完整'], ['reduced', '减少']], m)}
      <p class="cap">快捷键：O 摊开全本 / 全频扫描 · ← → 翻页 · 空格 掀开 · B 封底 · Alt+1~3 换账号 · Ctrl+S 保存</p>`;
  }
  function toggleDemo(force) {
    const d = $('#demo'); const open = force === undefined ? d.hidden : force;
    if (open) { d.innerHTML = demoHtml(); d.hidden = false; const b = d.querySelector('[aria-pressed="true"]'); b && b.focus(); }
    else { d.hidden = true; const b = $('[data-act="demo"].icon-btn'); b && b.focus(); }
    document.querySelectorAll('[data-act="demo"].icon-btn').forEach(b => b.setAttribute('aria-expanded', open));
  }
  function demoSet(g, v) {
    if (g === 'data') { const big = v === 'big'; if (big !== S.big) { V.setDataset(big); render(); toast(big ? '已换成大量会话示例：A 本 46 个会话、B 本 8 个、C 本 6 个（全部虚构）' : '已换回标准示例数据'); } }
    if (g === 'save') { S.save.next = v; live('下一次保存的结果：' + ({ ok: '成功', fail: '失败', unknown: '结果未知', conflict: '冲突' })[v]); }
    if (g === 'vt') { if (v === 'off') document.documentElement.dataset.novt = '1'; else delete document.documentElement.dataset.novt; live(v === 'off' ? '已模拟不支持 View Transition：所有过渡走退路' : '使用浏览器原生 View Transition'); }
    if (g === 'motion') { document.documentElement.dataset.motion = v; live('动效：' + ({ system: '跟随系统', full: '完整', reduced: '减少' })[v]); }
    const d = $('#demo'); d.innerHTML = demoHtml(); const b = d.querySelector(`[data-k="demo-${g}-${v}"]`); b && b.focus();
  }
  V.toggleDemo = toggleDemo; V.demoSet = demoSet;

  // ---------- 启动 ----------
  V.ACT = ACT; V.live = live; V.save2 = save; V.verify = verify;
  render();
})();
