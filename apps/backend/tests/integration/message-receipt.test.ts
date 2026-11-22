import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { listen } from "../../src/bootstrap/app.js";
import { createFixture, createFixtureWithModel, deferred, type Fixture } from "../fixtures/conversation-fixture.js";
import type { ModelEvent } from "../../src/domain/model.js";

interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

async function start(fixture: Fixture): Promise<string> {
  const port = await listen(fixture.app.server, 0, "127.0.0.1");
  return `http://127.0.0.1:${port}`;
}

async function api(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<ApiResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
  };
}

function errorCode(result: ApiResult): string {
  return (result.body.error as { code?: string } | undefined)?.code ?? "";
}

test("失败可按原消息恢复，保留已展示的半句，过期及跨窗口点击不会重复调度", { timeout: 30_000 }, async () => {
  const release = deferred<void>();
  let calls = 0;
  const fixture = createFixtureWithModel({
    async *stream(): AsyncIterable<ModelEvent> {
      if (++calls === 1) {
        yield { type: "text_delta", text: "我已经看到书签了。" };
        throw Error("offline interruption");
      }
      await release.promise;
      yield { type: "text_delta", text: "在扉页，我找到了。" };
      yield { type: "completed", stopReason: "stop" };
    },
  });
  try {
    const { roleId, windowId } = fixture;
    const base = await start(fixture);
    const windows = `/v1/roles/${roleId}/windows`;
    const route = `${windows}/${windowId}/messages`;
    const submissionId = randomUUID();
    const received = await submit(base, roleId, windowId, { content: "书签还在吗？", submissionId });
    const messageId = (received.body.message as { messageId: string }).messageId;
    await fixture.app.conversation.waitForIdle(roleId);
    const page = (await api(base, "GET", route)).body;
    const failed = page.failedReply as { executionId: string; messageId: string; errorCode: string };
    assert.equal(failed.messageId, messageId);
    assert.ok(failed.errorCode);
    assert.ok((page.items as {content: string; status: string}[]).some(m => m.status === "interrupted" && m.content === "我已经看到书签了。"));
    const retry = route + "/" + messageId + "/retry";
    const other = fixture.app.services.roles.createWindow(roleId, { kind: "custom", source: "nowadays" });
    assert.equal(errorCode(await api(base, "POST", `${windows}/${other.windowId}/messages/${messageId}/retry`, { executionId: failed.executionId })), "MESSAGE_NOT_FOUND");
    assert.equal(errorCode(await api(base, "POST", retry, { executionId: randomUUID() })), "REPLY_RETRY_STALE");
    const result = await api(base, "POST", retry, { executionId: failed.executionId });
    assert.equal(result.status, 200);
    assert.equal((result.body.message as { submissionId: string }).submissionId, submissionId);
    const running = (await api(base, "GET", route)).body;
    assert.equal(running.failedReply, null);
    assert.equal((running.awaitingReply as {messageId: string}).messageId, messageId);
    assert.equal(errorCode(await api(base, "POST", retry, { executionId: failed.executionId })), "REPLY_RETRY_STALE");
    release.resolve();
    await fixture.app.conversation.waitForIdle(roleId);
    const done = (await api(base, "GET", route)).body;
    assert.equal(done.failedReply, null);
    assert.equal(done.awaitingReply, null);
    const messages = done.items as { sender: string; status: string }[];
    assert.equal(messages.filter(m => m.sender === "user").length, 1);
    assert.deepEqual(messages.filter(m => m.sender === "assistant").map(m => m.status), ["interrupted", "completed"]);
    assert.equal(errorCode(await api(base, "POST", retry, { executionId: failed.executionId })), "REPLY_RETRY_STALE");
    assert.equal(calls, 2);
  } finally { release.resolve(); await fixture.close(); }
});

async function submit(
  base: string,
  roleId: string,
  windowId: string,
  input: { content: string; submissionId: string },
): Promise<ApiResult> {
  return api(
    base,
    "POST",
    `/v1/roles/${roleId}/windows/${windowId}/messages`,
    { content: input.content, submissionId: input.submissionId },
  );
}

test("缺少对话模型时消息已接收并返回 MODEL_MISSING", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const role = `/v1/roles/${fixture.roleId}`;
    assert.equal((await api(base, "POST", `${role}/activity/stop`)).status, 200);
    assert.equal(
      (
        await api(base, "PUT", `${role}/bindings`, {
          bindings: [],
        })
      ).status,
      200,
    );
    assert.equal((await api(base, "POST", `${role}/activity/resume`)).status, 200);

    const result = await submit(base, fixture.roleId, fixture.windowId, {
      content: "在吗？",
      submissionId: randomUUID(),
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.decisionScheduled, false);
    assert.equal(result.body.waitReason, "MODEL_MISSING");
    assert.equal(
      (result.body.message as { content: string }).content,
      "在吗？",
    );
  } finally {
    await fixture.close();
  }
});

test("角色停止后可用原提交标识找回已接收消息，新消息仍被拒绝", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const role = `/v1/roles/${fixture.roleId}`;
    const submissionId = randomUUID();
    const submitted = await submit(base, fixture.roleId, fixture.windowId, {
      content: "先记下这句",
      submissionId,
    });
    assert.equal(submitted.status, 201);
    const messageId = (submitted.body.message as { messageId: string })
      .messageId;

    assert.equal((await api(base, "POST", `${role}/activity/stop`)).status, 200);

    // 同标识同内容：返回原消息，同时给出角色已停止的等待原因。
    const replay = await submit(base, fixture.roleId, fixture.windowId, {
      content: "先记下这句",
      submissionId,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.waitReason, "ROLE_STOPPED");
    assert.equal(
      (replay.body.message as { messageId: string }).messageId,
      messageId,
    );

    // 同标识改内容：冲突；新标识：角色未活动，直接拒绝。
    const conflict = await submit(base, fixture.roleId, fixture.windowId, {
      content: "换了内容",
      submissionId,
    });
    assert.equal(conflict.status, 409);
    const blocked = await submit(base, fixture.roleId, fixture.windowId, {
      content: "新消息",
      submissionId: randomUUID(),
    });
    assert.equal(blocked.status, 409);
    assert.equal(errorCode(blocked), "ROLE_ACTIVITY_STOPPED");
  } finally {
    await fixture.close();
  }
});

test("正常排队与调度成功分别返回可读状态", { timeout: 20_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const base = await start(fixture);
    const result = await submit(base, fixture.roleId, fixture.windowId, {
      content: "你好",
      submissionId: randomUUID(),
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.decisionScheduled, true);
    assert.equal(result.body.waitReason, null);
    await fixture.app.conversation.waitForIdle(fixture.roleId);
  } finally {
    await fixture.close();
  }
});
