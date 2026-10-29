/* 接线 · 手账 / 电台 概念原型 —— 虚构示例数据与解析规则（只在本页内存中，刷新恢复）。
 * 规则：账号是孤岛（每本手账 / 每台收音机各存一份）；设置三层：账号通用 → 群聊或私聊分类 → 单个会话；
 * 每层 跟随 / 开启 / 关闭；角色卡只在会话页上逐个绑定，没有账号默认角色。 */
window.WJData = (function () {
  'use strict';
  // 资源定义。src: public 公共 / private 账号私有 / plugin 由插件提供
  const DEF = {
    P: { id: 'P', type: 'plugin', name: '天气小报', src: 'public', note: '提供 Skill S；本身不会回消息' },
    Q: { id: 'Q', type: 'plugin', name: '图片工坊', src: 'public', note: '本身不会回消息' },
    S: { id: 'S', type: 'skill', name: '天气播报', src: 'plugin', plugin: 'P' },
    X: { id: 'X', type: 'skill', name: '读书摘录', src: 'public', tool: ['memory.lookup', '读取记忆'] },
    U: { id: 'U', type: 'skill', name: '群文件助手', src: 'public', tool: ['group.file.read', '读取群文件'] },
    T: { id: 'T', type: 'skill', name: '礼貌用语', src: 'private' },
    W: { id: 'W', type: 'skill', name: '夜读口吻', src: 'private' }
  };
  const ROLES = {
    R: { id: 'R', name: '书店店员', src: 'public', rev: 'r4', look: 'clerk' },
    R2: { id: 'R2', name: '夜航主播', src: 'public', rev: 'r2', look: 'host' },
    R3: { id: 'R3', name: '晴天邮差', src: 'private', owner: 'A', rev: 'a1', look: 'post' },
    R4: { id: 'R4', name: '灯塔守夜人', src: 'private', owner: 'B', rev: 'b3', look: 'keeper' },
    R5: { id: 'R5', name: '园艺顾问', src: 'public', rev: 'r1', look: 'garden' },
    R6: { id: 'R6', name: '校园广播员', src: 'public', rev: 'r3', look: 'announcer' }
  };
  const L = (key, kind, id, name, peer, no, freq, role) => ({ key, kind, id, name, peer, no, freq, role: role || null, type: key === 'acc' ? 'account' : key.startsWith('k:') ? 'kind' : 'conv' });
  // 大量会话的示例：确定性伪随机（同一个种子每次一样），全部虚构
  const GROUPS = ['读书会', '周末徒步', '摄影交流', '羽毛球搭子', '烘焙小组', '观鸟记录', '夜跑团', '植物交换', '二手书摊', '桌游之夜', '天文爱好', '咖啡探店', '手作市集', '骑行周末', '合唱排练',
    '旧物修理', '方言研究', '城市散步', '电影放映', '猫咪救助', '社区菜园', '古琴雅集', '书法练习', '播客收听', '拼图同好', '露营装备', '早起打卡', '外语角', '编织社', '志愿服务'];
  const PEOPLE = ['小林', '阿杏', '老周', '青青', '大鹏', '苏苏', '阿晨', '小满', '星河', '木木', '一禾', '南风', '小舟', '阿宁', '栗子', '豆豆'];
  function rng(seed) { let x = (Math.imul(seed, 2654435761) ^ 0x9E3779B9) >>> 0; const f = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; for (let i = 0; i < 12; i++) f(); return f; }
  function bigPages(acc, nG, nP, roles, seedN, off) {
    const r = rng(seedN); const pages = [L('acc', null, null, '账号通用', null, 1, 87.6), L('k:group', 'group', null, '群聊分类', null, 2, 89.3)]; const layers = {};
    const ids = acc.sheet; let no = 3; const letters = (i) => 'C' + String(i + 1).padStart(2, '0');
    for (let i = 0; i < nG; i++) { const f = 90.8 + (99.0 - 90.8) * (nG === 1 ? 0 : i / (nG - 1)); const key = 'c:g' + i;
      pages.push(L(key, 'group', letters(i), GROUPS[(i + off) % GROUPS.length], String(700001 + i), no++, Math.round(f * 10) / 10, r() < 0.14 ? null : roles[Math.floor(r() * roles.length)])); }
    if (off === 0) { pages[2].role = 'R'; pages[3].role = null; }
    pages.push(L('k:private', 'private', null, '私聊分类', null, no++, 100.0));
    for (let i = 0; i < nP; i++) { const f = 101.0 + (107.4 - 101.0) * (nP === 1 ? 0 : i / (nP - 1)); const key = 'c:p' + i;
      pages.push(L(key, 'private', 'P' + String(i + 1).padStart(2, '0'), PEOPLE[(i + off) % PEOPLE.length], String(800001 + i), no++, Math.round(f * 10) / 10, r() < 0.12 ? null : roles[Math.floor(r() * roles.length)])); }
    pages.filter(p => p.type === 'conv').forEach(p => { const o = {}; const n = r() < 0.45 ? 0 : 1 + Math.floor(r() * 2.4);
      for (let k = 0; k < n; k++) { const id = ids[Math.floor(r() * ids.length)]; o[id] = r() < 0.55 ? 'on' : 'off'; } layers[p.key] = o; });
    return { pages, layers };
  }
  function seed(big) {
    const db = seedSmall();
    if (!big) return db;
    const A = db.acc.A, B = db.acc.B, C = db.acc.C;
    const a = bigPages(A, 30, 16, ['R', 'R2', 'R3', 'R5', 'R6'], 7, 0); A.pages = a.pages; A.layers = Object.assign({ acc: A.layers.acc, 'k:group': A.layers['k:group'], 'k:private': A.layers['k:private'] }, a.layers);
    const b = bigPages(B, 5, 3, ['R', 'R4', 'R6'], 11, 0); B.pages = b.pages; B.layers = Object.assign({ acc: B.layers.acc, 'k:group': B.layers['k:group'], 'k:private': {} }, b.layers);
    const c = bigPages(C, 4, 2, ['R', 'R5'], 23, 9); C.pages = c.pages; C.layers = Object.assign({ acc: C.layers.acc, 'k:group': C.layers['k:group'], 'k:private': {} }, c.layers);
    db.big = true; return db;
  }
  function seedSmall() {
    return {
      order: ['A', 'B', 'C'],
      acc: {
        A: {
          id: 'A', name: '晴天信箱', qq: '10001', status: 'online', cover: 'navy',
          sheet: ['P', 'Q', 'S', 'X', 'U', 'T'], ready: { P: true, Q: false }, readyWhy: { Q: '图片服务没有启动' },
          auth: ['memory.lookup'], privateOverride: {},
          pages: [
            L('acc', null, null, '账号通用', null, 1, 87.8),
            L('k:group', 'group', null, '群聊分类', null, 2, 90.4),
            L('c:C', 'group', 'C', '读书会', '700001', 3, 92.9, 'R'),
            L('c:D', 'group', 'D', '周末徒步', '700002', 4, 95.3, null),
            L('c:E', 'group', 'E', '摄影交流', '700003', 5, 97.7, 'R2'),
            L('k:private', 'private', null, '私聊分类', null, 6, 100.2),
            L('c:F', 'private', 'F', '小林', '800001', 7, 102.6, 'R3'),
            L('c:G', 'private', 'G', '阿杏', '800002', 8, 105.1, 'R')
          ],
          layers: {
            acc: { P: 'on', S: 'on', T: 'on', X: 'off' },
            'k:group': { X: 'on', U: 'on' },
            'k:private': { S: 'off' },
            'c:C': { X: 'off', Q: 'on' },
            'c:D': { P: 'off' },
            'c:E': { S: 'off' },
            'c:F': { X: 'on' },
            'c:G': {}
          }
        },
        B: {
          id: 'B', name: '夜航电台', qq: '10002', status: 'offline', cover: 'rose',
          sheet: ['P', 'S', 'X', 'W'], ready: { P: true }, readyWhy: {},
          auth: ['memory.lookup'], privateOverride: { X: 'B 本私有的同 ID 版本' },
          pages: [
            L('acc', null, null, '账号通用', null, 1, 87.8),
            L('k:group', 'group', null, '群聊分类', null, 2, 90.4),
            L('c:C', 'group', 'C', '读书会', '700001', 3, 93.6, 'R4'),
            L('k:private', 'private', null, '私聊分类', null, 4, 100.2),
            L('c:K', 'private', 'K', '听众来信', '800101', 5, 103.4, 'R')
          ],
          layers: { acc: { P: 'on', S: 'on', W: 'on' }, 'k:group': { X: 'on' }, 'k:private': {}, 'c:C': { W: 'off' }, 'c:K': {} }
        },
        C: {
          id: 'C', name: '编辑部', qq: '10003', status: 'online', cover: 'sage',
          sheet: ['P', 'S', 'X'], ready: { P: true }, readyWhy: {},
          auth: ['memory.lookup'], privateOverride: {},
          pages: [
            L('acc', null, null, '账号通用', null, 1, 87.8),
            L('k:group', 'group', null, '群聊分类', null, 2, 90.4),
            L('c:M', 'group', 'M', '校对小组', '700201', 3, 94.1, 'R'),
            L('k:private', 'private', null, '私聊分类', null, 4, 100.2),
            L('c:N', 'private', 'N', '投稿人', '800201', 5, 104.0, null)
          ],
          layers: { acc: { X: 'on', P: 'on' }, 'k:group': { U: 'on', S: 'on' }, 'k:private': {}, 'c:M': {}, 'c:N': {} }
        }
      }
    };
  }

  const LAYER_NAME = { acc: '账号通用', 'k:group': '群聊分类', 'k:private': '私聊分类' };
  const NIGHT_LAYER = { acc: '总台', 'k:group': '群聊分台', 'k:private': '私聊分台' };
  function chainKeys(page) {
    if (page.type === 'account') return ['acc'];
    if (page.type === 'kind') return ['acc', page.key];
    return ['acc', 'k:' + page.kind, page.key];
  }
  // draft: { layers: {pageKey: {id: 'on'|'off'|null(=跟随)}}, roles: {pageKey: roleId|null} }
  function layerVal(acc, draft, pk, id) {
    const d = draft && draft.layers[pk];
    if (d && Object.prototype.hasOwnProperty.call(d, id)) return d[id] || 'inherit';
    const v = acc.layers[pk] && acc.layers[pk][id];
    return v || 'inherit';
  }
  function resolve(acc, draft, page, id) {
    const keys = chainKeys(page); let value = 'off', source = 'default'; const chain = [];
    keys.forEach(k => { const v = layerVal(acc, draft, k, id); chain.push({ key: k, v }); if (v !== 'inherit') { value = v; source = k; } });
    const below = (() => { let bv = 'off', bs = 'default'; keys.slice(0, -1).forEach(k => { const v = layerVal(acc, draft, k, id); if (v !== 'inherit') { bv = v; bs = k; } }); return { value: bv, source: bs }; })();
    return { value, source, chain, own: chain[chain.length - 1].v, below };
  }
  function roleOf(acc, draft, page) {
    if (page.type !== 'conv') return null;
    const d = draft && draft.roles;
    const id = d && Object.prototype.hasOwnProperty.call(d, page.key) ? d[page.key] : page.role;
    return id ? ROLES[id] : null;
  }
  // 「开启但用不了」的原因。返回 [{code, text, fix}]
  function issues(acc, draft, page, id) {
    const def = DEF[id]; const out = [];
    if (!acc.sheet.includes(id)) out.push({ code: 'missing', text: '没安装：' + acc.id + ' 本没有这张贴纸', night: '没安装：' + acc.id + ' 台没有这台设备', fix: 'missing' });
    if (def.tool && !acc.auth.includes(def.tool[0])) out.push({ code: 'auth', text: '缺授权：' + def.tool[1], night: '缺授权：' + def.tool[1], fix: 'auth' });
    if (def.type === 'plugin' && acc.ready[id] === false) out.push({ code: 'ready', text: '插件未就绪', night: '插件未就绪', sub: acc.readyWhy[id], fix: 'ready' });
    if (def.plugin) { const p = resolve(acc, draft, page, def.plugin); if (p.value !== 'on') out.push({ code: 'dep', text: '缺插件 ' + def.plugin + '：这页没贴', night: '缺依赖：插件 ' + def.plugin + ' 没接入本台', fix: 'dep' }); }
    if (acc.status !== 'online') out.push({ code: 'qq', text: 'QQ 没连上', night: 'QQ 没连上', fix: 'qq' });
    return out;
  }
  function srcLabel(acc, id) {
    const d = DEF[id];
    if (acc.privateOverride[id]) return { d: acc.id + ' 本私有', n: acc.id + ' 台私有', cls: 'private' };
    if (d.src === 'plugin') return { d: '插件 ' + d.plugin + ' 提供', n: '插件 ' + d.plugin + ' 提供', cls: 'plugin' };
    if (d.src === 'private') return { d: acc.id + ' 本私有', n: acc.id + ' 台私有', cls: 'private' };
    return { d: '公共', n: '公共', cls: 'public' };
  }
  return { DEF, ROLES, seed, resolve, roleOf, issues, chainKeys, layerVal, srcLabel, LAYER_NAME, NIGHT_LAYER };
})();
