"use strict";

// v6 摘要行状态矩阵（规范 §3）：每个状态项的触发条件在单测层钉死。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/components/config/summary.js")).href);

const svc = (name, enabled) => ({ service: { name, enabled } });

test("对话：未选 / 停用 / 删除 / 正常四态", async () => {
  const { chatRowStatus } = await load();
  assert.deepEqual(chatRowStatus(null), { status: "off", label: "未设置" });
  assert.deepEqual(chatRowStatus(svc("DeepSeek", false)), { status: "off", label: "服务已停用" });
  assert.deepEqual(chatRowStatus({ service: null }), { status: "error", label: "原服务已删除" });
  assert.deepEqual(chatRowStatus(svc("DeepSeek", true)), { status: "ok", label: "生效中" });
});

test("记忆整理：跟随对话 / 异常 / 正常", async () => {
  const { memoryRowStatus } = await load();
  assert.deepEqual(memoryRowStatus(null, true), { status: "follow", label: "跟随对话" });
  assert.deepEqual(memoryRowStatus(svc("DeepSeek", false), false), { status: "off", label: "服务已停用" });
  assert.deepEqual(memoryRowStatus({ service: null }, false), { status: "error", label: "原服务已删除" });
  assert.deepEqual(memoryRowStatus(svc("DeepSeek", true), false), { status: "ok", label: "生效中" });
});

test("语音：未选服务、未选音色、异常、正常", async () => {
  const { voiceRowStatus } = await load();
  assert.deepEqual(voiceRowStatus(null, true), { status: "off", label: "未选音色" });
  assert.deepEqual(voiceRowStatus(svc("IndexTTS", true), false), { status: "off", label: "未选音色" });
  assert.deepEqual(voiceRowStatus(svc("IndexTTS", true), true), { status: "ok", label: "生效中" });
  assert.deepEqual(voiceRowStatus({ service: null }, true), { status: "error", label: "原服务已删除" });
});

test("MCP / Skill：无可选项 / 全关 / 有停用 / 正常", async () => {
  const { extensionRowStatus } = await load();
  assert.deepEqual(extensionRowStatus([]), { status: "none", label: "无可选项" });
  assert.deepEqual(
    extensionRowStatus([{ enabled: true, roleEnabled: false }, { enabled: true, roleEnabled: false }]),
    { status: "off", label: "全部关闭" },
  );
  assert.deepEqual(
    extensionRowStatus([{ enabled: true, roleEnabled: true }, { enabled: false, roleEnabled: true }]),
    { status: "off", label: "有服务已停用" },
  );
  assert.deepEqual(
    extensionRowStatus([{ enabled: true, roleEnabled: true }, { enabled: true, roleEnabled: false }]),
    { status: "ok", label: "生效中" },
  );
});

test("rowDot 规则：off/dirty/error 显示文字，其余只留淡点", async () => {
  const { rowDotVisible } = await load();
  assert.equal(rowDotVisible("off"), true);
  assert.equal(rowDotVisible("dirty"), true);
  assert.equal(rowDotVisible("error"), true);
  assert.equal(rowDotVisible("ok"), false);
  assert.equal(rowDotVisible("follow"), false);
  assert.equal(rowDotVisible("none"), false);
});

test("生图第二行只写值、按规范顺序拼接", async () => {
  const { imageKeys } = await load();
  assert.deepEqual(
    imageKeys({ width: 832, height: 1216, steps: 28, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras" }),
    ["832×1216", "28 步", "CFG 6.5", "dpmpp_2m / karras"],
  );
});

test("语音/额度第二行与额度校验 T28", async () => {
  const { voiceKeys, quotaKeys, quotaLimitBad } = await load();
  assert.deepEqual(voiceKeys({ tone: "中文女 · 温和", speed: 1.0, emotion: 0.6 }), [
    "中文女 · 温和",
    "1.0×",
    "情感 0.6",
  ]);
  assert.deepEqual(quotaKeys({ dailyLimit: 120, unlimited: false, localDate: "2026-11-19" }), [
    "每日 120 点",
    "2026-11-19",
    "本机 00:00 重置",
  ]);
  assert.deepEqual(quotaKeys({ dailyLimit: 0, unlimited: true, localDate: "2026-11-19" }), [
    "不限额",
    "2026-11-19",
    "本机 00:00 重置",
  ]);
  assert.equal(quotaLimitBad({ dailyLimit: 0, unlimited: false }), true);
  assert.equal(quotaLimitBad({ dailyLimit: 1.5, unlimited: false }), true);
  assert.equal(quotaLimitBad({ dailyLimit: 1000001, unlimited: false }), true);
  assert.equal(quotaLimitBad({ dailyLimit: 120, unlimited: false }), false);
  assert.equal(quotaLimitBad({ dailyLimit: 0, unlimited: true }), false);
});

test("本机日期按本地时区（不用 UTC ISO）", async () => {
  const { localDate } = await load();
  // 固定一个本地时刻：2026-11-17 23:30 本地，UTC 视角可能是次日。
  const date = new Date(2026, 10, 17, 23, 30);
  assert.equal(localDate(date), "2026-11-17");
});

test("MCP / Skill 值与开启/停用名单（只算全局启用的）", async () => {
  const { extensionValue, extensionKeys } = await load();
  const items = [
    { name: "文件系统", enabled: true, roleEnabled: true },
    { name: "网页抓取", enabled: true, roleEnabled: false },
    { name: "本机日历", enabled: false, roleEnabled: true },
  ];
  assert.equal(extensionValue(items), "已为角色开启 1 / 3");
  assert.deepEqual(extensionKeys(items), {
    on: ["文件系统"],
    disabled: ["本机日历（已全局停用）"],
  });
});
