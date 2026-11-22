import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ModelRequestFailedError } from "../src/domain/errors.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import { createFixtureWithModel, withStorage } from "./p2-05-fixture.js";

class FailingThenRecoveringModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "text_delta", text: "先说一半" };
      throw new ModelRequestFailedError("上游模型暂时不可用");
    }
    yield { type: "text_delta", text: "这次成功回复。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

function submit(
  fixture: ReturnType<typeof createFixtureWithModel>,
  content: string,
): string {
  const submissionId = randomUUID();
  fixture.app.conversation.submitMessage(
    fixture.roleId,
    fixture.windowId,
    { content, submissionId, sourcePlatform: "nowadays" },
  );
  return submissionId;
}

class LoopingToolModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private call = 0;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.call += 1;
    yield {
      type: "tool_call",
      callId: `wire-loop-${this.call}`,
      name: "state_update",
      arguments: { patch: { mood: `第${this.call}次` } },
    };
    yield { type: "completed", stopReason: "tool_calls" };
  }
}

class IncompleteThenSuccessModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly stopReason: string,
    private readonly withTool: boolean,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      yield { type: "text_delta", text: "尚未完成的半句话" };
      if (this.withTool) {
        yield {
          type: "tool_call",
          callId: "wire-incomplete",
          name: "state_update",
          arguments: { patch: { mood: "开心" } },
        };
      }
      yield {
        type: "completed",
        stopReason: this.stopReason,
        incomplete: true,
      };
      return;
    }
    yield { type: "text_delta", text: "完整回复。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

function assertIncompleteNotCommitted(
  fixture: ReturnType<typeof createFixtureWithModel>,
  model: IncompleteThenSuccessModel,
): void {
  const detail = withStorage(fixture, (storage) => {
    const executions = storage.business.db
      .prepare(
        "SELECT execution_id, status, decision_round FROM executions WHERE role_id = ? ORDER BY rowid ASC",
      )
      .all(fixture.roleId) as Array<{
      execution_id: string;
      status: string;
      decision_round: number | null;
    }>;
    const events = storage.business.db
      .prepare(
        "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
      )
      .all(executions[0]?.execution_id ?? "") as Array<{
      event_type: string;
      payload_json: string;
    }>;
    const calls = storage.business.db
      .prepare(
        "SELECT status, error_code FROM model_calls WHERE execution_id = ? ORDER BY rowid ASC",
      )
      .all(executions[0]?.execution_id ?? "") as Array<{
      status: string;
      error_code: string | null;
    }>;
    const toolCalls = storage.business.db
      .prepare("SELECT COUNT(*) AS count FROM tool_calls")
      .get() as { count: number };
    return { executions, events, calls, toolCalls, role: storage.business.getRole(fixture.roleId) };
  });
  assert.deepEqual(detail.executions.map((row) => row.status), ["failed"]);
  assert.equal(detail.executions[0]?.decision_round, null);
  assert.deepEqual(
    detail.calls.map((row) => [row.status, row.error_code]),
    [["failed", "MODEL_REQUEST_FAILED"]],
  );
  assert.ok(
    detail.events.some((event) => event.event_type === "message_interrupted"),
  );
  const failure = detail.events.find(
    (event) => event.event_type === "execution_failed",
  );
  assert.ok(failure);
  assert.equal(
    (JSON.parse(failure.payload_json) as { errorCode?: string }).errorCode,
    "MODEL_REQUEST_FAILED",
  );
  assert.equal(detail.toolCalls.count, 0);
  assert.deepEqual(detail.role.state, { mood: "平静" });

  const messages = fixture.app.services.messages.list(
    fixture.roleId,
    fixture.windowId,
    0,
    20,
  );
  assert.deepEqual(
    messages.items.map((message) => [
      message.sender,
      message.status,
      message.content,
    ]),
    [
      ["user", "received", "不完整的请求"],
      ["assistant", "interrupted", "尚未完成的半句话"],
    ],
  );
  assert.equal(model.requests.length, 1);
}

for (const stopReason of ["length", "max_tokens", "response.incomplete"]) {
  test(`explicitly incomplete completion ${stopReason} is not committed as a reply`, { timeout: 15_000 }, async () => {
    const model = new IncompleteThenSuccessModel(stopReason, false);
    const fixture = createFixtureWithModel(model);
    try {
      submit(fixture, "不完整的请求");
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      assertIncompleteNotCommitted(fixture, model);

      submit(fixture, "再试一次");
      await fixture.app.conversation.waitForIdle(fixture.roleId);
      assert.equal(model.requests.length, 2);
      assert.deepEqual(
        model.requests[1]?.messages.map((message) => [
          message.role,
          message.content,
        ]),
        [
          ["user", "不完整的请求"],
          ["assistant", "尚未完成的半句话\n[以上回复中断，未完成]"],
          ["user", "再试一次"],
        ],
      );
      const executions = withStorage(fixture, (storage) =>
        storage.business.db
          .prepare(
            "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
          )
          .all(fixture.roleId) as Array<{ status: string }>,
      );
      assert.deepEqual(executions.map((row) => row.status), [
        "failed",
        "completed",
      ]);
    } finally {
      await fixture.close();
    }
  });
}

test("an incomplete response carrying a tool request never dispatches the tool", { timeout: 15_000 }, async () => {
  const model = new IncompleteThenSuccessModel("length", true);
  const fixture = createFixtureWithModel(model);
  try {
    submit(fixture, "不完整的请求");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assertIncompleteNotCommitted(fixture, model);
    assert.equal(model.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("model tool loop stops at the configured round limit without committing state", { timeout: 15_000 }, async () => {
  const model = new LoopingToolModel();
  const fixture = createFixtureWithModel(model, { maxToolRounds: 2 });
  try {
    submit(fixture, "一直调用工具");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 2);
    const failed = withStorage(fixture, (storage) => {
      const execution = storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(fixture.roleId) as { status: string };
      const events = storage.business.db
        .prepare(
          "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
        )
        .all(
          (
            storage.business.db
              .prepare(
                "SELECT execution_id FROM executions WHERE role_id = ? ORDER BY rowid DESC LIMIT 1",
              )
              .get(fixture.roleId) as { execution_id: string }
          ).execution_id,
        ) as Array<{ event_type: string; payload_json: string }>;
      const role = storage.business.getRole(fixture.roleId);
      return { execution, events, role };
    });
    assert.equal(failed.execution.status, "failed");
    assert.deepEqual(failed.role.state, { mood: "平静" });
    const failure = failed.events.find(
      (event) => event.event_type === "execution_failed",
    );
    assert.ok(failure);
    assert.equal(
      (JSON.parse(failure.payload_json) as { errorCode?: string }).errorCode,
      "TOOL_ROUND_LIMIT",
    );
  } finally {
    await fixture.close();
  }
});

test("model failure keeps partial text, does not auto retry, and a new message retries", { timeout: 15_000 }, async () => {
  const model = new FailingThenRecoveringModel();
  const fixture = createFixtureWithModel(model);
  try {
    submit(fixture, "会失败的请求");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    const failed = withStorage(fixture, (storage) => {
      const executions = storage.business.db
        .prepare(
          "SELECT execution_id, status, decision_round FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{
        execution_id: string;
        status: string;
        decision_round: number | null;
      }>;
      const events = storage.business.db
        .prepare(
          "SELECT event_type, payload_json FROM execution_stream_events WHERE execution_id = ? ORDER BY stream_event_id ASC",
        )
        .all(executions[0]?.execution_id ?? "") as Array<{
        event_type: string;
        payload_json: string;
      }>;
      const calls = storage.business.db
        .prepare(
          "SELECT status, error_code FROM model_calls WHERE execution_id = ? ORDER BY rowid ASC",
        )
        .all(executions[0]?.execution_id ?? "") as Array<{
        status: string;
        error_code: string | null;
      }>;
      return { executions, events, calls };
    });

    assert.deepEqual(failed.executions.map((row) => row.status), ["failed"]);
    assert.equal(failed.executions[0]?.decision_round, null);
    assert.deepEqual(
      failed.calls.map((row) => [row.status, row.error_code]),
      [["failed", "MODEL_REQUEST_FAILED"]],
    );
    assert.ok(
      failed.events.some((event) => event.event_type === "message_interrupted"),
    );
    const failure = failed.events.find(
      (event) => event.event_type === "execution_failed",
    );
    assert.ok(failure);
    assert.equal(
      (JSON.parse(failure.payload_json) as { errorCode?: string }).errorCode,
      "MODEL_REQUEST_FAILED",
    );

    const afterFailure = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.deepEqual(
      afterFailure.items.map((message) => [
        message.sender,
        message.status,
        message.content,
      ]),
      [
        ["user", "received", "会失败的请求"],
        ["assistant", "interrupted", "先说一半"],
      ],
    );
    assert.equal(model.requests.length, 1);

    submit(fixture, "再试一次");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 2);
    assert.deepEqual(
      model.requests[1]?.messages.map((message) => [message.role, message.content]),
      [
        ["user", "会失败的请求"],
        ["assistant", "先说一半\n[以上回复中断，未完成]"],
        ["user", "再试一次"],
      ],
    );

    const afterRetry = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.deepEqual(
      afterRetry.items.map((message) => [message.sender, message.status, message.content]),
      [
        ["user", "received", "会失败的请求"],
        ["assistant", "interrupted", "先说一半"],
        ["user", "received", "再试一次"],
        ["assistant", "completed", "这次成功回复。"],
      ],
    );
    const executions = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare(
          "SELECT status FROM executions WHERE role_id = ? ORDER BY rowid ASC",
        )
        .all(fixture.roleId) as Array<{ status: string }>,
    );
    assert.deepEqual(executions.map((row) => row.status), ["failed", "completed"]);
  } finally {
    await fixture.close();
  }
});
