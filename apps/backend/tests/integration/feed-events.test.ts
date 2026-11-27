import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { listen } from "../../src/bootstrap/app.js";
import { createFixture } from "../fixtures/conversation-fixture.js";

interface ParsedEvent {
  event: string;
  data: string;
  id: string | null;
}

function parseEvent(block: string): ParsedEvent {
  let event = "message";
  let data = "";
  let id: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  return { event, data, id };
}

async function until(
  check: () => boolean,
  message: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(message);
}

/**
 * ARCH-02 R8b：状态流变更推送。只验证事件主题与订阅生命周期，
 * 不涉及具体业务快照内容。
 */
test("状态流实时推送角色活动与自主安排，断开后清理订阅", async () => {
  const fixture = createFixture([]);
  const controller = new AbortController();
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/v1/feed-events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body, "响应缺少事件流主体");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const received: ParsedEvent[] = [];
    let readError: unknown = null;
    let buffer = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            received.push(parseEvent(buffer.slice(0, boundary)));
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        readError = error;
      }
    })();

    const hasReady = () => received.some((item) => item.event === "ready");
    await until(
      () => hasReady() || readError !== null,
      "未收到 ready 事件",
    );
    if (!hasReady()) throw readError ?? new Error("事件流提前结束");
    const ready = received.find((item) => item.event === "ready")!;
    assert.deepEqual(JSON.parse(ready.data), {
      seq: fixture.app.services.feedEvents.currentSeq(),
    });

    const changes = (topic: string) =>
      received.filter((item) => {
        if (item.event !== "change") return false;
        return (JSON.parse(item.data) as { topic?: string }).topic === topic;
      });

    const roleId = fixture.roleId;
    const activityBeforeStop = changes("role_activity").length;
    fixture.app.services.activity.requestStop(roleId);
    await until(
      () => changes("role_activity").length > activityBeforeStop,
      "未收到停止活动的 role_activity 事件",
    );

    const activityBeforeResume = changes("role_activity").length;
    fixture.app.services.activity.resume(roleId);
    await until(
      () => changes("role_activity").length > activityBeforeResume,
      "未收到恢复活动的 role_activity 事件",
    );

    const wakeBeforeCreate = changes("wake").length;
    const wake = fixture.app.services.autonomy.scheduleWake(roleId, {
      wakeAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      intent: "状态流测试安排",
    });
    await until(
      () => changes("wake").length > wakeBeforeCreate,
      "未收到创建安排的 wake 事件",
    );

    const created = changes("wake").at(-1)!;
    const createdPayload = JSON.parse(created.data) as {
      seq: number;
      topic: string;
      roleId?: string;
    };
    assert.equal(createdPayload.topic, "wake");
    assert.equal(createdPayload.roleId, roleId);
    assert.equal(created.id, String(createdPayload.seq));

    const wakeBeforeCancel = changes("wake").length;
    fixture.app.services.autonomy.cancelWake(roleId, wake.wakeId);
    await until(
      () => changes("wake").length > wakeBeforeCancel,
      "未收到取消安排的 wake 事件",
    );

    // 客户端主动断开后服务端应清理订阅，避免长时间运行后的监听泄漏。
    assert.equal(fixture.app.services.feedEvents.listenerCount(), 1);
    controller.abort();
    await until(
      () => fixture.app.services.feedEvents.listenerCount() === 0,
      "客户端断开后仍残留状态流订阅",
    );
    await pump;
  } finally {
    controller.abort();
    await fixture.close();
  }
});
