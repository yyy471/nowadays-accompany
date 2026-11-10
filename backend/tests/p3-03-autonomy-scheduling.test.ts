import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listen } from "../src/bootstrap/app.js";
import type {
  ModelEvent,
  ModelPort,
  ModelRequest,
} from "../src/domain/model.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixture,
  createFixtureWithModel,
  deferred,
  type Fixture,
} from "./p2-05-fixture.js";

const backendRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(backendRoot, "src", "cli.ts");

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await delay(20);
  }
  throw new Error("WAIT_TIMEOUT");
}

function runCli(
  baseUrl: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, "--base-url", baseUrl, ...args],
      { cwd: backendRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI 执行超时：${args.join(" ")}`));
    }, 15_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("a soon due wake starts without manual scheduling", { timeout: 20_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "到点自己整理好了。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const wakeAt = new Date(Date.now() + 300).toISOString();
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt,
      intent: "到点整理桌面",
    });
    await waitUntil(
      () =>
        fixture.app.services.autonomy
          .listActivities(fixture.roleId)
          .some((activity) => activity.status === "completed"),
      8_000,
    );
    const activity = fixture.app.services.autonomy.listActivities(
      fixture.roleId,
    )[0];
    assert.equal(activity?.wakeId, wake.wakeId);
    assert.equal(activity?.summary, "到点自己整理好了。");
    assert.equal(
      fixture.app.services.autonomy
        .listWakes(fixture.roleId)
        .find((item) => item.wakeId === wake.wakeId)?.status,
      "completed",
    );
  } finally {
    await fixture.close();
  }
});

class SupersedeModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  readonly started = deferred<void>();
  readonly release = deferred<void>();

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "text_delta", text: "我先看看书架。" };
      this.started.resolve();
      await this.release.promise;
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    if (this.requests.length === 2) {
      assert.match(request.system, /本轮用户已发送的消息/);
      yield { type: "text_delta", text: "先回你：我在。" };
      yield { type: "completed", stopReason: "stop" };
      return;
    }
    assert.match(request.system, /当前执行在继续原任务/);
    yield { type: "text_delta", text: "接着把书架整理完了。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("disabling a skill excludes it from the next autonomous task chain", { timeout: 60_000 }, async () => {
  const skillRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "nowadays-p3-schedule-skill-"),
  );
  fs.mkdirSync(path.join(skillRoot, "journal"), { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, "journal", "SKILL.md"),
    [
      "---",
      "name: journal",
      "description: 写活动记录",
      "---",
      "",
      "按时间顺序记录。",
      "",
    ].join("\n"),
    "utf8",
  );
  const model = new ScriptedChatModel([
    (request): ModelEvent[] => {
      assert.ok(request.tools.some((tool) => tool.name === "skill_read"));
      return [
        {
          type: "tool_call",
          callId: "wire-skill",
          name: "skill_read",
          arguments: { skill: "journal" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (): ModelEvent[] => [
      { type: "text_delta", text: "用 Skill 完成了第一次记录。" },
      { type: "completed", stopReason: "stop" },
    ],
    (request): ModelEvent[] => {
      assert.ok(
        !request.tools.some((tool) => tool.name === "skill_read"),
        "关闭后的 Skill 不应出现在新的自主任务链",
      );
      return [
        { type: "text_delta", text: "没有可用 Skill，先记下想法。" },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  const fixture = createFixtureWithModel(model);
  try {
    const skill = fixture.app.services.resources.create({
      kind: "skill",
      name: "journal",
      config: { sourcePath: skillRoot },
    });
    addBinding(fixture, "skill", skill.resourceId);
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(Date.now() + 100).toISOString(),
      intent: "用 Skill 记录活动",
    });
    await waitUntil(
      () =>
        fixture.app.services.autonomy
          .listActivities(fixture.roleId)
          .some((activity) => activity.status === "completed"),
      15_000,
    );
    fixture.app.services.resources.update(skill.resourceId, {
      enabled: false,
    });
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(Date.now() + 100).toISOString(),
      intent: "再做一次记录",
    });
    await waitUntil(
      () =>
        fixture.app.services.autonomy
          .listActivities(fixture.roleId)
          .filter((activity) => activity.status === "completed").length === 2,
      15_000,
    );
    const activities = fixture.app.services.autonomy.listActivities(
      fixture.roleId,
    );
    assert.deepEqual(
      activities.map((activity) => activity.summary),
      ["没有可用 Skill，先记下想法。", "用 Skill 完成了第一次记录。"],
    );
  } finally {
    await fixture.close();
    fs.rmSync(skillRoot, { recursive: true, force: true });
  }
});

test("a user message supersedes autonomy first and the autonomous task continues afterwards", { timeout: 20_000 }, async () => {
  const model = new SupersedeModel();
  const fixture = createFixtureWithModel(model);
  try {
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(Date.now() + 100).toISOString(),
      intent: "整理书架",
    });
    await model.started.promise;
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "你在吗？",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await waitUntil(
      () =>
        fixture.app.services.messages
          .list(fixture.roleId, fixture.windowId, 0, 100)
          .items.some(
            (message) =>
              message.sender === "assistant" &&
              message.content === "先回你：我在。",
          ),
      5_000,
    );
    model.release.resolve();
    await fixture.app.conversation.waitForIdle(fixture.roleId, 10_000);

    assert.equal(model.requests.length, 3);
    const tasks = fixture.app.conversation.listTasks(fixture.roleId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.origin, "autonomous");
    assert.equal(tasks[0]?.status, "completed");
    const activity = fixture.app.services.autonomy.listActivities(
      fixture.roleId,
    )[0];
    assert.equal(activity?.status, "completed");
    assert.equal(activity?.summary, "接着把书架整理完了。");
    assert.equal(
      fixture.app.services.autonomy
        .listWakes(fixture.roleId)
        .find((wake) => wake.wakeId === activity?.wakeId)?.status,
      "completed",
    );
    const mainMessages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      100,
    ).items;
    assert.deepEqual(
      mainMessages.map((message) => message.content),
      ["你在吗？", "先回你：我在。"],
    );
  } finally {
    await fixture.close();
  }
});

test("autonomy records and cancellation are isolated per role", { timeout: 20_000 }, async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const other = fixture.app.services.roles.createRole({
      displayName: "另一个角色",
      definition: { text: "你是一个独立角色。" },
    });
    const wake = fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(Date.now() + 60_000).toISOString(),
      intent: "只有自己可见的安排",
    });
    assert.equal(
      fixture.app.services.autonomy.listWakes(other.roleId).length,
      0,
    );
    assert.throws(
      () => fixture.app.services.autonomy.cancelWake(other.roleId, wake.wakeId),
      (error: unknown) =>
        (error as { code?: string }).code === "AUTONOMY_WAKE_NOT_FOUND",
    );
    const otherBudget = fixture.app.services.autonomy.getBudget(other.roleId);
    assert.equal(otherBudget.usedPoints, 0);
    assert.equal(
      fixture.app.services.autonomy.listWakes(fixture.roleId).length,
      1,
    );
  } finally {
    await fixture.close();
  }
});

test("HTTP and CLI expose autonomy budget, wakes and activities", { timeout: 25_000 }, async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const roleBase = `${baseUrl}/v1/roles/${fixture.roleId}`;

    const initial = await fetch(`${roleBase}/autonomy`);
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as {
      budget: { dailyLimit: number; unlimited: boolean; usedPoints: number };
      nextWake: unknown;
      activities: unknown[];
    };
    assert.equal(initialBody.budget.dailyLimit, 200);
    assert.equal(initialBody.budget.unlimited, false);
    assert.equal(initialBody.budget.usedPoints, 0);
    assert.equal(initialBody.nextWake, null);
    assert.deepEqual(initialBody.activities, []);

    const updated = await fetch(`${roleBase}/autonomy/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dailyLimit: 12, unlimited: false }),
    });
    assert.equal(updated.status, 200);
    assert.equal(
      ((await updated.json()) as { dailyLimit: number }).dailyLimit,
      12,
    );

    const unlimited = await fetch(`${roleBase}/autonomy/budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unlimited: true }),
    });
    assert.equal(unlimited.status, 200);
    const unlimitedBody = (await unlimited.json()) as {
      dailyLimit: number;
      unlimited: boolean;
    };
    assert.equal(unlimitedBody.dailyLimit, 12);
    assert.equal(unlimitedBody.unlimited, true);

    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    const created = await fetch(`${roleBase}/autonomy/wakes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wakeAt, intent: "稍后整理书桌" }),
    });
    assert.equal(created.status, 201);
    const wake = (await created.json()) as {
      wakeId: string;
      status: string;
      scheduledAt: string;
    };
    assert.equal(wake.status, "pending");
    assert.equal(wake.scheduledAt, wakeAt);

    const listed = await fetch(`${roleBase}/autonomy/wakes`);
    assert.equal(listed.status, 200);
    assert.equal(
      ((await listed.json()) as { items: unknown[] }).items.length,
      1,
    );
    const activities = await fetch(`${roleBase}/autonomy/activities`);
    assert.equal(activities.status, 200);
    assert.deepEqual(
      ((await activities.json()) as { items: unknown[] }).items,
      [],
    );

    const cancelled = await fetch(
      `${roleBase}/autonomy/wakes/${wake.wakeId}`,
      { method: "DELETE" },
    );
    assert.equal(cancelled.status, 200);
    assert.equal(
      ((await cancelled.json()) as { status: string }).status,
      "cancelled",
    );

    const cliBudget = await runCli(baseUrl, [
      "autonomy",
      "budget",
      "set",
      "--role",
      fixture.roleId,
      "--limit",
      "30",
      "--unlimited",
      "false",
    ]);
    assert.equal(cliBudget.status, 0, cliBudget.stderr);
    assert.equal(
      (JSON.parse(cliBudget.stdout) as { dailyLimit: number }).dailyLimit,
      30,
    );
    const cliStatus = await runCli(baseUrl, [
      "autonomy",
      "status",
      "--role",
      fixture.roleId,
    ]);
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    assert.equal(
      (JSON.parse(cliStatus.stdout) as { budget: { dailyLimit: number } })
        .budget.dailyLimit,
      30,
    );
    const cliWake = await runCli(baseUrl, [
      "autonomy",
      "wake",
      "add",
      "--role",
      fixture.roleId,
      "--at",
      new Date(Date.now() + 120_000).toISOString(),
      "--intent",
      "CLI 安排",
    ]);
    assert.equal(cliWake.status, 0, cliWake.stderr);
    const cliWakeId = (JSON.parse(cliWake.stdout) as { wakeId: string })
      .wakeId;
    const cliList = await runCli(baseUrl, [
      "autonomy",
      "wake",
      "list",
      "--role",
      fixture.roleId,
    ]);
    assert.equal(cliList.status, 0, cliList.stderr);
    assert.ok(
      (JSON.parse(cliList.stdout) as { items: Array<{ wakeId: string }> }).items
        .some((item) => item.wakeId === cliWakeId),
    );
    const cliCancel = await runCli(baseUrl, [
      "autonomy",
      "wake",
      "cancel",
      "--role",
      fixture.roleId,
      "--wake",
      cliWakeId,
    ]);
    assert.equal(cliCancel.status, 0, cliCancel.stderr);
    assert.equal(
      (JSON.parse(cliCancel.stdout) as { status: string }).status,
      "cancelled",
    );
    const cliActivities = await runCli(baseUrl, [
      "autonomy",
      "activity",
      "list",
      "--role",
      fixture.roleId,
    ]);
    assert.equal(cliActivities.status, 0, cliActivities.stderr);
    assert.deepEqual(
      (JSON.parse(cliActivities.stdout) as { items: unknown[] }).items,
      [],
    );
  } finally {
    await fixture.close();
  }
});
