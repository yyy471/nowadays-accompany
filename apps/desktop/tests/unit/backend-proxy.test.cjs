"use strict";

// 桌面主进程同源代理的取消结算、流式背压与请求体转发。
// 运行：在 apps/desktop 下执行 `npm test`。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { proxyBackendRequest } = require("../../electron/backend-proxy.cjs");

function startServer(t, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const agent = new http.Agent({ keepAlive: false });
      t.after(async () => {
        agent.destroy();
        server.closeAllConnections();
        await new Promise(done => server.close(() => done()));
      });
      resolve({ server, agent, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function waitFor(predicate, timeout = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error("等待条件超时"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function withTimeout(promise, timeout, message) {
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeout);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const request = (extra = {}) => ({
  method: "GET",
  headers: new Headers(),
  signal: new AbortController().signal,
  ...extra
});

test("预中止信号立即拒绝且不发起上游连接", async (t) => {
  let requests = 0;
  const { base, agent } = await startServer(t, (_req, res) => {
    requests += 1;
    res.end("unexpected");
  });
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(
    proxyBackendRequest(`${base}/v1/health`, request({ signal: controller.signal }), new Headers(), { httpAgent: agent }),
    err => err.name === "AbortError"
  );
  assert.ok(Date.now() - started < 50);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(requests, 0);
});

test("响应头返回前中止会快速拒绝并关闭上游请求", async (t) => {
  let closed = false;
  const { base, agent } = await startServer(t, (req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    req.on("close", () => { closed = true; });
    res.on("close", () => { closed = true; });
  });
  const controller = new AbortController();
  const pending = proxyBackendRequest(`${base}/v1/slow`, request({ signal: controller.signal }), new Headers(), { httpAgent: agent });
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now();
  controller.abort();
  await assert.rejects(pending, err => err.name === "AbortError");
  assert.ok(Date.now() - started < 100);
  await waitFor(() => closed);
});

test("SSE 流中途中止会终止下游流并关闭上游连接", async (t) => {
  let upstreamClosed = false;
  let heartbeat = null;
  const { base, agent } = await startServer(t, (_req, res) => {
    res.on("error", () => {});
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("data: first\n\n");
    heartbeat = setInterval(() => res.write(": ping\n\n"), 20);
    res.on("close", () => {
      clearInterval(heartbeat);
      heartbeat = null;
      upstreamClosed = true;
    });
  });
  t.after(() => clearInterval(heartbeat));
  const controller = new AbortController();
  const response = await proxyBackendRequest(
    `${base}/v1/events`, request({ signal: controller.signal }), new Headers(), { httpAgent: agent }
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /data: first/);

  controller.abort();
  const outcome = await Promise.race([
    (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) return "closed";
        }
      } catch {
        // upstream 被销毁时以 AbortError 报错同样意味着流已终止。
        return "errored";
      }
    })(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("SSE 流未在超时内终止")), 2000))
  ]);
  assert.ok(outcome === "closed" || outcome === "errored");
  await waitFor(() => upstreamClosed);
});

// 上游只发已知部分分片后粗暴断开：正文必须失败，不能以 200 + 短正文正常结束。
async function assertPrematureUpstreamFails(t, extraHeaders) {
  let upstreamRes = null;
  const partial = Buffer.from("abc");
  const { base, agent } = await startServer(t, (_req, res) => {
    res.on("error", () => {});
    res.writeHead(200, { "content-type": "application/octet-stream", ...extraHeaders });
    res.write(partial);
    upstreamRes = res;
  });
  const response = await proxyBackendRequest(`${base}/v1/blob`, request(), new Headers(), { httpAgent: agent });
  assert.equal(response.status, 200);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.ok(Buffer.from(first.value).equals(partial), "首个分片应已由代理送达");
  assert.ok(upstreamRes, "上游响应应已建立");
  upstreamRes.destroy();

  await assert.rejects(
    (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })(),
    err => err instanceof Error && (err.code === "ERR_STREAM_PREMATURE_CLOSE" || err.code === "ECONNRESET")
  );
}

test("上游声明 Content-Length 后中断，消费正文失败", async (t) => {
  await assertPrematureUpstreamFails(t, { "content-length": "8" });
});

test("上游无 Content-Length 的 chunked 流中断，消费正文失败", async (t) => {
  await assertPrematureUpstreamFails(t, {});
});

test("慢消费端触发 upstream 背压，读尽后字节完整一致", async (t) => {
  const chunkSize = 64 * 1024;
  const chunks = Array.from({ length: 64 }, (_, index) => Buffer.alloc(chunkSize, index));
  const payload = Buffer.concat(chunks);
  let sentChunks = 0;
  let finished = false;
  const { base, agent } = await startServer(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(payload.length) });
    const pump = () => {
      while (sentChunks < chunks.length) {
        const writable = res.write(chunks[sentChunks]);
        sentChunks += 1;
        if (!writable) {
          res.once("drain", pump);
          return;
        }
      }
      finished = true;
      res.end();
    };
    pump();
  });

  const response = await proxyBackendRequest(`${base}/v1/blob`, request(), new Headers(), { httpAgent: agent });
  assert.equal(response.status, 200);
  // 消费者暂不拉取：读取端应被暂停，服务端无法把 4 MiB 全部灌入。
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(finished, false);
  assert.ok(sentChunks < chunks.length);

  const reader = response.body.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  const received = Buffer.concat(parts);
  assert.equal(received.length, payload.length);
  assert.ok(received.equals(payload));
  await waitFor(() => finished);
});

test("Web ReadableStream 请求体流式到达服务端且字节完整", async (t) => {
  const pieces = Array.from({ length: 8 }, (_, index) => Buffer.alloc(16 * 1024, index));
  const expected = Buffer.concat(pieces);
  let produced = 0;
  let producedAtFirstData = null;
  let received = null;
  let releaseFirstChunk;
  const firstChunkSeen = new Promise(resolve => { releaseFirstChunk = resolve; });
  const { base, agent } = await startServer(t, (req, res) => {
    const parts = [];
    req.on("data", (chunk) => {
      if (producedAtFirstData === null) {
        producedAtFirstData = produced;
        releaseFirstChunk();
      }
      parts.push(chunk);
    });
    req.on("end", () => {
      received = Buffer.concat(parts);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });

  // 首个分片抵达服务端后才放行后续分片；若代理整包预读，后续 pull 会永久等待。
  const body = new ReadableStream({
    async pull(controller) {
      if (produced === 0) {
        controller.enqueue(pieces[0]);
        produced = 1;
        return;
      }
      if (produced >= pieces.length) {
        controller.close();
        return;
      }
      await firstChunkSeen;
      if (produced >= pieces.length) {
        controller.close();
        return;
      }
      controller.enqueue(pieces[produced]);
      produced += 1;
    }
  });

  const response = await withTimeout(
    proxyBackendRequest(
      `${base}/v1/upload`,
      request({ method: "POST", headers: new Headers({ "content-type": "application/octet-stream" }), body }),
      new Headers(),
      { httpAgent: agent }
    ),
    3000,
    "请求体未流式转发（疑似被整包缓冲）"
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  await withTimeout(waitFor(() => received !== null), 3000, "服务端未完整接收请求体");
  assert.ok(received.equals(expected));
  assert.notEqual(producedAtFirstData, null);
  assert.ok(producedAtFirstData < pieces.length, "服务端收到首批数据时请求体不应已被整包读空");
});
