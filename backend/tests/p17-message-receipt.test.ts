import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { listen } from "../src/bootstrap/app.js";
import { createFixture, type Fixture } from "./p2-05-fixture.js";

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
