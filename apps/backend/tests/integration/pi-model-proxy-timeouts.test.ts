import assert from "node:assert/strict";
import http from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import { listen } from "../../src/bootstrap/app.js";
import { createFixtureWithModel, deferred, ScriptedChatModel } from "../fixtures/conversation-fixture.js";

const modelName = "fixture";

interface Upstream {
  baseUrl: string;
  close(): Promise<void>;
}

/** 记录活跃回环连接，便于超时/取消后观察上游是否及时断开。 */
async function startUpstream(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<Upstream> {
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    // 取消后仍可能有排队写入，避免响应错误事件冒泡到测试进程。
    response.on("error", () => undefined);
    handler(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const port = await listen(server, 0, "127.0.0.1");
  return {
    baseUrl: "http://127.0.0.1:" + port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("upstream did not close")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sseChunk(content: string): string {
  return 'data: {"choices":[{"delta":{"content":' + JSON.stringify(content) + "}}]}\n\n";
}

function sseDone(): string {
  return 'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n';
}

async function setup(baseUrl: string) {
  // 统一缩短三类边界，避免单测等待真实 90 秒默认值。
  const f = createFixtureWithModel(new ScriptedChatModel([]), {
    piModelProxyOptions: {
      streamHeaderTimeoutMs: 150,
      streamIdleTimeoutMs: 150,
      maxResponseBytes: 1024,
    },
  });
  const config = { protocol: "openai-chat" as const, baseUrl };
  const { resourceId } = f.app.services.resources.create({ kind: "model", name: "工程上游", config });
  const binding = { resourceId, modelName, config };
  const lease = (onFailure?: (code: string) => void) =>
    f.app.services.modelProxy.issue(f.roleId, binding, false, Date.now() + 30_000, undefined, onFailure);
  const host = "http://127.0.0.1:" + await listen(f.app.server, 0, "127.0.0.1");
  const post = (token: string, body: Record<string, unknown>, signal?: AbortSignal) =>
    fetch(host + "/v1/internal/model-proxy/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ model: modelName, ...body }),
      ...(signal === undefined ? {} : { signal }),
    });
  return { f, lease, post };
}

function piUsageRows(f: Awaited<ReturnType<typeof setup>>["f"]) {
  return f.app.appStore.db
    .prepare("SELECT status FROM token_usage_records WHERE source_call_id LIKE 'pi:%' ORDER BY rowid ASC")
    .all();
}

test("Pi 代理在响应头截止时间内中止静默上游，失败记账并释放 claim 与租约", async (t) => {
  let hang = true;
  const firstClosed = deferred<void>();
  let requests = 0;
  const upstream = await startUpstream((_request, response) => {
    requests += 1;
    if (hang) {
      response.once("close", () => firstClosed.resolve());
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(sseChunk("恢复") + sseDone());
  });
  const { f, lease, post } = await setup(upstream.baseUrl);
  const failureCodes: string[] = [];
  const failedLease = lease((code) => failureCodes.push(code));
  const healthyLease = lease();
  try {
    const reports = t.mock.method(f.app.services.engineeringPool, "reportFailure");
    const startedAt = Date.now();
    const failed = await post(failedLease, { stream: true });
    assert.equal(failed.status, 502);
    assert.match(await failed.text(), /PI_UPSTREAM_FAILED/);
    assert.ok(Date.now() - startedAt < 3_000, "header timeout should fire promptly");
    await waitForClose(firstClosed.promise, 2_000);
    assert.equal(reports.mock.callCount(), 1);
    assert.deepEqual(reports.mock.calls[0]!.arguments.slice(2), [null]);
    assert.deepEqual(failureCodes, ["PI_UPSTREAM_FAILED"]);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3_000), true);

    // 失败租约保留“已失败”语义，但不能继续派发；healthy 租约不受影响。
    const retried = await post(failedLease, {});
    assert.equal(retried.status, 409);
    assert.match(await retried.text(), /PI_UPSTREAM_FAILED/);

    hang = false;
    const healthy = await post(healthyLease, { stream: true });
    assert.equal(healthy.status, 200);
    assert.match(await healthy.text(), /\[DONE\]/);

    f.app.services.modelProxy.revoke(failedLease);
    const released = await post(failedLease, {});
    assert.equal(released.status, 403);
    assert.match(await released.text(), /PI_LEASE_REVOKED/);
    const stillHealthy = await post(healthyLease, { stream: true });
    assert.equal(stillHealthy.status, 200);
    assert.match(await stillHealthy.text(), /\[DONE\]/);
    f.app.services.modelProxy.revoke(healthyLease);
    assert.equal(requests, 3);
    assert.deepEqual(piUsageRows(f), [
      { status: "failed" },
      { status: "succeeded" },
      { status: "succeeded" },
    ]);
  } finally {
    f.app.services.modelProxy.revoke(failedLease);
    f.app.services.modelProxy.revoke(healthyLease);
    await f.close();
    await upstream.close();
  }
});

test("Pi 代理在 SSE 首包后按空闲上限中止上游并记录失败", async (t) => {
  const closed = deferred<void>();
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseChunk("部分"));
    response.once("close", () => closed.resolve());
    // 故意不发送后续分片或 [DONE]，模拟半开连接。
  });
  const { f, lease, post } = await setup(upstream.baseUrl);
  const token = lease();
  try {
    const reports = t.mock.method(f.app.services.engineeringPool, "reportFailure");
    const startedAt = Date.now();
    const response = await post(token, { stream: true });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /部分/);
    assert.ok(Date.now() - startedAt < 3_000, "idle timeout should fire promptly");
    await waitForClose(closed.promise, 2_000);
    assert.equal(reports.mock.callCount(), 1);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3_000), true);
    assert.deepEqual(piUsageRows(f), [{ status: "failed" }]);
  } finally {
    f.app.services.modelProxy.revoke(token);
    await f.close();
    await upstream.close();
  }
});

