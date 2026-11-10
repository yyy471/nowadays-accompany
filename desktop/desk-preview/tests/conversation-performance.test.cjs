"use strict";

// 对话演出引擎与历史检索纯逻辑测试。运行：在 desktop/desk-preview 下执行 `npm test`。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const loadPerf = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/conversation/performance.js")).href);
const loadHistory = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/conversation/history.js")).href);
const loadFixtures = () =>
  import(pathToFileURL(path.join(__dirname, "../renderer/src/conversation/fixtures.js")).href);

/** 手动时钟：推进时间并按到期顺序触发引擎定时器。 */
function manualClock() {
  let elapsed = 0;
  const queue = [];
  return {
    setTimeout(fn, ms) {
      const id = queue.length;
      queue.push({ id, at: elapsed + ms, fn });
      return id;
    },
    clearTimeout(id) {
      const index = queue.findIndex(entry => entry.id === id);
      if (index >= 0) queue.splice(index, 1);
    },
    run(ms) {
      elapsed += ms;
      const due = queue
        .filter(entry => entry.at <= elapsed)
        .sort((left, right) => left.at - right.at);
      for (const entry of due) {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        entry.fn();
      }
    }
  };
}

const create = async ({ scenario } = {}) => {
  const { ConversationPerformance } = await loadPerf();
  const clock = manualClock();
  const engine = new ConversationPerformance({ scenario, clock });
  return { engine, clock };
};

test("发送后首段自动出现，逐句推进到末段后恢复输入框", async () => {
  const { engine, clock } = await create();
  const before = engine.snapshot().messages.length;
  assert.equal(engine.send("今天有点累"), true);
  const sent = engine.snapshot();
  assert.ok(sent.activeId !== null, "发送后处于回复中");
  assert.equal(sent.messages.length, before + 1, "先加入用户消息");
  assert.equal(sent.canAdvance, false);

  clock.run(440);
  let snap = engine.snapshot();
  assert.equal(snap.messages.length, before + 2, "首段自动出现");
  assert.ok(snap.messages.at(-1).text.length > 0);
  assert.equal(snap.canAdvance, false, "首段就绪后等待下一段");

  clock.run(700);
  snap = engine.snapshot();
  assert.equal(snap.canAdvance, true, "动作段已就绪可推进");
  assert.equal(engine.advance(), true);
  snap = engine.snapshot();
  assert.ok(snap.messages.at(-1).actionVisible, "推进显示动作文字");

  clock.run(700);
  snap = engine.snapshot();
  assert.equal(snap.canAdvance, true, "末段已就绪");
  assert.equal(engine.advance(), true);
  snap = engine.snapshot();
  assert.equal(snap.activeId, null, "末段显示后回复结束，输入框可恢复");
  assert.equal(snap.canAdvance, false);
});

test("单句回复首段显示即恢复输入框", async () => {
  const { engine, clock } = await create({ scenario: "single" });
  assert.equal(engine.send("你好"), true);
  clock.run(440);
  const snap = engine.snapshot();
  assert.equal(snap.activeId, null, "单句回复自动展示首段后结束");
  assert.ok(snap.messages.at(-1).text.length > 0);
});

test("回复失败显示终态并恢复输入框，不产生可展示句段", async () => {
  const { engine, clock } = await create({ scenario: "failure" });
  const before = engine.snapshot().messages.length;
  assert.equal(engine.send("你好"), true);
  clock.run(480);
  const snap = engine.snapshot();
  assert.equal(snap.activeId, null);
  assert.equal(snap.error.length > 0, true);
  assert.equal(snap.messages.length, before + 1, "只保留用户消息，无回复句段");
});

test("中断回复保留已生成段落并标记未说完", async () => {
  const { engine, clock } = await create({ scenario: "interrupted" });
  assert.equal(engine.send("你好"), true);
  clock.run(440);
  clock.run(700);
  let snap = engine.snapshot();
  assert.equal(snap.canAdvance, true, "中断后已确定段落可推进");
  assert.equal(engine.advance(), true);
  snap = engine.snapshot();
  assert.equal(snap.activeId, null);
  assert.equal(snap.messages.at(-1).status, "interrupted");
});

test("过场图从回复发起，绑定整轮句段区间并异步完成", async () => {
  const { engine, clock } = await create();
  engine.send("今天有点累");
  clock.run(440);
  clock.run(700);
  engine.advance();
  clock.run(700);
  engine.advance();
  const messageId = engine.snapshot().messages.at(-1).messageId;
  assert.equal(engine.requestScene(messageId, "background"), true);
  let snap = engine.snapshot();
  assert.equal(snap.scenes[0].status, "generating");
  assert.equal(snap.scenes[0].start, 0);
  assert.equal(snap.scenes[0].end, 2, "区间取首段到末段");
  clock.run(1400);
  snap = engine.snapshot();
  assert.equal(snap.scenes[0].status, "succeeded");
  assert.equal(snap.scenes[0].source, "manual");
});

test("场景失败保持失败状态，不影响文字阅读", async () => {
  const { engine, clock } = await create({ scenario: "scene-failure" });
  engine.send("今天有点累");
  clock.run(440);
  clock.run(700);
  engine.advance();
  clock.run(700);
  engine.advance();
  const messageId = engine.snapshot().messages.at(-1).messageId;
  engine.requestScene(messageId, "full_scene");
  clock.run(1400);
  const snap = engine.snapshot();
  assert.equal(snap.scenes[0].status, "failed");
  assert.ok(snap.messages.at(-1).text.length > 0, "失败后已显示台词仍可读");
});

test("历史检索：按日统计、命中与片段上下文", async () => {
  const { buildDays, daySnippets, findHits, dotTier, rangesFor, termsFor } = await loadHistory();
  const { seedMessages } = await loadFixtures();
  const rows = seedMessages(Date.now()).map((message, index) => ({
    id: index + 1,
    messageId: `seed-${index + 1}`,
    segmentId: `seed-${index + 1}-0`,
    ordinal: 0,
    role: message.role,
    text: message.text,
    action: message.action,
    actionVisible: Boolean(message.action),
    sprite: null,
    status: "completed",
    createdAt: message.createdAt
  }));

  const days = buildDays(rows);
  assert.ok(days.length > 1, "跨多天生成历史");
  assert.ok(days.every(day => day.count >= 1));

  const hits = findHits(rows, "咖啡");
  assert.ok(hits.length > 0, "命中示例素材中的词");
  assert.deepEqual(termsFor(" 杯 子 "), ["杯", "子"]);

  const ranges = rangesFor("我端着一杯咖啡，杯子是热的。", "杯子");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0][0] > 0, true);

  const key = days.at(-1).key;
  const cards = daySnippets(rows, key, "");
  assert.ok(cards.length >= 1, "最近一天有可展示片段");
  assert.equal(cards[0].lines.some(line => line.main), true);
  assert.ok([1, 2, 3].includes(dotTier(5)));
});
