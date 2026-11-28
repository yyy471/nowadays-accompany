import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startSse } from "../../src/http/sse.js";

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  readonly writes: string[] = [];
  onWrite: (frame: string) => boolean = () => true;

  write(frame: string): boolean {
    this.writes.push(frame);
    return this.onWrite(frame);
  }

  destroy(): void {
    this.destroyed = true;
  }

  asResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

test("SSE 写入返回 false 只表示背压，不解除订阅", () => {
  const response = new FakeResponse();
  response.onWrite = () => false;
  const sse = startSse(response.asResponse(), 0);
  let cleanups = 0;
  sse.disposeWith(() => { cleanups += 1; });
  try {
    assert.equal(sse.write("data: a\n\n"), false);
    assert.equal(sse.write("data: b\n\n"), false);
    assert.equal(cleanups, 0);
    assert.equal(sse.closed, false);
    assert.equal(response.destroyed, false);
    assert.deepEqual(response.writes, ["data: a\n\n", "data: b\n\n"]);
  } finally { sse.dispose(); }
  assert.equal(cleanups, 1);
});

test("SSE 写入抛错时自动退订并停止心跳", async () => {
  const response = new FakeResponse();
  response.onWrite = () => { throw new Error("WRITE_FAILED"); };
  const sse = startSse(response.asResponse(), 5);
  let cleanups = 0;
  sse.disposeWith(() => { cleanups += 1; });

  assert.equal(sse.write("event: snapshot\ndata: {}\n\n"), false);
  assert.equal(sse.closed, true);
  assert.equal(response.destroyed, true);
  assert.equal(cleanups, 1);
  const written = response.writes.length;
  await delay(30);
  assert.equal(response.writes.length, written);
});

test("响应已关闭时写入不抛错且立即清理", () => {
  const response = new FakeResponse();
  response.destroyed = true;
  const sse = startSse(response.asResponse(), 5);
  let cleanups = 0;

  assert.equal(sse.closed, true);
  assert.equal(sse.write(": heartbeat\n\n"), false);
  sse.disposeWith(() => { cleanups += 1; });
  assert.equal(cleanups, 1);
  assert.deepEqual(response.writes, []);
});

test("close/finish/error 共用一次性清理并停止心跳", async () => {
  const response = new FakeResponse();
  const sse = startSse(response.asResponse(), 15);
  let cleanups = 0;
  sse.disposeWith(() => { cleanups += 1; });
  try {
    await delay(40);
    assert.ok(response.writes.includes(": heartbeat\n\n"));
    response.emit("error", new Error("RESPONSE_ERROR"));
    response.emit("close");
    response.emit("finish");
    assert.equal(cleanups, 1);
    assert.equal(sse.closed, true);
    const written = response.writes.length;
    await delay(40);
    assert.equal(response.writes.length, written);
  } finally { sse.dispose(); }
  assert.equal(cleanups, 1);
});

test("背压期间跳过心跳，恢复后继续发送", async () => {
  const response = new FakeResponse();
  response.writableNeedDrain = true;
  const sse = startSse(response.asResponse(), 15);
  try {
    await delay(60);
    assert.equal(response.writes.length, 0);
    response.writableNeedDrain = false;
    await delay(60);
    assert.ok(response.writes.includes(": heartbeat\n\n"));
  } finally { sse.dispose(); }
});

test("订阅登记时响应已关闭会立即退订", () => {
  const response = new FakeResponse();
  const sse = startSse(response.asResponse(), 0);
  let cleanups = 0;
  response.destroyed = true;

  sse.disposeWith(() => { cleanups += 1; });
  assert.equal(cleanups, 1);
  assert.equal(sse.closed, true);
});
