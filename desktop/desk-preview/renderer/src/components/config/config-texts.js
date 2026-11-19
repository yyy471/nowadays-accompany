/**
 * v6 保留文字总表（规范 §4）：T1–T38 只在各自触发条件下出现，条件消失即消失。
 * 同一文案会出现在纸笺脚、页脚、`#live` 与 aria-label 多处，统一在此防漂移。
 * T18 已在 v6 删除（由 T31 删除确认代替），不设项。
 */

/** T1 未选择对话模型；保存后角色无法开始对话。 */
export const T1 = "未选择对话模型；保存后角色无法开始对话。";
/** T2 摘要「未选择」值 + 第二行提示。 */
export const T2 = { value: "未选择", hint: "角色暂时无法开始对话" };
/** T3 当前服务没有预置音色，请改用参考音频。 */
export const T3 = "当前服务没有预置音色，请改用参考音频。";
/** T4 角色页测试反馈：进行中 / 成功（带毫秒） / 失败（带原因）。 */
export const T4 = {
  testing: "正在测试…",
  ok: (ms) => `连接正常 · ${ms} ms`,
  fail: (reason) => `连接失败：${reason}`,
};
/** T5 {N} 字（人设字数）。 */
export const T5 = (count) => `${count} 字`;
/** T6 设定页脚：左侧状态 + 放弃 / 保存（未停止时「暂停并保存」）。 */
export const T6 = {
  state: (count) => `设定 · ${count} 处改动未保存`,
  discard: "放弃",
  save: (count) => `保存 ${count}`,
  pauseAndSave: (count) => `暂停并保存 ${count}`,
};
/** T7 {项名、项名} 有改动未保存（其他分区页脚）。 */
export const T7 = (names) => `${names.join("、")} 有改动未保存`;
/** T8 纸笺页脚左侧：已改动 / 新建已填写。 */
export const T8 = {
  dirty: (count) => `${count} 处改动未保存`,
  filled: (count) => `已填写 ${count} 项`,
};
/** T9 关闭确认 + 继续编辑 / 放弃修改。 */
export const T9 = {
  text: (count) => `${count} 处修改还没保存，关闭会丢掉它们。`,
  keep: "继续编辑",
  drop: "放弃修改",
};
/** T10 新建必填缺失（按类型给第一句）。 */
export const T10 = {
  name: "请填写名称。",
  url: "请填写服务地址。",
  command: "请填写启动命令。",
  env: "环境变量需要是 JSON 对象。",
  source: "请填写来源目录。",
};
/** T11 MCP 环境变量格式错误。 */
export const T11 = "需要 JSON 对象，值须为字符串";
/** T12 换了站点，请重新填写密钥。 */
export const T12 = "换了站点，请重新填写密钥。";
/** T13 保存时会先暂停 {角色、角色}（>3 位折叠为「A、B 等 N 位角色」）。 */
export const T13 = (names) =>
  `保存时会先暂停${foldNames(names)}，保存后可在页脚「继续活动」。`;
