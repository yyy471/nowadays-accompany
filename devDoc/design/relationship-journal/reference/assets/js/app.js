/* 接线 · 手账 / 电台 —— 同一套骨架、同一份状态；主题只换外观。 */
(function () {
  'use strict';
  const D = window.WJData, A = window.WJArt;
  const BIG0 = /(^|[#&])data=big/.test(location.hash);
  const db = D.seed(BIG0);
  const LS = 'nowadays.wiringJournal.theme';
  const nd = () => ({ layers: {}, roles: {} });
  const S = window.WJState = {
    acc: 'A', page: { A: 'c:C', B: 'c:C', C: 'c:M' }, sheet: false, sheetSel: null, xray: false, index: false,
    drafts: { A: nd(), B: nd(), C: nd() }, fx: null, rolePick: false, impact: null, busy: false,
    ov: { open: false, scope: 'acc', q: '', filter: 'all', cause: null, focus: null, scroll: null, last: null, from: false },
    save: { state: 'idle', next: 'ok' }, big: BIG0
  };
  const firstConv = (a) => (a.pages.find(p => p.type === 'conv') || a.pages[0]).key;
  if (BIG0) db.order.forEach(id => { S.page[id] = firstConv(db.acc[id]); });
  // 演示开关：切换数据集时原地替换 db，保证各模块拿到的是同一个对象
  function setDataset(big) {
    const n = D.seed(big); Object.keys(db).forEach(k => delete db[k]); Object.assign(db, n);
    S.big = !!big; db.order.forEach(id => { S.drafts[id] = nd(); S.page[id] = big ? firstConv(db.acc[id]) : ({ A: 'c:C', B: 'c:C', C: 'c:M' })[id]; });
    S.sheet = false; S.sheetSel = null; S.rolePick = false; S.impact = null; S.save.state = 'idle';
    Object.assign(S.ov, { q: '', filter: 'all', cause: null, focus: null, scroll: null, last: null, from: false });
    builtTicksFor = null;
  }
  const $ = (s, r) => (r || document).querySelector(s);
  const e = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tl = (d, n) => `<span class="tl"><span class="d">${d}</span><span class="n">${n}</span></span>`;
  const reduced = () => document.documentElement.dataset.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const night = () => document.documentElement.dataset.uiPreset === 'nightwave';
  const acc = () => db.acc[S.acc];
  const draft = () => S.drafts[S.acc];
  const pageOf = (a, k) => a.pages.find(p => p.key === k);
  const page = () => pageOf(acc(), S.page[S.acc]);
  const LN = (k) => D.LAYER_NAME[k], NN = (k) => D.NIGHT_LAYER[k];
  const FMIN = 87, FMAX = 108; const fx = (f) => ((f - FMIN) / (FMAX - FMIN) * 100).toFixed(3);
  const pageTitle = (p) => p.type === 'conv' ? `会话 ${p.id} · ${p.name}` : p.name;
  let uid = 0;

  let builtTicksFor = null;
  // ---------- 计算 ----------
  function itemsOn(a, d, p) {
    const ids = [...a.sheet]; Object.keys(a.layers).forEach(k => Object.keys(a.layers[k]).forEach(id => { if (!ids.includes(id)) ids.push(id); }));
    return ids.map(id => ({ id, r: D.resolve(a, d, p, id) })).filter(x => x.r.value === 'on' || x.r.own === 'off')
      .map(x => ({ ...x, iss: x.r.value === 'on' ? D.issues(a, d, p, x.id) : [] }));
  }
  function draftCount(accId) {
    const d = S.drafts[accId]; let n = 0; Object.values(d.layers).forEach(o => n += Object.keys(o).length); n += Object.keys(d.roles).length; return n;
  }
  function verdict(a, d, p) {
    const role = D.roleOf(a, d, p);
    const why = [];
    if (!role) why.push(['role', tl('还没请人来', '还没有主持人')]);
    if (a.status !== 'online') why.push(['qq', 'QQ 没连上']);
    return { ok: !why.length, role, why };
  }

  // ---------- 书架 / 机架 ----------
  function renderShelf() {
    const host = $('#shelf');
    host.innerHTML = `<div class="shelf-row" role="group" aria-label="QQ 账号">${db.order.map(id => { const a = db.acc[id]; const cur = id === S.acc; const n = draftCount(id);
      return `<button type="button" class="spine c-${a.cover} st-${a.status}${cur ? ' cur' : ''}" data-act="acc" data-v="${id}" data-k="acc-${id}" aria-pressed="${cur}" title="账号 ${id} · ${e(a.name)} · QQ ${a.qq} · ${a.status === 'online' ? '已连接' : '未连接'}">
        <span class="sp-top"><span class="led" aria-hidden="true"></span><b>${id}</b></span>
        <span class="sp-name">${e(a.name)}</span>
        <span class="sp-grille" aria-hidden="true"></span>
        <span class="sp-band">${a.status === 'online' ? '在线' : '未连'}</span>${n ? `<i class="sp-draft" title="${n} 处改动未保存">${n}</i>` : ''}</button>`; }).join('')}</div>
      <div class="shelf-plank" aria-hidden="true"></div>
      <p class="shelf-cap">${tl('书架', '机架')} · ${tl(`正在翻 <b>${S.acc} 本</b>`, `正在收听 <b>${S.acc} 台</b>`)} <span class="mono">QQ ${acc().qq}</span></p>`;
  }

  // ---------- 页签 / 调频刻度 ----------
    function renderStrip() {
    const a = acc(); const strip = $('#strip');
    if (builtTicksFor !== a.id) {
      let t = '';
      for (let f = FMIN + 0.5; f < FMAX; f += 0.5) { const maj = Math.abs(f - Math.round(f)) < 0.01 && Math.round(f) % 2 === 0; t += `<i class="tk${maj ? ' maj' : ''}" style="left:${fx(f)}%"></i>${maj ? `<span class="fq" style="left:${fx(f)}%">${Math.round(f)}</span>` : ''}`; }
      $('.ticks', strip).innerHTML = t; builtTicksFor = a.id;
    }
    const cur = S.page[S.acc]; const dense = a.pages.length > 12; strip.classList.toggle('dense', dense);
    const nG = a.pages.filter(p => p.type === 'conv' && p.kind === 'group').length, nP = a.pages.filter(p => p.type === 'conv' && p.kind === 'private').length;
    $('.band-g i', strip).innerHTML = `${tl('群聊页签', '群聊波段')} · ${nG}`; $('.band-p i', strip).innerHTML = `${tl('私聊页签', '私聊波段')} · ${nP}`;
    $('.stations', strip).innerHTML = a.pages.map(p => {
      const lab = p.type === 'account' ? tl('扉页', '总台') : p.type === 'kind' ? tl(p.kind === 'group' ? '群聊分类' : '私聊分类', p.kind === 'group' ? '群聊分台' : '私聊分台') : e(p.name);
      const role = D.roleOf(a, draft(), p);
      const bad = p.type === 'conv' && (a.status !== 'online' || itemsOn(a, draft(), p).some(x => x.r.value === 'on' && x.iss.length));
      const mini = dense && p.type === 'conv' && p.key !== cur;
      return `<button type="button" class="stn t-${p.type} k-${p.kind || 'acc'}${p.key === cur ? ' cur' : ''}${mini ? ' mini' : ''}${p.type === 'conv' && !role ? ' silent' : ''}${bad ? ' warn' : ''}" style="left:${fx(p.freq)}%" data-act="page" data-v="${p.key}" data-k="stn-${p.key}" tabindex="${p.key === cur ? 0 : -1}" aria-current="${p.key === cur ? 'page' : 'false'}" aria-label="${e(pageTitle(p))}，第 ${p.no} 页，${p.freq.toFixed(1)} MHz${p.type === 'conv' && !role ? '，没有角色卡' : ''}${bad ? '，有用不了的项' : ''}">
        <span class="no">${tl(String(p.no), p.freq.toFixed(1))}</span><span class="nm">${lab}</span><i class="dot" aria-hidden="true"></i>${mini ? `<span class="pop" aria-hidden="true"><b>${tl(String(p.no), p.freq.toFixed(1))}</b> ${e(p.name)}</span>` : ''}</button>`;
    }).join('');
    const p = page(); $('.needle', strip).style.left = fx(p.freq) + '%';
    $('.band-g', strip).style.left = fx(89.6) + '%'; $('.band-g', strip).style.width = (fx(99.1) - fx(89.6)) + '%';
    $('.band-p', strip).style.left = fx(99.4) + '%'; $('.band-p', strip).style.width = (fx(107.2) - fx(99.4)) + '%';
    // 当前页签/电台的名字压到分区标签上时，分区标签让位（不叠字）
    const cs = $('.stn.cur', strip), cr = cs && cs.getBoundingClientRect();
    ['.band-g i', '.band-p i'].forEach(q => { const b = $(q, strip); if (!b) return; b.classList.remove('yield'); if (!cr || !cr.width) return; const br = b.getBoundingClientRect(); if (br.right > cr.left - 6 && br.left < cr.right + 6) b.classList.add('yield'); });
    fan(strip);
  }
  // 大量会话：当前页签（电台名）比小旗宽。按顺序把左右邻居推开到刚好不被盖住，层页签之间也不再互相叠；
  // 当前页签不动（指针仍对准它的频率），推开量向两侧逐个衰减，像一摞旗子被手指拨开。
  const fanWas = {};
  function fan(strip) {
    strip = strip || $('#strip'); if (!strip) return;
    const st = [...strip.querySelectorAll('.stn')]; const want = {};
    const cur = strip.querySelector('.stn.cur');
    if (cur && st.length > 1) {
      const sr = strip.getBoundingClientRect();
      const it = st.map(el => { const r = el.getBoundingClientRect(); const t = parseFloat(el.style.translate) || 0; return { el, c: r.left - t + r.width / 2 - sr.left, w: r.width, mini: el.classList.contains('mini') }; }).sort((a, b) => a.c - b.c);
      const pos = it.map(x => x.c); const ci = it.findIndex(x => x.el === cur);
      const gap = (a, b) => (a.w + b.w) / 2 + (a.mini && b.mini ? -3 : a.mini || b.mini ? 2 : 4);
      for (let k = ci + 1; k < it.length; k++) pos[k] = Math.max(pos[k], pos[k - 1] + gap(it[k - 1], it[k]));
      for (let k = ci - 1; k >= 0; k--) pos[k] = Math.min(pos[k], pos[k + 1] - gap(it[k], it[k + 1]));
      it.forEach((x, k) => { const d = pos[k] - x.c; if (Math.abs(d) > .4) want[x.el.dataset.k] = d; });
    }
    st.forEach(el => { const k = el.dataset.k; const from = fanWas[k] || 0; const to = want[k] || 0; fanWas[k] = to; const px = (v) => v ? v.toFixed(1) + 'px 0' : '';
      el.style.translate = px(from); if (from !== to) requestAnimationFrame(() => requestAnimationFrame(() => { el.style.translate = px(to); })); });
  }
  window.addEventListener('resize', () => fan());

  // ---------- 左页：谁在说话 ----------
  // 左页中段：三秒答案的文字版（带着什么本事 / 为什么有的用不了），点原因直接去修
  function briefHtml(a, d, p, role) {
    const on = itemsOn(a, d, p).filter(x => x.r.value === 'on');
    const ok = on.filter(x => !x.iss.length), bad = on.filter(x => x.iss.length);
    const name = id => D.DEF[id] ? D.DEF[id].name : id;
    const okHtml = ok.length ? ok.map(x => `<span class="b-chip"><span class="glyph g-${x.id}">${A.glyph(x.id)}</span>${e(name(x.id))}</span>`).join('') : `<span class="cap">${tl('一样也没有', '一路也没有')}</span>`;
    const offline = a.status !== 'online';
    const badHtml = offline && bad.length ? `<li><button type="button" class="pen" data-act="fix" data-v="qq">${tl('QQ 没连上', '整台没信号：QQ 没连上')}</button><span>${tl('这本里的本事暂时都用不了', '所有设备都停在故障灯')}</span></li>`
      : bad.map(x => { const i = x.iss[0]; return `<li><b>${e(name(x.id))}</b><button type="button" class="pen" data-act="fix" data-v="${i.fix}" data-id="${x.id}">${tl(e(i.text), e(i.night.replace(/^.*?：/, '')))}</button></li>`; }).join('');
    return `<section class="brief" aria-label="本页带着的本事与用不了的原因">
      <p class="k">${role ? tl(`${e(role.name)} 带着`, `${e(role.name)} 手边的设备`) : tl('这一页贴着（没人用）', '推子开着（没人主持）')}</p>
      <div class="b-ok">${okHtml}</div>
      ${badHtml ? `<p class="k b-k">${tl('开了但用不了', '开着但故障')}</p><ul class="b-bad">${badHtml}</ul>` : ''}</section>`;
  }
  function leftConv(a, d, p) {
    const v = verdict(a, d, p); const role = v.role; uid++;
    const twins = db.order.filter(id => id !== a.id).map(id => db.acc[id]).map(b => ({ b, q: b.pages.find(q => q.type === 'conv' && q.kind === p.kind && q.peer === p.peer) })).filter(x => x.q);
    const frame = role ? `<figure class="portrait${S.fx && S.fx.type === 'role' ? ' fx-role' : ''}"><span class="tape" aria-hidden="true"></span><span class="ph">${A.portrait(role.look, uid)}</span><span class="rim" aria-hidden="true"></span><span class="mic">${A.mic}</span></figure>`
      : `<figure class="portrait empty"><span class="ph-empty"><span class="mic ghost">${A.mic}</span><b>${tl('还没请人来', '空麦克风')}</b><small>${tl('这一页没有贴人像', '这个台还没有主持人')}</small></span></figure>`;
    const roleTxt = role ? `<p class="k">${tl('贴在页首的人', '本台主持人')}</p><p class="role-n">角色 ${role.id} · ${e(role.name)}</p>
        <p class="role-s"><span class="src s-${role.src}">${role.src === 'public' ? '公共角色卡' : tl(`${a.id} 本私有`, `${a.id} 台私有`) + '角色卡'}</span> <span class="mono">${role.rev}</span></p>
        <div class="row"><button type="button" class="btn" data-act="role-pick" data-k="role-pick">${tl('换一位', '换主持人')}</button><button type="button" class="btn ghost" data-act="role-clear" data-k="role-clear">${tl('请走', '请下麦')}</button></div>`
      : `<p class="k">${tl('贴在页首的人', '本台主持人')}</p><p class="role-n none">${tl('没有角色卡', '没有主持人')}</p>
        <p class="role-s">${tl('角色卡要一页一页地请，扉页上的不会透下来。', '主持人逐台指定，总台不会派人。')}</p>
        <div class="row"><button type="button" class="btn entry" data-act="role-pick" data-k="role-pick">${tl('请一位角色', '请主持人上麦')}</button></div>`;
    const pick = S.rolePick ? rolePicker(a, d, p, role) : '';
    const verdictHtml = `<div class="verdict ${v.ok ? 'ok' : 'no'}${S.fx && S.fx.type === 'role' ? ' fx-v' : ''}" role="status"><span class="sr">${v.ok ? `这一页会回复：${e(role.name)}` : `这一页不会回复：${v.why.map(w => w[0] === 'qq' ? 'QQ 没连上' : '还没有角色卡').join('、')}`}</span>
        <div class="stamp" aria-hidden="true"><span class="lamp"></span><b>${v.ok ? tl('会回复', '播出中') : tl('不会回复', '停播')}</b><small>${v.ok ? tl('落款 ' + a.id + ' 本', 'ON THE AIR') : tl('未落款', 'OFF AIR')}</small></div>
        <p aria-hidden="true">${v.ok ? `<b>${e(role.name)}</b> ${tl('在这一页说话', '正在主持')}，${tl('带着右页的本事回复。', '用右边接入的设备回复。')}` : `<b>${tl('这一页不会回复', '这个台没有声音')}</b>：${v.why.map(w => w[0] === 'qq' ? `<button type="button" class="pen" data-act="fix" data-v="qq">${w[1]}</button>` : `<button type="button" class="pen" data-act="role-pick">${w[1]}</button>`).join('、')}。`}</p></div>`;
    const twin = twins.length ? `<p class="twin">${tl('同一个群也写在', '同一个群也在')} ${twins.map(x => `<button type="button" class="link" data-act="goto" data-acc="${x.b.id}" data-page="${x.q.key}">${tl(`${x.b.id} 本第 ${x.q.no} 页`, `${x.b.id} 台 ${x.q.freq.toFixed(1)}`)}</button>`).join('、')} —— ${tl('那是另一本，各记各的。', '那是另一台，各播各的。')}</p>` : '';
    return `${backLink()}<header class="lh"><p class="kicker">${tl(`第 ${p.no} 页 · ${p.kind === 'group' ? '群聊' : '私聊'}`, `${p.freq.toFixed(1)} MHz · ${p.kind === 'group' ? '群聊' : '私聊'}`)}</p>
        <h1 id="page-title" tabindex="-1">${e(pageTitle(p))}</h1><p class="meta">${tl(`${a.id} 本`, `${a.id} 台`)} · ${p.kind === 'group' ? '群' : 'QQ'} <span class="mono">${p.peer}</span></p>${twin}</header>
      <div class="who">${frame}<div class="who-txt">${roleTxt}</div>${pick}</div>${briefHtml(a, d, p, role)}${verdictHtml}
      <div class="xr-role" aria-hidden="${!S.xray}"><p>${tl('人像不透层', '主持人不转播')}</p><ol><li><span>${tl('扉页 · 账号通用', '总台')}</span><i>${tl('不放人像', '不派主持人')}</i></li><li><span>${tl(p.kind === 'group' ? '群聊分类页' : '私聊分类页', p.kind === 'group' ? '群聊分台' : '私聊分台')}</span><i>${tl('不放人像', '不派主持人')}</i></li><li class="win"><span>${tl('本页', '本台')}</span><i>${role ? '角色 ' + role.id : tl('空', '空麦')}</i></li></ol></div>`;
  }
  function backLink() { return S.ov.from ? `<button type="button" class="back-ov" data-act="ov" data-k="back-ov">${tl('← 回到全本', '← 回到全频扫描')}<kbd>O</kbd></button>` : ''; }
  function rolePicker(a, d, p, cur) {
    const list = Object.values(D.ROLES).filter(r => r.src === 'public' || r.owner === a.id); uid++;
    return `<div class="picker" role="dialog" aria-label="请一位角色"><p class="k">${tl(`${a.id} 本能请的角色卡`, `${a.id} 台能请的主持人`)}</p>
      <div class="pick-list">${list.map((r, i) => `<button type="button" class="pick${cur && cur.id === r.id ? ' cur' : ''}" data-act="role-set" data-v="${r.id}" data-k="pick-${r.id}"><span class="pp">${A.portrait(r.look, uid + '-' + i)}</span><span><b>${e(r.name)}</b><small>${r.src === 'public' ? '公共' : tl(a.id + ' 本私有', a.id + ' 台私有')} · ${r.rev}</small></span></button>`).join('')}</div>
      <button type="button" class="btn ghost compact" data-act="role-close">取消</button></div>`;
  }
  function leftLayer(a, d, p) {
    const isAcc = p.type === 'account';
    return `${backLink()}<header class="lh"><p class="kicker">${tl(`第 ${p.no} 页 · ${isAcc ? '扉页' : '分类页'}`, `${p.freq.toFixed(1)} MHz · ${isAcc ? '总台' : '分台'}`)}</p>
        <h1 id="page-title" tabindex="-1">${isAcc ? tl(`${a.id} 本 · 账号通用`, `${a.id} 台 · 总台`) : tl(e(p.name), p.kind === 'group' ? '群聊分台' : '私聊分台')}</h1>
        <p class="meta">${e(a.name)} · QQ <span class="mono">${a.qq}</span> · ${a.status === 'online' ? '已连接' : '<b class="bad-t">未连接</b>'}</p></header>
      <p class="explain">${isAcc ? tl('写在扉页上的，会复写到后面每一页；哪一页自己写了，就以那一页的实墨为准。', '总台的节目会转播到每个分台和电台；哪个台自己直播（ON AIR），就听它自己的。')
        : tl(`这一页写下的，会复写到后面每个${p.kind === 'group' ? '群聊' : '私聊'}页；它自己也透着扉页的复写印。`, `分台转播总台，再转播给每个${p.kind === 'group' ? '群聊' : '私聊'}电台；它也可以自己直播。`)}</p>
      <figure class="portrait empty barred"><span class="ph-empty"><span class="mic ghost">${A.mic}</span><b>${tl('这里不请人', '总台不派主持人')}</b><small>${tl('角色卡逐页请，没有账号默认角色', '主持人逐台指定，没有默认主持人')}</small></span></figure>
      <p class="pages-note">${tl('后面的页：', '下属电台：')}${a.pages.filter(q => q.type === 'conv' && (isAcc || q.kind === p.kind)).slice(0, 14).map(q => `<button type="button" class="link" data-act="page" data-v="${q.key}">${tl(q.no + ' ' + e(q.name), q.freq.toFixed(1) + ' ' + e(q.name))}</button>`).join('、')}${(() => { const n = a.pages.filter(q => q.type === 'conv' && (isAcc || q.kind === p.kind)).length; return n > 14 ? ` ${tl('…共 ' + n + ' 页', '…共 ' + n + ' 台')}，<button type="button" class="link" data-act="ov">${tl('摊开全本看', '全频扫描看')}</button>` : ''; })()}</p>`;
  }

  // ---------- 右页：带着什么本事 ----------
  function cellHtml(a, d, p, x) {
    const def = D.DEF[x.id]; const r = x.r; const src = D.srcLabel(a, x.id);
    const mode = r.own === 'on' ? 'ink' : r.own === 'off' ? 'peeled' : 'carbon';
    const bad = x.iss.length > 0;
    const srcName = r.source === 'default' ? '默认' : null;
    const fromD = r.source === 'acc' ? '扉页' : r.source.startsWith('k:') ? LN(r.source) + '页' : '默认';
    const fromN = r.source === 'acc' ? '总台' : r.source.startsWith('k:') ? NN(r.source) : '默认';
    const belowD = r.below.source === 'acc' ? '扉页' : r.below.source.startsWith('k:') ? LN(r.below.source) + '页' : '默认';
    const belowN = r.below.source === 'acc' ? '总台' : r.below.source.startsWith('k:') ? NN(r.below.source) : '默认';
    const how = mode === 'ink' ? tl('本页实墨 · 开', '<b class="onair">ON AIR</b> 本台直播 · 开')
      : mode === 'carbon' ? tl(`复写印 · 来自${fromD}`, `<b class="relay">转播</b> 来自${fromN}`)
      : tl(`本页揭下 · 关`, '<b class="onair off">ON AIR</b> 本台关');
    const under = mode === 'peeled' ? `<span class="under">${tl(`底下透着：${r.below.value === 'on' ? '开' : '关'}（${belowD}）`, `上级：${r.below.value === 'on' ? '开' : '关'}（${belowN}）`)}</span>` : '';
    const fxc = S.fx && S.fx.id === x.id ? ' fx-' + S.fx.type : '';
    const keys = D.chainKeys(p).slice().reverse();
    const wi = r.source === 'default' ? keys.length : keys.indexOf(r.source);
    const strata = `<ol class="strata" aria-label="来源层">${keys.map((k, ix) => { const v = r.chain.find(c => c.key === k).v; const win = r.source === k; const pass = ix < wi;
        const lab = k === p.key && p.type === 'conv' ? tl('本页', '本台') : k === 'acc' ? tl('扉页 · 账号通用', '总台 · 账号通用') : tl(LN(k) + '页', NN(k));
        return `<li class="st v-${v}${win ? ' win' : ''}${pass ? ' pass' : ''}" style="--i:${ix}"><span class="sl">${lab}</span><span class="sv">${v === 'on' ? '开' : v === 'off' ? '关' : tl('跟随', '转播')}</span><span class="sb">${win ? tl(k === p.key ? '本页实墨' : '透上来的', k === p.key ? 'ON AIR' : '信号源') : pass ? tl('透明', '转播 ↑') : tl('被盖住', '未播')}</span></li>`; }).join('')}
        ${r.source === 'default' ? `<li class="st win v-off" style="--i:${keys.length}"><span class="sl">${tl('定义默认', '出厂默认')}</span><span class="sv">关</span><span class="sb"></span></li>` : ''}</ol>`;
    const iss = bad ? x.iss[0] : null;
    const note = iss ? `<button type="button" class="note" data-act="fix" data-v="${iss.fix}" data-id="${x.id}" data-k="note-${x.id}" title="${e(iss.sub || '')}"><span class="lamp" aria-hidden="true"></span>${tl(e(iss.text), '故障：' + e(iss.night.replace(/^.*?：/, '')))}${x.iss.length > 1 ? ` <small>+${x.iss.length - 1}</small>` : ''}<span class="go" aria-hidden="true">→</span></button>` : '';
    const ok = mode !== 'peeled' && !bad ? `<span class="okmark">${tl('能用', '信号正常')}</span>` : '';
    const acts = mode === 'ink' ? `<button type="button" data-act="peel" data-id="${x.id}">${tl('揭下', '拔掉')}</button><button type="button" data-act="erase" data-id="${x.id}">${tl('橡皮擦 · 跟随', '切回转播')}</button>`
      : mode === 'carbon' ? `<button type="button" data-act="peel" data-id="${x.id}">${tl('揭下 · 本页关', '拔掉 · 本台关')}</button><button type="button" data-act="paste" data-id="${x.id}">${tl('描成实墨', '改为直播')}</button>`
      : `<button type="button" data-act="erase" data-id="${x.id}">${tl('橡皮擦 · 跟随', '切回转播')}</button><button type="button" data-act="paste" data-id="${x.id}">${tl('重新贴上', '重新插上')}</button>`;
    return `<div class="cell m-${mode}${bad ? ' bad' : ''} ty-${def.type}${fxc}" data-id="${x.id}" data-k="cell-${x.id}" tabindex="0" role="group"
        aria-label="${def.type === 'plugin' ? '插件' : 'Skill'} ${x.id} ${e(def.name)}：${mode === 'ink' ? '本层开启' : mode === 'carbon' ? '跟随上层，开启' : '本层关闭'}${bad ? '，用不了：' + e(iss.text) : ''}">
      <div class="face"><span class="glyph g-${x.id}">${A.glyph(x.id)}</span>
        <div class="ct"><b class="nm">${e(def.name)}</b><span class="tag">${def.type === 'plugin' ? '插件' : 'Skill'} ${x.id}</span>
          <span class="src s-${src.cls}">${tl(src.d, src.n)}</span><span class="how">${how}</span>${under}</div>
        <span class="led" aria-hidden="true"></span><span class="fader" aria-hidden="true"><i class="knob"></i></span>${ok}</div>
      ${bad ? '<svg class="loop" viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M14 40C4 24 30 7 98 5c62-2 98 8 96 26-2 19-44 27-100 27C40 58 6 50 7 33 8 21 26 12 58 9"/></svg>' : ''}${strata}${note}<div class="acts">${acts}</div></div>`;
  }
  function rightPage(a, d, p) {
    const items = itemsOn(a, d, p);
    const on = items.filter(x => x.r.value === 'on'); const badN = on.filter(x => x.iss.length).length;
    const sum = p.type === 'conv' ? `<p class="sum"><b>${on.length - badN}</b> ${tl('样能用', '路信号正常')}${badN ? ` · <b class="bad-t">${badN}</b> ${tl('样用不了', '路故障')}` : ''}${items.length - on.length ? ` · ${items.length - on.length} ${tl('样本页揭下', '路本台关')}` : ''}</p>` : `<p class="sum">${tl('这一层写下的会透到后面的页', '这一层发出的信号会转播下去')}</p>`;
    const n = draftCount(a.id);
    return `<header class="rh"><div><p class="kicker">${tl('带着什么本事', '接入调音台的设备')}</p><h2>${tl('贴在这一页的贴纸', '本台推子')}</h2></div>${sum}</header>
      <p class="legend">${tl('<i class="lg ink"></i>实墨＝本页自己写的　<i class="lg carbon"></i>复写印＝从下层透上来　<i class="lg pen"></i>红笔＝开了但用不了', '<i class="lg ink"></i>ON AIR＝本台直播　<i class="lg carbon"></i>转播＝来自上级台　<i class="lg pen"></i>故障灯＝开了但用不了')}</p>
      <div class="cells" id="cells" data-k="cells">${items.map(x => cellHtml(a, d, p, x)).join('')}
        <div class="drop" aria-hidden="true"><span>${tl('从封底拖一张贴纸到这里', '把设备拖进空推子槽')}</span><small>${tl('或在封底选中后按 Enter', '或在设备架选中后按 Enter')}</small></div></div>
      <footer class="rf"><button type="button" class="btn sheet-btn" data-act="sheet" data-k="sheet-btn" aria-expanded="${S.sheet}">${tl('封底贴纸', '设备架')}<span class="cnt">${a.sheet.length}</span><kbd>B</kbd></button>
        <div class="draft sv-${S.save.state}" role="status">${saveArea(a, n)}</div></footer>`;
  }

  function saveArea(a, n) {
    const st = S.save.state;
    if (st === 'pending') return `<span class="sv-pend"><i class="ink-dot" aria-hidden="true"></i>${tl('落款中…', '发送中…')}</span>`;
    if (st === 'fail') return `<span class="sv-msg bad-t">${tl('落款没盖上：改动还在，没有丢', '信号中断：没播出去，改动还在')}</span><button type="button" class="btn ghost compact" data-act="undo" data-k="undo">撤销</button><button type="button" class="btn commit" data-act="save" data-k="save">${tl('再盖一次', '重新发送')}</button>`;
    if (st === 'conflict') return `<span class="sv-msg warn-t">${tl('撞页了：在上面逐条选好再落款', '同频干扰：在上面逐条选好再发送')}</span>`;
    if (st === 'unknown') return `<span class="sv-msg warn-t">${tl('墨迹没干：不确定落上没有', '未收到回执：不确定播出没有')}</span><button type="button" class="btn commit" data-act="verify" data-k="verify">${tl('核对一下', '核对回执')}</button>`;
    if (n) return `<span>${tl(`${a.id} 本还有 <b>${n}</b> 处没落款`, `${a.id} 台有 <b>${n}</b> 处待播出`)}</span><button type="button" class="btn ghost compact" data-act="undo" data-k="undo">撤销</button><button type="button" class="btn commit" data-act="save" data-k="save">${tl('落款保存', '播出保存')}<kbd>Ctrl S</kbd></button>`;
    return `<span class="cap">${tl('都已落款', '全部已播出')}</span>`;
  }
  window.WJView = { S, db, D, A, $, e, tl, acc, draft, page, pageOf, itemsOn, draftCount, verdict, renderShelf, renderStrip, leftConv, leftLayer, rightPage, cellHtml, fx, reduced, night, LS, pageTitle, LN, NN, setDataset, firstConv };
})();
