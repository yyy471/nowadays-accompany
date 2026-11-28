import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { listen } from "../../src/bootstrap/app.js";
import { createFixture } from "../fixtures/conversation-fixture.js";

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

function collectFrames(response: Response): { frames: string[]; pump: Promise<void> } {
  const frames: string[] = [];
  let pump: Promise<void>;
  pump = (async () => {
    assert.ok(response.body, "响应缺少事件流主体");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          frames.push(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // 客户端主动断开。
    } finally {
      try { reader.releaseLock(); } catch { /* 读取已随连接结束。 */ }
    }
  })();
  return { frames, pump };
}

function dataOf(frame: string): string {
  return (frame.split("\n").find(line => line.startsWith("data: ")) ?? "").slice("data: ".length);
}

test("工程事件流隔离抛错订阅者，客户端断开后清理订阅", async t => {
  const fixture = createFixture([]);
  const pi = fixture.app.services.pi;
  const stopThrowing = pi.subscribe(() => { throw new Error("BROKEN_ENGINEERING_LISTENER"); });
  let routeUnsubscribed = 0;
  const subscribe = pi.subscribe.bind(pi);
  t.mock.method(pi, "subscribe", (listener: () => void) => {
    const unsubscribe = subscribe(listener);
    return () => { routeUnsubscribed += 1; unsubscribe(); };
  });
  const controller = new AbortController();
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/v1/engineering/events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const collector = collectFrames(response);
    const snapshots = () => collector.frames.filter(frame => frame.includes("event: snapshot"));
    await until(() => snapshots().length >= 1, "未收到工程快照");
    assert.deepEqual(JSON.parse(dataOf(snapshots()[0]!)), []);

    // 第一个订阅者抛错后，路由订阅者仍应收到通知。
    (pi as unknown as { notify: () => void }).notify();
    await until(() => snapshots().length >= 2, "抛错订阅者阻断了后续工程推送");

    controller.abort();
    await until(() => routeUnsubscribed === 1, "客户端断开后未清理工程事件订阅");
    await collector.pump;
  } finally {
    controller.abort();
    stopThrowing();
    await fixture.close();
  }
});

test("扩展事件流断开后清理 UI 订阅", async t => {
  const fixture = createFixture([]);
  const extensions = fixture.app.services.extensions;
  let unsubscribed = 0;
  const subscribeUi = extensions.subscribeUi.bind(extensions);
  t.mock.method(extensions, "subscribeUi", (listener: Parameters<typeof subscribeUi>[0]) => {
    const unsubscribe = subscribeUi(listener);
    return () => { unsubscribed += 1; unsubscribe(); };
  });
  const controller = new AbortController();
  try {
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const response = await fetch(`http://127.0.0.1:${port}/v1/extension-events`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const collector = collectFrames(response);
    await until(
      () => collector.frames.some(frame => frame.includes("event: snapshot")),
      "未收到扩展快照",
    );

    controller.abort();
    await until(() => unsubscribed === 1, "客户端断开后未清理扩展事件订阅");
    await collector.pump;
  } finally {
    controller.abort();
    await fixture.close();
  }
});