/** T14 保存时先暂停 {角色}（纸笺脚，单行省略，title 全名单）。 */
export const T14 = (names) => `保存时先暂停${foldNames(names)}`;
/** T15 先探测服务，再选择默认引擎。 */
export const T15 = "先探测服务，再选择默认引擎。";
/** T16 设置页测试/探测/读取反馈。 */
export const T16 = {
  needUrl: "请先填写服务地址。",
  testing: "正在测试…",
  probing: "正在探测…",
  reading: "正在读取…",
  readOk: (count) => `✓ 已读取 ${count} 个模型`,
  probeOk: (count) => `✓ 探测到 ${count} 个引擎`,
  testOk: (ms) => `✓ 测试通过 · ${ms} ms`,
  needModel: "请先选择或填写模型名。",
  testFail: (reason) => `✕ 连接失败：${reason}`,
  readFail: (reason) => `✕ 读取失败：${reason}`,
  probeFail: (reason) => `✕ 探测失败：${reason}`,
};
/** T17 {角色名}活动中，暂不能删除（先在「角色」里停止）。 */
export const T17 = (names) => `${names.join("、")}活动中，暂不能删除（先在「角色」里停止）`;
/** T19 底栏身份区状态词。 */
export const T19 = {
  active: "活动中",
  stopping: "正在停止…",
  stopped: "已停止",
  resuming: "正在恢复…",
};
/** T20 角色状态卡：状态词 + 按钮文字 + 链接。 */
export const T20 = {
  state: T19,
  stop: "停止活动",
  stopping: "正在停止…",
  resume: "恢复活动",
  resuming: "正在恢复…",
  configure: "角色配置",
};
/** T21 初始化失败 + 原因（恢复活动时会重试）。 */
export const T21 = (reason) => `${reason}，恢复活动时会重试。`;
/** T22 还没有立绘。 */
export const T22 = "还没有立绘";
/** T23 摘要空值。 */
export const T23 = {
  none: "无",
  unset: "未设置",
  unselected: "未选择",
  auto: "由服务决定",
};
/** T24 密钥显隐。 */
export const T24 = { show: "显示", hide: "隐藏" };
/** T25 纸笺跳转链接。 */
export const T25 = {
  viewModel: "在设置中查看模型 →",
  manage: "在设置中管理 →",
  image: "去生图设置 →",
  add: "去设置添加 →",
};
/** T26 本机版本与连接。 */
export const T26 = { connected: "已连接", failed: "读取失败", version: "CHARACTER STUDIO / 开发版" };
/** T27 至少保留一套服饰。 */
export const T27 = "至少保留一套服饰";
/** T28 请输入 1–1000000 的整数。 */
export const T28 = "请输入 1–1000000 的整数";
/** T29 暂停并保存 / 进行中文字。 */
export const T29 = {
  pauseAndSave: (count) => `暂停并保存 ${count}`,
  save: (count) => `保存 ${count}`,
  add: "添加",
  pausing: "正在暂停…",
  saving: "正在保存…",
  deleting: "正在删除…",
  pausingRoles: (names) => `正在暂停${foldNames(names)}…`,
  retry: (verb) => `重试${verb}`,
};
/** T30 已为保存暂停 {角色}　继续活动 / 正在恢复…。 */
export const T30 = {
  text: (names) => `已为保存暂停${foldNames(names)}`,
  resume: "继续活动",
  resuming: "正在恢复…",
};
/** T31 删除确认（§7.7 全套文案）。 */
export const T31 = {
  service: {
    title: (kind) => `删除${kind}`,
    ask: (name) => `删除「${name}」？`,
    inUse: (roles) => `${roles} 仍选着它；删除后这些位置显示「原服务已删除」，需要重新选择。`,
    unused: "没有角色在用它。",
    voiceCopies: (names, count) => `同时移除 ${names} 在该服务下保存的音色与表现配置（${count} 份）。`,
  },
  outfit: {
    title: "删除服饰",
    ask: (name) => `删除「${name}」？衣柜里不再显示，历史消息里引用的图仍保留。`,
    current: "这是当前服饰；删除后改为随机穿上剩下的一套。",
  },
  role: {
    title: "删除角色",
    ask: (name) => `删除「${name}」？角色列表与设置里都不再显示。`,
    keep: "保留本机数据（记忆、对话与日记，之后可重建同名角色找回）",
    remove: "一并删除本机数据（不可恢复）",
    keepLegend: "本机数据",
  },
  delete: "删除",
  pauseAndDelete: "暂停并删除",
  cancel: "取消",
};
/** T32 写入失败三态。 */
export const T32 = {
  pauseFail: (names) => `暂停失败：${foldNames(names)}没有确认停止，改动还在。`,
  saveFailPaused: (verb, reason, names) => `${verb}失败：${reason}。${foldNames(names)}已暂停，改动还在。`,
  saveFail: (verb, reason) => `${verb}失败：${reason}。改动还在。`,
  toggleFail: (verb, reason) => `${verb}失败：${reason}。已恢复原状。`,
};
/** T33 全局停用服务相关文案。 */
export const T33 = {
  optionSuffix: "（已全局停用，不能选用）",
  switchNote: "已全局停用，不能开启",
  selectedNote: "所选服务已全局停用，请重新选择或去设置里启用。",
};
/** T34 原服务已删除。 */
export const T34 = {
  option: "原服务已删除（请重新选择）",
  value: "原服务已删除，请重新选择",
};
/** T35 读取失败：{原因} + 重试。 */
export const T35 = (reason) => `读取失败：${reason}`;
export const T35_RETRY = "重试";
/** T36 空列表。 */
export const T36 = {
  kind: (kind) => `还没有${kind}。`,
  settingsKind: (kind) => `设置里还没有${kind}。`,
};
/** T37 切换角色确认。 */
export const T37 = {
  text: (count, from, to) => `「${from}」有 ${count} 处修改还没保存，切换到「${to}」会丢掉它们。`,
  confirm: "放弃并切换",
  cancel: "取消",
};
/** T38 至少保留一个角色。 */
export const T38 = "至少保留一个角色。";

/**
 * 人名折叠：>3 位时写「A、B 等 N 位角色」，否则顿号连接。
 * @param {string[]} names
 * @returns {string}
 */
export function foldNames(names) {
  if (names.length > 3) {
    return `${names.slice(0, 2).join("、")} 等 ${names.length} 位角色`;
  }
  return names.join("、");
}

/** aria-label 模板（§4 末尾：读屏文字必须保留）。 */
export const ARIA = {
  editItem: (item) => `编辑${item}`,
  editGroup: (item, group) => `只编辑${item}的${group}`,
  saveCount: (count) => `保存 ${count} 处改动`,
  saveIdle: "保存（暂无改动）",
  saveInvalid: "保存（有错误）",
  addNeedRequired: "添加（请先填写必填项）",
  enableService: (name) => `全局启用${name}`,
  refreshStatus: "刷新状态",
  switchRole: "切换角色",
  openRoleConfig: (name) => `${name}的角色配置`,
  enableForRole: (name) => `为角色开启${name}`,
};

/** placeholder 表（规范 §4）。 */
export const PLACEHOLDER = {
  roleModelName: "从列表选择或手填",
  settingsModelName: "读取列表后选择，或直接手填",
  imageModel: "模型文件名或本地目录",
  negativePrompt: "可留空",
  seed: "留空则每次随机",
  referenceText: "与参考音频一致的文本",
  trialText: "输入一句用来试听的文本",
  trialEmotion: "可选",
  modelUrl: "https://…/v1",
  voiceUrl: "http://127.0.0.1:9890",
  imageUrl: "http://127.0.0.1:8188",
  secretKeep: "留空则保留原密钥",
  secretOptional: "选填",
  imageDefaultModel: "可选，如 xxx.safetensors",
  mcpCommand: "例如 npx、uvx、node",
  mcpArgs: "每行一个参数",
  mcpEnv: '{"KEY": "value"}',
  skillSource: "SKILL.md 所在目录",
  newName: "起一个好认的名字",
};