test("Pi 代理按 Content-Length 与增量字节拒绝非 SSE 超大响应", async (t) => {
  const closed = [deferred<void>(), deferred<void>()];
  let requests = 0;
  const upstream = await startUpstream((_request, response) => {
    const index = requests;
    requests += 1;
    response.once("close", () => closed[index]!.resolve());
    if (index === 0) {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "4096",
      });
      response.end(Buffer.alloc(4096, "a"));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.write(Buffer.alloc(2048, "b"));
    response.end(Buffer.alloc(2048, "c"));
  });
  const { f, lease, post } = await setup(upstream.baseUrl);
  const first = lease();
  const second = lease();
  try {
    const reports = t.mock.method(f.app.services.engineeringPool, "reportFailure");
    const declared = await post(first, {});
    assert.equal(declared.status, 502);
    assert.match(await declared.text(), /PI_UPSTREAM_FAILED/);
    await waitForClose(closed[0]!.promise, 2_000);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3_000), true);

    const chunked = await post(second, {});
    assert.equal(chunked.status, 502);
    assert.match(await chunked.text(), /PI_UPSTREAM_FAILED/);
    await waitForClose(closed[1]!.promise, 2_000);
    assert.equal(reports.mock.callCount(), 2);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3_000), true);
    assert.deepEqual(piUsageRows(f), [{ status: "failed" }, { status: "failed" }]);
  } finally {
    f.app.services.modelProxy.revoke(first);
    f.app.services.modelProxy.revoke(second);
    await f.close();
    await upstream.close();
  }
});

test("下游断开与撤约按取消处理，不触发源故障冷却", async (t) => {
  const closed = [deferred<void>(), deferred<void>()];
  let requests = 0;
  const upstream = await startUpstream((_request, response) => {
    const index = requests;
    requests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseChunk("持续"));
    const timer = setInterval(() => {
      try {
        response.write(": ping\n\n");
      } catch {
        // 连接已被取消。
      }
    }, 20);
    timer.unref?.();
    response.once("close", () => {
      clearInterval(timer);
      closed[index]!.resolve();
    });
  });
  const { f, lease, post } = await setup(upstream.baseUrl);
  const failureCodes: string[] = [];
  const first = lease((code) => failureCodes.push(code));
  const second = lease((code) => failureCodes.push(code));
  try {
    const reports = t.mock.method(f.app.services.engineeringPool, "reportFailure");
    const controller = new AbortController();
    const aborted = await post(first, { stream: true }, controller.signal);
    assert.equal(aborted.status, 200);
    controller.abort();
    await aborted.text().catch(() => undefined);
    await waitForClose(closed[0]!.promise, 3_000);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3_000), true);

    const revoked = await post(second, { stream: true });
    assert.equal(revoked.status, 200);
    f.app.services.modelProxy.revoke(second);
    await revoked.text().catch(() => undefined);
    await waitForClose(closed[1]!.promise, 3_000);
    assert.equal(await f.app.services.resources.waitForRoleInflightIdle(f.roleId, 3_000), true);

    assert.equal(reports.mock.callCount(), 0);
    assert.deepEqual(failureCodes, []);
    // 取消仍留下“未成功”的用量记录，但不会被外层当作源故障。
    assert.deepEqual(piUsageRows(f), [{ status: "failed" }, { status: "failed" }]);
    assert.equal(requests, 2);
  } finally {
    f.app.services.modelProxy.revoke(first);
    f.app.services.modelProxy.revoke(second);
    await f.close();
    await upstream.close();
  }
});
