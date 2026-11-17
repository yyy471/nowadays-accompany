"use strict";

// 包 3 桌面入口与任务取消的纯逻辑。运行：在 desktop/desk-preview 下执行 `npm test`。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const load = async relative => import(pathToFileURL(path.join(__dirname, "../renderer/src", relative)).href);
const roleEntry = load("entry/role-entry.js");
const taskActions = load("conversation/task-actions.js");
const presetLock = load("components/appearance/preset-lock.js");

const role = (roleId, displayName, extra = {}) => ({ roleId, displayName, status: "ready", initError: null, ...extra });

test("选角页把内置助手排在最前，其余保持创建顺序", async () => {
  const { entryRoles } = await roleEntry;
  const ordered = entryRoles([role("a", "林夕"), role("x", "夏澄", { isBuiltin: true, builtinKey: "xiacheng" }), role("b", "周野")]);
  assert.deepEqual(ordered.map(item => item.roleId), ["x", "a", "b"]);
  assert.equal(ordered[1].displayName, "林夕");
});

test("内置标识与卡片副标题优先使用只读介绍", async () => {
  const { entryBadge, entrySubtitle } = await roleEntry;
  assert.equal(entryBadge(role("x", "夏澄", { isBuiltin: true })), "内置助手");
  assert.equal(entryBadge(role("a", "林夕")), null);
  assert.equal(entrySubtitle(role("x", "夏澄", { bio: "预置的办事助手" })), "预置的办事助手");
  assert.equal(entrySubtitle(role("b", "周野")), "还没有写下介绍");
  assert.equal(entrySubtitle(role("c", "未就绪", { status: "initializing" })), "尚未就绪");
});

test("冷启动先停在选角页，进入后不再拦路", async () => {
  const { needsEntryPick, resolveEntryChoice, defaultEntryChoice } = await roleEntry;
  const roles = [role("a", "林夕"), role("x", "夏澄", { isBuiltin: true })];
  assert.equal(needsEntryPick({ loading: true, roles: undefined, entered: false }), true);
  assert.equal(needsEntryPick({ loading: false, roles, entered: false }), true);
  assert.equal(needsEntryPick({ loading: false, roles, entered: true }), false);
  assert.equal(needsEntryPick({ loading: false, roles: [], entered: false }), false);
  assert.equal(defaultEntryChoice(roles), "x");
  assert.equal(resolveEntryChoice(roles, "a"), "a");
  assert.equal(resolveEntryChoice(roles, "gone"), "x");
});

test("取消任务只挑用户委托且仍可取消的那一条", async () => {
  const { pickCancelableTask } = await taskActions;
  const tasks = [
    { taskId: "done", status: "completed", origin: "user", goal: "已完成" },
    { taskId: "auto", status: "active", origin: "autonomous", goal: "自主活动" },
    { taskId: "old", status: "paused", origin: "user", continuable: true, goal: "等待澄清", updatedAt: "2026-11-17T10:00:00.000Z" },
    { taskId: "live", status: "active", origin: "user", goal: "整理资料", updatedAt: "2026-11-17T09:00:00.000Z" },
  ];
  assert.equal(pickCancelableTask(tasks).taskId, "live");
  assert.equal(pickCancelableTask([tasks[0]]), null);
  assert.equal(pickCancelableTask([]), null);
  // 已标记不可续行的暂停任务不再出现在入口里。
  assert.equal(pickCancelableTask([{ ...tasks[2], continuable: false }]), null);
  // 同为暂停时取最近更新的那条。
  assert.equal(pickCancelableTask([
    { ...tasks[2], taskId: "p1", updatedAt: "2026-11-17T08:00:00.000Z" },
    { ...tasks[2], taskId: "p2", updatedAt: "2026-11-17T09:00:00.000Z" },
  ]).taskId, "p2");
});

test("取消入口的文案区分办理中与等待答复", async () => {
  const { taskCancelLabel, taskCancelNotice, taskCancelTitle } = await taskActions;
  const live = { taskId: "live", status: "active", goal: "整理这三份资料", origin: "user" };
  const paused = { taskId: "wait", status: "paused", goal: "等你确认目标", origin: "user" };
  assert.equal(taskCancelLabel(live), "取消任务");
  assert.equal(taskCancelLabel(paused), "取消等待中的任务");
  assert.match(taskCancelTitle(live), /正在办理：整理这三份资料/);
  assert.match(taskCancelNotice(paused), /不会自动接回/);
  assert.match(taskCancelNotice(live), /进度仍留在本机/);
  assert.equal(taskCancelLabel(null), "");
});

test("预置服饰只读、自添服饰开放，预置素材的差分不可删", async () => {
  const { outfitWritePolicy, assetLocked } = await presetLock;
  assert.deepEqual(outfitWritePolicy({ isPreset: true }), { rename: false, replaceHome: false, remove: false, uploadSprite: false });
  assert.deepEqual(outfitWritePolicy({ isPreset: false }), { rename: true, replaceHome: true, remove: true, uploadSprite: true });
  assert.deepEqual(outfitWritePolicy(null), { rename: false, replaceHome: false, remove: false, uploadSprite: false });
  assert.equal(assetLocked({ isPreset: true }), true);
  assert.equal(assetLocked({ isPreset: false }), false);
  assert.equal(assetLocked(undefined), false);
});
