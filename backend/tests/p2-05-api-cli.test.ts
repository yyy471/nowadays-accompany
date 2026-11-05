import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { listen } from "../src/bootstrap/app.js";
import { createFixture, withStorage } from "./p2-05-fixture.js";

const backendRoot = path.resolve(import.meta.dirname, "..");
const cliEntry = path.join(backendRoot, "src", "cli.ts");

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

function runCliUntil(
  baseUrl: string,
  args: readonly string[],
  marker: string,
): Promise<string> {
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
      reject(new Error(`CLI 事件流超时：${stderr}`));
    }, 15_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(marker)) {
        clearTimeout(timer);
        child.kill();
        resolve(stdout);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!stdout.includes(marker)) {
        reject(
          new Error(`CLI 事件流提前结束（code=${String(code)}）：${stderr}`),
        );
      }
    });
  });
}

test("HTTP and CLI expose input state, executions and task completion", { timeout: 20_000 }, async () => {
  const fixture = createFixture([
    [
      { type: "text_delta", text: "收到，我先把书架整理一下。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const baseUrl = `http://127.0.0.1:${port}`;
    const roleBase = `${baseUrl}/v1/roles/${fixture.roleId}`;

    const submitted = await fetch(
      `${roleBase}/windows/${fixture.windowId}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: "帮我整理书架",
          submissionId: randomUUID(),
        }),
      },
    );
    assert.equal(submitted.status, 201);
    const submittedBody = (await submitted.json()) as {
      decisionScheduled: boolean;
    };
    assert.equal(submittedBody.decisionScheduled, true);
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const executionId = withStorage(fixture, (storage) => {
      const row = storage.business.db
        .prepare(
          "SELECT execution_id FROM executions WHERE role_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(fixture.roleId) as { execution_id: string };
      return row.execution_id;
    });
    const detail = await fetch(`${roleBase}/executions/${executionId}`);
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      execution: { status: string; decisionRound: number | null };
      latestEvents: Array<{ type: string }>;
    };
    assert.equal(detailBody.execution.status, "completed");
    assert.equal(detailBody.execution.decisionRound, 1);
    assert.ok(
      detailBody.latestEvents.some((event) => event.type === "message_completed"),
    );

    const typing = await fetch(
      `${roleBase}/windows/${fixture.windowId}/input-state`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "client-http", typing: true }),
      },
    );
    assert.equal(typing.status, 200);
    const typingBody = (await typing.json()) as {
      state: { clientId: string; expiresAt: string } | null;
    };
    assert.equal(typingBody.state?.clientId, "client-http");
    const cleared = await fetch(
      `${roleBase}/windows/${fixture.windowId}/input-state?clientId=client-http`,
      { method: "DELETE" },
    );
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { cleared: true });
    const invalidTyping = await fetch(
      `${roleBase}/windows/${fixture.windowId}/input-state`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typing: true }),
      },
    );
    assert.equal(invalidTyping.status, 400);
    const invalidBody = (await invalidTyping.json()) as {
      error: { code: string };
    };
    assert.equal(invalidBody.error.code, "INPUT_STATE_INVALID");

    const task = withStorage(fixture, (storage) =>
      storage.business.createTask({
        roleId: fixture.roleId,
        goal: "整理书架",
      }),
    );
    const tasks = await fetch(`${roleBase}/tasks`);
    assert.equal(tasks.status, 200);
    const tasksBody = (await tasks.json()) as {
      items: Array<{ taskId: string; status: string }>;
    };
    assert.ok(tasksBody.items.some((item) => item.taskId === task.taskId));
    const finished = await fetch(`${roleBase}/tasks/${task.taskId}/finish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", endReason: "HTTP 完成" }),
    });
    assert.equal(finished.status, 200);
    const finishedBody = (await finished.json()) as {
      status: string;
      endReason: string;
    };
    assert.equal(finishedBody.status, "completed");
    assert.equal(finishedBody.endReason, "HTTP 完成");

    const cliTask = await runCli(baseUrl, [
      "task",
      "get",
      "--role",
      fixture.roleId,
      "--id",
      task.taskId,
    ]);
    assert.equal(cliTask.status, 0, cliTask.stderr);
    assert.equal(
      (JSON.parse(cliTask.stdout) as { status: string }).status,
      "completed",
    );
    const cliExecution = await runCli(baseUrl, [
      "execution",
      "get",
      "--role",
      fixture.roleId,
      "--id",
      executionId,
    ]);
    assert.equal(cliExecution.status, 0, cliExecution.stderr);
    assert.equal(
      (JSON.parse(cliExecution.stdout) as { execution: { status: string } })
        .execution.status,
      "completed",
    );

    const streamed = await runCliUntil(
      baseUrl,
      [
        "events",
        "--role",
        fixture.roleId,
        "--window",
        fixture.windowId,
        "--after",
        "0",
      ],
      "message_completed",
    );
    const streamTypes = streamed
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string })
      .map((event) => event.type);
    assert.ok(streamTypes.includes("execution_started"));
    assert.ok(streamTypes.includes("message_completed"));
  } finally {
    await fixture.close();
  }
});
