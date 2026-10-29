/* 总览：白昼「摊开全本」/ 晚风「全频扫描」。同一份 DOM、同一套操作，只换外观。
 * 回答：每个会话谁在说话、会不会回复、带着什么、哪里有问题；某张角色卡 / 插件 / Skill 用在哪些会话；
 * 哪些会话自己写了、哪些全跟随；异常集中在哪；全部账号时各本（各台）边界清楚。 */
(function () {
  'use strict';
  const V = window.WJView; const { S, db, D, A, $, e, tl } = V;
  const OV = S.ov; let uid = 0;
  const scroller = (r) => $('.spx-stack', r || document) || $('.ov-wall', r || document);
  const html = document.documentElement;
  const nameOf = (id) => D.DEF[id] ? D.DEF[id].name : id;
  const kindOf = (id) => D.DEF[id].type === 'plugin' ? '插件' : 'Skill';

  // ---------- 计算：每一页的「三秒答案」 ----------
  function info(a, p) {
    const d = S.drafts[a.id]; const role = p.type === 'conv' ? D.roleOf(a, d, p) : null;
    const items = V.itemsOn(a, d, p); const online = a.status === 'online';
    const own = items.filter(x => x.r.own === 'on' || x.r.own === 'off').length;
    const causes = [];
    if (p.type === 'conv' && !role) causes.push({ k: 'norole', d: '没请角色卡', n: '没有主持人', s: tl('没请人', '空麦'), sev: 2 });
    if (p.type === 'conv' && !online) causes.push({ k: 'qq', d: 'QQ 没连上', n: 'QQ 没连上（整台无信号）', s: 'QQ 未连', sev: 3 });
    items.filter(x => x.r.value === 'on').forEach(x => x.iss.filter(i => i.code !== 'qq').forEach(i => {
      const k = i.code + ':' + (i.code === 'dep' ? x.id + '>' + D.DEF[x.id].plugin : x.id);
      const lab = i.code === 'auth' ? `${nameOf(x.id)} · ${i.text}` : i.code === 'ready' ? `插件 ${x.id} ${nameOf(x.id)} · 未就绪` : i.code === 'dep' ? `${nameOf(x.id)} · 缺插件 ${D.DEF[x.id].plugin}` : `${nameOf(x.id)} · 没安装`;
      const sh = i.code === 'auth' ? '缺授权' : i.code === 'ready' ? '未就绪' : i.code === 'dep' ? '缺插件 ' + D.DEF[x.id].plugin : '没安装';
      if (!causes.some(c => c.k === k)) causes.push({ k, d: lab, n: lab, s: sh, sev: 1, id: x.id });
    }));
    const badItems = online ? items.filter(x => x.r.value === 'on' && x.iss.some(i => i.code !== 'qq')).map(x => x.id) : items.filter(x => x.r.value === 'on').map(x => x.id);
    return { a, p, role, items, own, causes, badItems, replies: p.type === 'conv' && !!role && online, online };
  }
  function scopeAccs() { return OV.scope === 'all' ? db.order.map(id => db.acc[id]) : [db.acc[S.acc]]; }
  function matchQ(x) {
    const q = OV.q.trim().toLowerCase(); if (!q) return true;
    const hay = [x.p.name, x.p.id, String(x.p.peer), '第' + x.p.no + '页', String(x.p.no), x.p.freq.toFixed(1), x.role ? x.role.name + ' ' + x.role.id : '没请人 空麦', x.a.id + '本', x.a.id + '台', x.a.name].join(' ').toLowerCase();
    return q.split(/\s+/).every(w => hay.includes(w));
  }
  const FILTERS = [['all', '全部', '全部'], ['bad', '有问题', '有故障'], ['own', '自己写了', '有直播'], ['follow', '全跟随', '全转播'], ['silent', '不会回复', '停播']];
  function passFilter(x, f) { return f === 'all' ? true : f === 'bad' ? x.causes.length > 0 : f === 'own' ? x.own > 0 : f === 'follow' ? x.own === 0 : f === 'silent' ? !x.replies : true; }
  function focusHit(x) {
    if (!OV.focus) return null; const [k, id] = OV.focus.split(':');
    if (k === 'role') return x.role && x.role.id === id ? 'on' : null;
    const it = x.items.find(y => y.id === id); if (!it) return null; return it.r.value === 'on' ? 'on' : 'off';
  }

  // ---------- 资源（右侧不再有，统一放左栏） ----------
  function resources(accs) {
    const conv = accs.flatMap(a => a.pages.filter(p => p.type === 'conv').map(p => info(a, p)));
    const roles = Object.values(D.ROLES).filter(r => r.src === 'public' || accs.some(a => a.id === r.owner)).map(r => {
      const by = {}; let bad = 0; conv.forEach(x => { if (x.role && x.role.id === r.id) { by[x.a.id] = (by[x.a.id] || 0) + 1; if (!x.online) bad++; } });
      return { k: 'role:' + r.id, t: '角色卡', label: r.name, id: r.id, src: r.src === 'public' ? '公共' : tl(r.owner + ' 本私有', r.owner + ' 台私有'), by, bad, look: r.look };
    });
    const items = Object.values(D.DEF).filter(def => accs.some(a => a.sheet.includes(def.id))).map(def => {
      const by = {}; let bad = 0; conv.forEach(x => { const it = x.items.find(y => y.id === def.id && y.r.value === 'on'); if (it) { by[x.a.id] = (by[x.a.id] || 0) + 1; if (x.badItems.includes(def.id)) bad++; } });
      const src = D.srcLabel(accs[0], def.id);
      return { k: 'item:' + def.id, t: def.type === 'plugin' ? '插件' : 'Skill', label: def.name, id: def.id, src: def.src === 'plugin' ? '插件 ' + def.plugin + ' 提供' : def.src === 'private' ? tl('账号私有', '电台私有') : src.cls === 'private' ? tl(accs[0].id + ' 本私有', accs[0].id + ' 台私有') : '公共', by, bad };
    });
    return { conv, roles, items };
  }
  const total = (by) => Object.values(by).reduce((s, n) => s + n, 0);
  const byTxt = (by, accs) => accs.length > 1 ? accs.filter(a => by[a.id]).map(a => `${a.id}<b>${by[a.id]}</b>`).join(' ') : '';

  // ---------- 缩略页 / 电台卡 ----------
  function itemDots(x, hitId) {
    return x.items.map(y => { const m = y.r.own === 'on' ? 'ink' : y.r.own === 'off' ? 'peeled' : 'carbon'; const bad = x.badItems.includes(y.id);
      return `<i class="it m-${m} ty-${D.DEF[y.id].type}${bad ? ' bad' : ''}${hitId === y.id ? ' hl' : ''}" title="${kindOf(y.id)} ${y.id} ${e(nameOf(y.id))}"></i>`; }).join('');
  }
  function thumb(x, i) {
    const { a, p, role } = x; uid++;
    const hit = focusHit(x); const fid = OV.focus && OV.focus.startsWith('item:') ? OV.focus.slice(5) : null;
    const causeHit = OV.cause && x.causes.some(c => c.k === OV.cause);
    const cur = a.id === S.acc && p.key === S.page[S.acc];
    const pic = role ? `<span class="th-pic">${A.portrait(role.look, 'o' + uid)}</span>` : `<span class="th-pic none" aria-hidden="true"><i></i></span>`;
    const why = x.causes.length ? x.causes.slice().sort((m, n) => n.sev - m.sev)[0] : null;
    const cls = ['th', 'k-' + p.kind, x.causes.length ? 'bad' : '', x.replies ? 'live' : 'mute', x.own ? 'own' : 'follow', cur ? 'cur' : '',
      OV.focus ? (hit === 'on' ? 'hit' : hit === 'off' ? 'hit-off' : 'dim') : '', OV.cause ? (causeHit ? 'hit' : 'dim') : ''].filter(Boolean).join(' ');
    const label = `${a.id} ${tl('本', '台')} ${V.pageTitle(p)}，${role ? '角色 ' + role.name : '没有角色卡'}，${x.replies ? '会回复' : '不会回复'}，${x.own ? '自己写了 ' + x.own + ' 处' : '全跟随上层'}${why ? '，问题：' + why.d : ''}`.replace(/<[^>]+>/g, '');
    return `<button type="button" class="${cls}" style="--i:${i}" data-act="ov-go" data-acc="${a.id}" data-page="${p.key}" data-k="th-${a.id}-${p.key}" aria-label="${e(label)}">
      <span class="th-top"><span class="th-no">${tl('第 ' + p.no + ' 页', p.freq.toFixed(1))}</span><span class="th-own">${x.own ? tl('自己写了 ' + x.own + ' 处', '直播 ' + x.own) : tl('全跟随', '全转播')}</span></span>
      ${pic}<span class="th-nm">${e(p.name)}</span>
      <span class="th-who">${role ? e(role.name) : tl('还没请人', '空麦')}</span>
      <span class="th-items" aria-hidden="true">${itemDots(x, fid)}</span>
      <span class="th-foot"><span class="th-why">${why ? why.s + (x.causes.length > 1 ? `<small>+${x.causes.length - 1}</small>` : '') : ''}</span><span class="th-stamp">${x.replies ? tl('会回复', 'ON AIR') : tl('不回复', 'OFF')}</span></span>
      ${cur ? `<span class="th-here" aria-hidden="true">${tl('正翻到', '正在收听')}</span>` : ''}${hit === 'off' ? `<span class="th-x" aria-hidden="true">${tl('本页揭下', '本台关')}</span>` : ''}</button>`;
  }
  function layerCard(a, p) {
    const x = info(a, p); const own = x.items.filter(y => y.r.own === 'on' || y.r.own === 'off');
    const fid = OV.focus && OV.focus.startsWith('item:') ? OV.focus.slice(5) : null;
    const hit = fid && own.some(y => y.id === fid);
    return `<button type="button" class="lay${hit ? ' hit' : ''}" data-act="ov-go" data-acc="${a.id}" data-page="${p.key}" data-k="th-${a.id}-${p.key}" aria-label="${a.id} ${p.type === 'account' ? '扉页·账号通用' : D.LAYER_NAME[p.key] + '页'}，写了 ${own.length} 项">
      <span class="lay-t">${p.type === 'account' ? tl('扉页 · 账号通用', '总台') : tl(D.LAYER_NAME[p.key] + '页', D.NIGHT_LAYER[p.key])}</span>
      <span class="lay-items">${own.length ? own.map(y => `<i class="it m-${y.r.own === 'on' ? 'ink' : 'peeled'} ty-${D.DEF[y.id].type}${fid === y.id ? ' hl' : ''}" title="${kindOf(y.id)} ${y.id} ${e(nameOf(y.id))}"></i><span class="lay-n">${e(nameOf(y.id))}</span>`).join('') : `<span class="lay-n">${tl('空白', '无节目')}</span>`}</span>
      <span class="lay-s">${tl('复写到下面每一页', '转播给下面每个台')}</span></button>`;
  }
  function bookHtml(a, list, multi) {
    const conv = a.pages.filter(p => p.type === 'conv');
    const all = conv.map(p => info(a, p)); const bad = all.filter(x => x.causes.length).length, own = all.filter(x => x.own).length, mute = all.filter(x => !x.replies).length;
    const kinds = ['group', 'private'].map(kd => {
      const vis = list.filter(x => x.p.kind === kd); const n = conv.filter(p => p.kind === kd).length; if (!n) return '';
      const kp = a.pages.find(p => p.key === 'k:' + kd);
      return `<section class="ob-kind" aria-label="${kd === 'group' ? '群聊' : '私聊'}">
        <header class="ok-h"><h4>${kd === 'group' ? tl('群聊', '群聊波段') : tl('私聊', '私聊波段')} <small>${vis.length === n ? n : vis.length + ' / ' + n} ${tl('页', '台')}</small></h4>${kp ? layerCard(a, kp) : ''}</header>
        <div class="ob-grid" role="group">${vis.length ? vis.map((x, i) => thumb(x, i)).join('') : `<p class="cap ob-none">${tl('这一类没有符合的页', '这一段没有符合的台')}</p>`}</div></section>`;
    }).join('');
    const ap = a.pages.find(p => p.type === 'account');
    return `<section class="ov-book c-${a.cover} st-${a.status}${a.id === S.acc ? ' cur' : ''}" aria-label="${a.id} ${night() ? '台' : '本'} ${e(a.name)}" data-acc="${a.id}">
      <header class="ob-h"><span class="ob-spine" aria-hidden="true"><b>${a.id}</b><i></i></span>
        <div class="ob-t"><h3>${tl(a.id + ' 本', a.id + ' 台')} · ${e(a.name)}</h3><p class="cap">QQ <span class="mono">${a.qq}</span> · ${a.status === 'online' ? tl('已连接', '在线') : `<b class="bad-t">${tl('未连接：整本不会回复', '离线：整台无信号')}</b>`}</p></div>
        <p class="ob-stats"><span><b>${conv.length}</b>${tl('页会话', '个电台')}</span><span class="${mute ? 'bad-t' : ''}"><b>${mute}</b>${tl('页不会回复', '台停播')}</span><span><b>${bad}</b>${tl('页有问题', '台有故障')}</span><span><b>${own}</b>${tl('页自己写了', '台有直播')}</span></p>
        ${ap ? layerCard(a, ap) : ''}</header>${kinds}
      ${multi ? `<p class="ob-end" aria-hidden="true">${tl(a.id + ' 本到此为止 · 页码只在本子里有效', a.id + ' 台到此为止 · 频率只在这台收音机里有效')}</p>` : ''}</section>`;
  }

  // ---------- 晚风「全频扫描」：频谱 / 瀑布 ----------
  // 每个台＝一根光柱：柱里一格一格是接入的设备（亮格＝本台直播，暗格＝转播，空框＝本台关，红格＝故障），
  // 柱子亮着＝ON AIR，灰掉＝停播；顶上红灯＝故障；柱脚三格瀑布＝信号来自 总台 / 分台 / 本台 的比例。
  let MAP = {};
  const srcCount = (x) => { const c = { acc: 0, kind: 0, own: 0 }; x.items.forEach(y => { if (y.r.value !== 'on') return; if (y.r.own === 'on') c.own++; else if (y.r.source === 'acc') c.acc++; else if (String(y.r.source).startsWith('k:')) c.kind++; }); return c; };
  function segs(x, fid, layer) {
    const list = layer ? x.items.filter(y => y.r.own === 'on' || y.r.own === 'off') : x.items;
    return list.map(y => { const m = y.r.own === 'on' ? 'ink' : y.r.own === 'off' ? 'peeled' : 'carbon'; const bad = x.badItems.includes(y.id) && y.r.value === 'on';
      return `<i class="sg m-${m}${bad ? ' bad' : ''}${fid === y.id ? ' hl' : ''}"></i>`; }).join('');
  }
  function colHtml(x, i, vis) {
    const { a, p, role } = x; const k = a.id + '|' + p.key; MAP[k] = x;
    const layer = p.type !== 'conv';
    const fid = OV.focus && OV.focus.startsWith('item:') ? OV.focus.slice(5) : null;
    if (!vis) return `<span class="col ghost${layer ? ' car' : ''}" aria-hidden="true"><span class="c-bar">${segs(x, null, layer)}</span><span class="c-axis"></span><span class="c-fall"></span><span class="c-nm"></span></span>`;
    const cur = a.id === S.acc && p.key === S.page[S.acc];
    if (layer) {
      const own = x.items.filter(y => y.r.own === 'on' || y.r.own === 'off'); const hit = fid && own.some(y => y.id === fid);
      const nm = p.type === 'account' ? '总台' : D.NIGHT_LAYER[p.key];
      return `<button type="button" class="col car${hit ? ' hit' : OV.focus ? ' dim' : ''}${cur ? ' cur' : ''}" style="--i:${i}" data-act="ov-go" data-acc="${a.id}" data-page="${p.key}" data-k="th-${a.id}-${p.key}" aria-label="${a.id} 台 ${nm}，${p.freq.toFixed(1)}，发出 ${own.length} 路信号，转播给下面每个台">
        <span class="c-led"></span><span class="c-bar">${segs(x, fid, true)}</span><span class="c-axis"><b>${p.freq.toFixed(1)}</b></span><span class="c-fall"><i style="--v:1"></i></span><span class="c-nm">${nm}</span></button>`;
    }
    const hit = focusHit(x); const causeHit = OV.cause && x.causes.some(c => c.k === OV.cause);
    const why = x.causes.length ? x.causes.slice().sort((m, n) => n.sev - m.sev)[0] : null;
    const sc = srcCount(x); const tot = Math.max(1, sc.acc + sc.kind + sc.own);
    const cls = ['col', 'cv', 'k-' + p.kind, x.causes.length ? 'bad' : '', x.replies ? 'live' : 'mute', x.own ? 'own' : 'follow', cur ? 'cur' : '',
      OV.focus ? (hit === 'on' ? 'hit' : hit === 'off' ? 'hit-off' : 'dim') : '', OV.cause ? (causeHit ? 'hit' : 'dim') : ''].filter(Boolean).join(' ');
    const label = `${a.id} 台 ${p.freq.toFixed(1)} ${p.name}，${role ? '主持人 ' + role.name : '空麦，没有主持人'}，${x.replies ? 'ON AIR 会回复' : '停播，不会回复'}，${x.own ? '直播 ' + x.own + ' 路' : '全转播'}${why ? '，故障：' + why.d : ''}${hit === 'off' ? '，本台关了这一项' : ''}`;
    return `<button type="button" class="${cls}" style="--i:${i}" data-act="ov-go" data-acc="${a.id}" data-page="${p.key}" data-k="th-${a.id}-${p.key}" aria-label="${e(label)}">
      <span class="c-led${why ? ' on sev-' + why.sev : ''}"></span><span class="c-bar">${segs(x, fid, false)}${!x.items.length ? '<i class="sg m-floor"></i>' : ''}</span>
      <span class="c-axis"><b>${p.freq.toFixed(1)}</b></span>
      <span class="c-fall"><i style="--v:${(sc.acc / tot).toFixed(2)}"></i><i style="--v:${(sc.kind / tot).toFixed(2)}"></i><i style="--v:${(sc.own / tot).toFixed(2)}"></i></span>
      <span class="c-nm">${e(p.name)}</span>${cur ? '<span class="c-here" aria-hidden="true">收听中</span>' : ''}</button>`;
  }
  function specBand(a, shownKeys, multi) {
    const conv = a.pages.filter(p => p.type === 'conv'); const all = conv.map(p => info(a, p));
    const bad = all.filter(x => x.causes.length).length, own = all.filter(x => x.own).length, mute = all.filter(x => !x.replies).length;
    let i = 0; const seg = (ps) => ps.map(p => colHtml(info(a, p), i++, p.type !== 'conv' || shownKeys.has(a.id + '|' + p.key))).join('');
    const L = a.pages.filter(p => p.type !== 'conv');
    const acc0 = L.filter(p => p.type === 'account'), kg = L.filter(p => p.key === 'k:group'), kp = L.filter(p => p.key === 'k:private');
    const G = conv.filter(p => p.kind === 'group'), P = conv.filter(p => p.kind === 'private');
    const rng = (ps) => ps.length ? ps[0].freq.toFixed(1) + '–' + ps[ps.length - 1].freq.toFixed(1) : '';
    return `<section class="spx${a.pages.length <= 18 ? " sparse" : ""} c-${a.cover} st-${a.status}${a.id === S.acc ? ' cur' : ''}" data-acc="${a.id}" aria-label="${a.id} 台 ${e(a.name)} 的频谱">
      <header class="spx-h"><span class="ob-spine" aria-hidden="true"><b>${a.id}</b><i></i></span><h3>${a.id} 台 · ${e(a.name)}</h3>
        <span class="cap">QQ <span class="mono">${a.qq}</span> · ${a.status === 'online' ? '在线' : '<b class="bad-t">离线：整台无信号</b>'}</span>
        <span class="spx-st"><span><b>${conv.length}</b>台</span><span class="${mute ? 'bad-t' : ''}"><b>${mute}</b>停播</span><span><b>${bad}</b>故障</span><span><b>${own}</b>有直播</span></span></header>
      <div class="spx-scope"><i class="spx-scan" aria-hidden="true"></i>
        <div class="spx-row">${seg(acc0)}<i class="gap"></i>${seg(kg)}<span class="spx-bd" aria-hidden="true">群聊波段 · ${G.length} · ${rng(G)}</span>${seg(G)}<i class="gap"></i>${seg(kp)}<span class="spx-bd" aria-hidden="true">私聊波段 · ${P.length} · ${rng(P)}</span>${seg(P)}</div></div>
      ${multi ? `<p class="spx-end" aria-hidden="true">${a.id} 台到此为止 · 频率只在这台收音机里有效</p>` : ''}</section>`;
  }
  function readHtml(x) {
    if (!x) return '<p class="cap">把焦点移到一根光柱上，这里显示它的读数。</p>';
    const { a, p, role } = x; const layer = p.type !== 'conv';
    const st = (y) => y.r.own === 'on' ? '直播' : y.r.own === 'off' ? '本台关' : '转播 · ' + (y.r.source === 'acc' ? '总台' : D.NIGHT_LAYER[y.r.source] || '默认');
    const items = (layer ? x.items.filter(y => y.r.own === 'on' || y.r.own === 'off') : x.items).map(y => { const iss = y.r.value === 'on' && x.badItems.includes(y.id) ? (y.iss.find(i => i.code !== 'qq') || y.iss[0]) : null;
      return `<li class="${iss ? 'bad' : ''} m-${y.r.own === 'on' ? 'ink' : y.r.own === 'off' ? 'peeled' : 'carbon'}"><i class="sg"></i><span>${e(nameOf(y.id))}</span><small>${st(y)}${iss ? ` · <b class="bad-t">${e(iss.night.replace(/^.*?：/, ''))}</b>` : ''}</small></li>`; }).join('');
    const why = x.causes.slice().sort((m, n) => n.sev - m.sev);
    return `<p class="r-k">调谐读数 · ${a.id} 台${layer ? '' : ' · ' + (p.kind === 'group' ? '群聊' : '私聊')}</p>
      <p class="r-f"><b>${p.freq.toFixed(1)}</b><small>MHz</small></p>
      <h3 class="r-n">${layer ? (p.type === 'account' ? '总台 · 账号通用' : D.NIGHT_LAYER[p.key]) : e(p.name)}</h3>
      ${layer ? '<p class="cap">这一层发出的信号会转播给下面每个台。</p>' : `<div class="r-host">${role ? `<span class="r-pp">${A.portrait(role.look, 'rd' + (++uid))}</span><span><b>${e(role.name)}</b><small>主持人 · 角色卡 ${role.id}</small></span>` : '<span class="r-pp none"><i></i></span><span><b>空麦</b><small>没有角色卡，这个台不会回复</small></span>'}</div>
      <p class="r-air ${x.replies ? 'on' : 'off'}"><i></i>${x.replies ? 'ON AIR · 会回复' : '停播 · 不会回复'}<span>${x.own ? '直播 ' + x.own + ' 路' : '全转播'}</span></p>`}
      ${why.length ? `<ul class="r-why">${why.map(c => `<li>${e(c.n)}</li>`).join('')}</ul>` : ''}
      <ul class="r-items">${items || `<li class="cap">${layer ? '这一层没有发出信号' : '没有接入设备'}</li>`}</ul>
      <button type="button" class="btn commit compact r-go" data-act="ov-go" data-acc="${a.id}" data-page="${p.key}" data-k="rd-go">调到这台 <kbd>Enter</kbd></button>`;
  }
  function setRead(k, el) {
    const box = $('.spx-read'); if (!box || !MAP[k] || OV.read === k && box.dataset.k === k) return; OV.read = k; box.dataset.k = k; box.innerHTML = readHtml(MAP[k]);
    document.querySelectorAll('.spx .col.rd').forEach(c => c.classList.remove('rd')); const c = el || document.querySelector(`.spx [data-k="th-${k.replace('|', '-')}"]`); c && c.classList.add('rd');
  }
  // 光柱太密（每根不到 14px）时，柱下竖排的台名改为只在 当前 / 读数 / 悬停 / 聚焦 时浮出
  function densify() { document.querySelectorAll('.spx').forEach(b => { const c = b.querySelector('.col.cv, .col.ghost'); b.classList.toggle('dense', !!c && c.getBoundingClientRect().width < 14); }); }
  window.addEventListener('resize', () => { if (OV.open && night()) densify(); });
  const keyOf = (el) => el && el.dataset && el.dataset.acc ? el.dataset.acc + '|' + el.dataset.page : null;
  document.addEventListener('focusin', (ev) => { const c = ev.target.closest && ev.target.closest('.spx .col[data-k]'); if (c) setRead(keyOf(c), c); });
  document.addEventListener('pointerover', (ev) => { const c = ev.target.closest && ev.target.closest('.spx .col[data-k]'); if (c) setRead(keyOf(c), c); });

  // ---------- 整体 ----------
  function renderOv(book) {
    const prev = scroller(book); const keepScroll = prev ? prev.scrollTop : null; const railPrev = $('.ov-rail .rl-list', book); const keepRail = railPrev ? railPrev.scrollTop : 0;
    const accs = scopeAccs(); const R = resources(accs);
    const vis = R.conv.filter(matchQ);
    const counts = Object.fromEntries(FILTERS.map(([f]) => [f, vis.filter(x => passFilter(x, f)).length]));
    const shown = vis.filter(x => passFilter(x, OV.filter) && (!OV.cause || x.causes.some(c => c.k === OV.cause)));
    // 异常聚合
    const agg = {}; R.conv.forEach(x => x.causes.forEach(c => { const g = agg[c.k] = agg[c.k] || { k: c.k, d: c.d, n: c.n, sev: c.sev, by: {} }; g.by[x.a.id] = (g.by[x.a.id] || 0) + 1; }));
    const causes = Object.values(agg).sort((m, n) => n.sev - m.sev || total(n.by) - total(m.by));
    const multi = accs.length > 1; const spec = night(); MAP = {}; const shownKeys = new Set(shown.map(x => x.a.id + '|' + x.p.key));
    const causeHtml = causes.length ? causes.map(c => `<button type="button" class="cz sev-${c.sev}" data-act="ov-cause" data-v="${c.k}" data-k="cz-${c.k}" aria-pressed="${OV.cause === c.k}">
        <span class="cz-t">${tl(e(c.d), e(c.n))}</span><span class="cz-n">${multi ? accs.filter(a => c.by[a.id]).map(a => `<em>${a.id}</em>${c.by[a.id]}`).join(' ') : c.by[accs[0].id]} ${tl('页', '台')}</span></button>`).join('')
      : `<span class="cap">${tl('没有异常：每一页都能正常回复', '全部信号正常')}</span>`;
    const resRow = (r) => { const n = total(r.by); const cur = OV.focus === r.k;
      return `<li><button type="button" class="rs${cur ? ' cur' : ''}${n ? '' : ' zero'}" data-act="ov-focus" data-v="${r.k}" data-k="rs-${r.k}" aria-pressed="${cur}">
        <span class="rs-g">${r.t === '角色卡' ? `<span class="rs-pp">${A.portrait(r.look, 'r' + (++uid))}</span>` : `<span class="glyph g-${r.id}">${A.glyph(r.id)}</span>`}</span>
        <span class="rs-t"><b>${e(r.label)}</b><small>${r.t} ${r.id} · ${r.src}</small></span>
        <span class="rs-n"><b>${n}</b>${r.bad ? `<i class="bad-t">${r.bad}!</i>` : ''}${multi && n ? `<small>${byTxt(r.by, accs)}</small>` : ''}</span></button></li>`; };
    let focusHtml = '';
    if (OV.focus) {
      const [k, id] = OV.focus.split(':'); const r = (k === 'role' ? R.roles : R.items).find(y => y.k === OV.focus);
      const isPub = k === 'role' ? D.ROLES[id].src === 'public' : D.DEF[id].src === 'public';
      const offs = k === 'item' ? R.conv.filter(x => focusHit(x) === 'off').length : 0;
      const imp = S.impact === k + ':' + id ? V.impactHtml(k, id) : '';
      focusHtml = `<div class="rl-focus" role="status"><p class="k">${tl('荧光笔划出', '正在追踪')}</p><p class="rf-n"><b>${r ? r.t : ''} ${id} · ${e(r ? r.label : id)}</b></p>
        <p class="cap">${tl('用在', '在播')} <b>${r ? total(r.by) : 0}</b> ${tl('页', '台')}${r && r.bad ? ` · <span class="bad-t">${r.bad} ${tl('页用不了', '台故障')}</span>` : ''}${offs ? ` · ${offs} ${tl('页自己揭下', '台本台关')}` : ''}${multi && r ? `<br>${accs.map(a => `${tl(a.id + ' 本', a.id + ' 台')} ${r.by[a.id] || 0}`).join(' · ')}` : ''}</p>
        <div class="row">${isPub ? `<button type="button" class="link small" data-act="impact" data-v="${k}:${id}" data-k="imp-${k}-${id}" aria-expanded="${!!imp}">${tl('改公共定义前，先看影响', '改公共节目前，先看覆盖范围')}</button>` : ''}<button type="button" class="btn ghost compact" data-act="ov-focus" data-v="" data-k="rf-clear">${tl('放下荧光笔', '停止追踪')} <kbd>Esc</kbd></button></div>${imp}</div>`;
    }
    const scopeName = multi ? tl('全部 ' + accs.length + ' 本', '全部 ' + accs.length + ' 台') : tl(S.acc + ' 本', S.acc + ' 台');
    book.innerHTML = `<div class="ov${OV.entering ? ' entering' : ''}" role="region" aria-label="${night() ? '全频扫描' : '摊开全本'}">
      <header class="ov-h">
        <div class="ov-ti"><p class="kicker">${tl('总览 · 一眼看全部会话', '总览 · 扫过整个波段')}</p><h1 id="ov-title" tabindex="-1">${tl('摊开全本', '全频扫描')} <small>${scopeName} · ${R.conv.length} ${tl('页会话', '个电台')}</small></h1></div>
        <div class="seg ov-scope" role="group" aria-label="范围：一次只看一个账号，或全部账号">${db.order.map(id => `<button type="button" data-act="ov-acc" data-v="${id}" data-k="sc-${id}" aria-pressed="${!multi && S.acc === id}" aria-label="只看 ${id} ${night() ? '台' : '本'}（Alt+${db.order.indexOf(id) + 1}）"><i class="sc-dot c-${db.acc[id].cover} st-${db.acc[id].status}" aria-hidden="true"></i>${tl(id + ' 本', id + ' 台')}</button>`).join('')}<button type="button" data-act="ov-scope" data-v="all" data-k="sc-all" aria-pressed="${multi}">${tl('全部账号', '全部收音机')}</button><kbd>A</kbd></div>
        <label class="ov-q"><svg class="ico s" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg><span class="sr">搜索</span>
          <input type="search" data-k="ov-q" value="${e(OV.q)}" placeholder="${night() ? '搜台名、频率、主持人、群号' : '搜页名、页码、角色、群号'}" autocomplete="off"><kbd>/</kbd></label>
        <button type="button" class="btn ov-close" data-act="ov" data-k="ov-close">${tl('合上', '回到本台')} <kbd>O</kbd></button>
      </header>
      <div class="ov-cz" role="group" aria-label="异常集中在哪"><span class="cz-k">${tl('红笔圈出', '故障灯')}<b>${causes.length}</b>${tl('处', '类')}</span>${causeHtml}</div>
      <aside class="ov-rail" aria-label="筛选与反查">
        <div class="rl-f" role="group" aria-label="筛选">${FILTERS.map(([f, dn, nn]) => `<button type="button" class="fl" data-act="ov-filter" data-v="${f}" data-k="fl-${f}" aria-pressed="${OV.filter === f}"><span>${tl(dn, nn)}</span><b>${counts[f]}</b></button>`).join('')}</div>
        ${focusHtml}
        <div class="rl-list"><h3>${tl('角色卡', '主持人')}</h3><ul>${R.roles.map(resRow).join('')}</ul><h3>${tl('插件 · Skill', '设备')}</h3><ul>${R.items.map(resRow).join('')}</ul>
          <p class="cap rl-tip">${tl('点一项，用到它的页会被荧光笔划出，其余变淡。', '点一项，接入它的光柱会亮起，其余变暗。')}</p>
          <p class="ov-legend" aria-hidden="true">${tl('<span><i class="it m-ink"></i>实墨＝本页自己贴的</span><span><i class="it m-carbon"></i>复写印＝跟随上层</span><span><i class="it m-peeled"></i>揭下＝本页关</span><span><i class="it m-ink bad"></i>红圈＝开了用不了</span>', '<span><i class="sg m-ink"></i>亮格＝本台直播</span><span><i class="sg m-carbon"></i>暗格＝转播</span><span><i class="sg m-peeled"></i>空框＝本台关</span><span><i class="sg m-ink bad"></i>红格＝故障</span><span><i class="lg-col"></i>柱亮＝ON AIR，灰＝停播</span><span><i class="lg-fall"></i>柱脚瀑布＝总台 / 分台 / 本台</span>')}</p></div>
      </aside>
      ${spec ? `<div class="ov-wall spec" tabindex="-1"><div class="spx-stack">${accs.map(a => specBand(a, shownKeys, multi)).join('')}
          ${!shown.length ? `<div class="ov-empty"><p>没有扫到符合条件的台：光柱都暗着</p><button type="button" class="btn" data-act="ov-clear" data-k="ov-clear">清除条件</button></div>` : ''}</div>
        <aside class="spx-read" aria-label="调谐读数"></aside></div>`
      : `<div class="ov-wall${multi && accs.every(a => a.pages.filter(p => p.type === 'conv').length <= 10) ? ' side' : ''}" tabindex="-1">
        ${accs.map(a => bookHtml(a, shown.filter(x => x.a.id === a.id), multi)).join('')}
        ${!shown.length ? `<div class="ov-empty"><p>${tl('没有符合条件的页', '没有扫到符合条件的台')}</p><button type="button" class="btn" data-act="ov-clear" data-k="ov-clear">${tl('清掉筛选', '清除条件')}</button></div>` : ''}
      </div>`}</div>`;
    const wall = scroller(book); if (keepScroll != null) wall.scrollTop = keepScroll;
    if (spec) densify();
    if (spec) { const want = OV.read && MAP[OV.read] ? OV.read : S.acc + '|' + S.page[S.acc]; OV.read = null; setRead(MAP[want] ? want : Object.keys(MAP)[0]); }
    const rl = $('.ov-rail .rl-list', book); if (rl) rl.scrollTop = keepRail;
  }
  const night = V.night;

  // ---------- 进出：当前页缩回墙上它的位置 / 从墙上放大成整页 ----------
  const canVT = () => V.startVT(null, true) !== null;
  function curThumb() { return document.querySelector(`.ov [data-k="th-${S.acc}-${S.page[S.acc]}"]`); }
  const vtEl = (th) => night() ? $('.spx-read') : th;
  function placeWall() {
    const wall = scroller(); if (!wall) return;
    if (OV.scroll != null) { wall.scrollTop = OV.scroll; }
    const th = curThumb(); if (th) { const wr = wall.getBoundingClientRect(), r = th.getBoundingClientRect(); if (r.top < wr.top + 40 || r.bottom > wr.bottom - 10) wall.scrollTop += r.top - wr.top - wr.height / 2 + r.height / 2; }
  }
  function ripple() {
    const th = curThumb(); const c = th ? th.getBoundingClientRect() : null;
    document.querySelectorAll('.ov .th, .ov .lay, .ov .col[data-k]').forEach(t => { if (!c) { t.style.setProperty('--d', 0); return; } const r = t.getBoundingClientRect(); const d = Math.hypot(r.left - c.left, r.top - c.top); t.style.setProperty('--d', Math.min(1, d / 900).toFixed(3)); });
  }
  function openOv() {
    if (OV.open) return; window.WJTheme && window.WJTheme.settle && window.WJTheme.settle();
    if (S.xray) V.setXray(false);
    const go = () => { OV.open = true; OV.entering = canVT(); S.sheet = false; S.rolePick = false; S.index = false; S.impact = null; S.focus = null; V.render(); placeWall(); ripple(); const th = curThumb();
      if (th) { th.focus({ preventScroll: true }); } else $('#ov-title').focus({ preventScroll: true }); V.live(night() ? '全频扫描：' + document.querySelectorAll('.ov .th, .ov .col.cv').length + ' 个电台' : '摊开全本：' + document.querySelectorAll('.ov .th, .ov .col.cv').length + ' 页'); return th; };
    if (!canVT()) { go(); return; }
    const sp = $('#book .spread'); if (sp) sp.style.viewTransitionName = 'wj-page';
    html.dataset.vt = 'ov-in';
    let th;
    let tv; const vt = V.startVT(() => { th = go(); tv = vtEl(th); if (tv) tv.style.viewTransitionName = 'wj-page'; });
    if (!vt) { delete html.dataset.vt; if (sp) sp.style.viewTransitionName = ''; go(); return; }
    V.lastVT = vt;
    vt.finished.finally(() => { delete html.dataset.vt; if (tv) tv.style.viewTransitionName = ''; setTimeout(() => { OV.entering = false; const o = $('.ov'); o && o.classList.remove('entering'); }, 700); });
  }
  function closeOv(target, instant) {
    if (!OV.open) return;
    const accId = target ? target[0] : S.acc, key = target ? target[1] : S.page[S.acc];
    const th = document.querySelector(`.ov [data-k="th-${accId}-${key}"]`);
    const wall = scroller(); OV.scroll = wall ? wall.scrollTop : null;
    const go = () => { OV.open = false; OV.entering = false; OV.last = accId + '|' + key; OV.from = true; S.impact = null;
      if (accId !== S.acc) { S.acc = accId; S.sheet = false; S.sheetSel = null; }
      const p = V.pageOf(db.acc[accId], key); if (p) S.page[accId] = key;
      S.fx = { type: 'role' }; S.focus = 'page-title'; V.render(); };
    if (night() && MAP[accId + '|' + key]) setRead(accId + '|' + key);
    if (instant || !canVT()) { go(); return; }
    const tv = vtEl(th); if (tv) tv.style.viewTransitionName = 'wj-page';
    html.dataset.vt = 'ov-out';
    const vt = V.startVT(() => { if (tv) tv.style.viewTransitionName = ''; go(); const sp = $('#book .spread'); if (sp) sp.style.viewTransitionName = 'wj-page'; });
    if (!vt) { delete html.dataset.vt; if (tv) tv.style.viewTransitionName = ''; go(); return; }
    V.lastVT = vt;
    vt.finished.finally(() => { delete html.dataset.vt; const sp = $('#book .spread'); if (sp) sp.style.viewTransitionName = ''; });
  }
  function toggleOv() { if (OV.open) closeOv(); else openOv(); }
  function rerender(keepFocusK) { const a = document.activeElement; const k = keepFocusK || (a && a.dataset ? a.dataset.k : null); const sel = a && a.tagName === 'INPUT' ? [a.selectionStart, a.selectionEnd] : null;
    S.focus = null; V.render(); if (k) { const el = document.querySelector(`[data-k="${CSS.escape(k)}"]`); if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) el.setSelectionRange(sel[0], sel[1]); } } }
  function ovSearch(q) { OV.q = q; rerender('ov-q'); }

  // ---------- 动作 ----------
  Object.assign(V.ACT, {
    'ov-go': (el) => closeOv([el.dataset.acc, el.dataset.page]),
    'ov-scope': (el) => { OV.scope = el.dataset.v; rerender(); if (scroller()) scroller().scrollTop = 0; V.live(OV.scope === 'all' ? '范围：全部账号，按本分开' : '范围：只看 ' + S.acc); },
    'ov-acc': (el) => { OV.scope = 'acc'; ovAcc(el.dataset.v); const b = document.querySelector(`[data-k="sc-${el.dataset.v}"]`); b && b.focus(); V.live('范围：只看 ' + el.dataset.v); },
    'ov-filter': (el) => { OV.filter = el.dataset.v; rerender(); },
    'ov-cause': (el) => { OV.cause = OV.cause === el.dataset.v ? null : el.dataset.v; OV.focus = null; rerender(); },
    'ov-focus': (el) => { const v = el.dataset.v || null; OV.focus = OV.focus === v ? null : v; OV.cause = null; S.impact = null; rerender(OV.focus ? 'rs-' + OV.focus : 'rs-' + (el.dataset.v || '')); if (!OV.focus) { const f = document.querySelector('.rl-list .rs'); if (document.activeElement === document.body && f) f.focus(); }
      if (OV.focus) { const h = document.querySelector('.ov .th.hit, .ov .col.hit'); const w = scroller(); if (h && w) { const wr = w.getBoundingClientRect(), r = h.getBoundingClientRect(); if (r.top < wr.top || r.bottom > wr.bottom) w.scrollTop += r.top - wr.top - 60; } }
      V.live(OV.focus ? `${night() ? '追踪' : '荧光笔划出'}：${document.querySelectorAll('.ov .th.hit, .ov .col.cv.hit').length} 页用到` : '已放下荧光笔'); },
    'ov-clear': () => { OV.q = ''; OV.filter = 'all'; OV.cause = null; OV.focus = null; rerender('ov-q'); }
  });
  const oldImpact = V.ACT.impact; V.ACT.impact = (el) => { if (!OV.open) return oldImpact(el); S.impact = S.impact === el.dataset.v ? null : el.dataset.v; rerender(); };
  document.addEventListener('input', (ev) => { if (ev.target.matches && ev.target.matches('.ov-q input')) ovSearch(ev.target.value); });
  function ovAcc(id) { if (!db.acc[id]) return; S.acc = id; OV.cause = null; if (OV.focus && OV.focus.startsWith('role:') && D.ROLES[OV.focus.slice(5)].src !== 'public' && D.ROLES[OV.focus.slice(5)].owner !== id) OV.focus = null; OV.scroll = null; rerender(); const w = scroller(); if (w && OV.scope === 'all') { const b = document.querySelector(`.ov-book[data-acc="${id}"], .spx[data-acc="${id}"]`); if (b) w.scrollTop = b.offsetTop - 8; } else if (w) w.scrollTop = 0; }
  const oldAcc = V.ACT.acc; V.ACT.acc = (el) => { if (OV.open) { ovAcc(el.dataset.v); return; } oldAcc(el); };

  // ---------- 键盘：方向键在墙上走、Enter 翻过去、/ 搜索、A 切范围、Esc 逐级退出 ----------
  function move(dir) {
    const all = [...document.querySelectorAll('.ov .th, .ov .lay, .ov .col[data-k]')]; if (!all.length) return;
    const cur = document.activeElement && all.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { (curThumb() || all[0]).focus(); return; }
    const i = all.indexOf(cur); let next = null;
    if (dir === 'L') next = all[i - 1]; else if (dir === 'R') next = all[i + 1];
    else { const c = cur.getBoundingClientRect(); const cx = c.left + c.width / 2; let best = 1e9;
      all.forEach(t => { if (t === cur) return; const r = t.getBoundingClientRect(); const dy = dir === 'U' ? c.top - r.bottom : r.top - c.bottom; if (dy < -4) return; const sc = Math.max(0, dy) * 3 + Math.abs(r.left + r.width / 2 - cx); if (sc < best) { best = sc; next = t; } }); }
    if (!next && (dir === 'U' || dir === 'D') && night()) next = all[Math.max(0, Math.min(all.length - 1, i + (dir === 'U' ? -6 : 6)))];
    if (dir === 'H') next = all[0]; if (dir === 'E') next = all[all.length - 1];
    if (next && next !== cur) { next.focus({ preventScroll: true }); next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: V.reduced() ? 'auto' : 'smooth' }); }
  }
  function ovKey(ev) {
    const k = ev.key; const lk = k.toLowerCase();
    if (ev.altKey && /^[1-3]$/.test(k)) { ev.preventDefault(); ovAcc(db.order[+k - 1]); return true; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (k === 'Escape') { ev.preventDefault(); if ($('#demo') && !$('#demo').hidden) return false; if (S.impact) { S.impact = null; rerender(); } else if (OV.focus || OV.cause) { const f = OV.focus; OV.focus = null; OV.cause = null; rerender(f ? 'rs-' + f : null); } else closeOv(); return true; }
    if (lk === 'o' || lk === 'i') { ev.preventDefault(); closeOv(); return true; }
    if (k === '/') { ev.preventDefault(); const q = $('.ov-q input'); q && q.focus(); return true; }
    if (lk === 'a') { ev.preventDefault(); V.ACT['ov-scope']({ dataset: { v: OV.scope === 'all' ? 'acc' : 'all' } }); return true; }
    const map = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D' };
    if ((k === 'Home' || k === 'End') && ev.target.closest && ev.target.closest('.ov-wall')) { ev.preventDefault(); move(k === 'Home' ? 'H' : 'E'); return true; }
    if (map[k]) { const t = ev.target; if (t.closest && t.closest('.ov-rail, .ov-cz, .ov-h')) { if (k === 'ArrowUp' || k === 'ArrowDown') { const list = [...t.closest('.ov-rail, .ov-cz, .ov-h').querySelectorAll('button')]; const i = list.indexOf(t); const n = list[i + (k === 'ArrowUp' ? -1 : 1)]; if (n) { ev.preventDefault(); n.focus(); } return true; } return true; } ev.preventDefault(); move(map[k]); return true; }
    if (k === ' ' || lk === 'b') { if (k === ' ' && ev.target.tagName === 'BUTTON') return false; ev.preventDefault(); return true; }
    return false;
  }
  Object.assign(V, { ovRerender: rerender, renderOv, openOv, closeOv, toggleOv, ovKey, ovSearch, ovAcc, openFromOv: (a, k) => closeOv([a, k]), ovInfo: info });
  if (/(^|[#&])ov=1/.test(location.hash)) openOv();
})();
