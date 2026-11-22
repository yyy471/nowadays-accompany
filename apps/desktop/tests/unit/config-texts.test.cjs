"use strict";

// v6 保留文字总表：钉死 T 文案的原文与折叠规则，防多处使用时漂移。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(
    pathToFileURL(path.join(__dirname, "../../renderer/src/components/config/config-texts.js")).href
  );

test("T 文案与规范原文一致", async () => {
  const m = await load();
  assert.equal(m.T1, "未选择对话模型；保存后角色无法开始对话。");
  assert.equal(m.T12, "换了站点，请重新填写密钥。");
  assert.equal(m.T22, "还没有立绘");
  assert.equal(m.T27, "至少保留一套服饰");
  assert.equal(m.T28, "请输入 1–1000000 的整数");
  assert.equal(m.T38, "至少保留一个角色。");
  assert.equal(m.T33.optionSuffix, "（已全局停用，不能选用）");
  assert.equal(m.T34.option, "原服务已删除（请重新选择）");
  assert.equal(m.T31.outfit.ask("日常常服"), "删除「日常常服」？衣柜里不再显示，历史消息里引用的图仍保留。");
  assert.equal(m.T31.role.keep, "保留本机数据（记忆、对话与日记，之后可重建同名角色找回）");
  // 没有任何「停止后可编辑」类文案（v6 硬性减法）。
  const all = JSON.stringify(m);
  assert.equal(all.includes("停止后可编辑"), false);
  assert.equal(all.includes("可编辑"), false);
});

test("T 带参数文案按规范模板拼接", async () => {
  const m = await load();
  assert.equal(m.T6.state(2), "设定 · 2 处改动未保存");
  assert.equal(m.T6.pauseAndSave(3), "暂停并保存 3");
  assert.equal(m.T8.filled(4), "已填写 4 项");
  assert.equal(m.T9.text(5), "5 处修改还没保存，关闭会丢掉它们。");
  assert.equal(m.T16.testOk(812), "✓ 测试通过 · 812 ms");
  assert.equal(m.T16.testFail("401 未授权（检查密钥）"), "✕ 连接失败：401 未授权（检查密钥）");
  assert.equal(m.T35("后端没有响应"), "读取失败：后端没有响应");
});

test("人名折叠：3 位以内顿号连接，超过 3 位写 A、B 等 N 位角色", async () => {
  const m = await load();
  assert.equal(m.foldNames(["阿遥"]), "阿遥");
  assert.equal(m.foldNames(["阿遥", "林汐"]), "阿遥、林汐");
  assert.equal(m.foldNames(["阿遥", "林汐", "小满"]), "阿遥、林汐、小满");
  assert.equal(
    m.foldNames(["阿遥", "林汐", "小满", "第四位"]),
    "阿遥、林汐 等 4 位角色",
  );
  assert.equal(
    m.T13(["甲", "乙", "丙", "丁", "戊"]),
    "保存时会先暂停甲、乙 等 5 位角色，保存后可在页脚「继续活动」。",
  );
  assert.equal(m.T14(["夏澄"]), "保存时先暂停夏澄");
  assert.equal(m.T32.pauseFail(["夏澄"]), "暂停失败：夏澄没有确认停止，改动还在。");
  assert.equal(m.T32.toggleFail("停用", "后端没有响应"), "停用失败：后端没有响应。已恢复原状。");
});
