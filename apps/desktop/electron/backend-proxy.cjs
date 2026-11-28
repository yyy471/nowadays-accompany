"use strict";

// 桌面主进程同源代理：把渲染层的 desk://bundle/v1/* 请求转发到本地后端。
// 关键约束：中止必须稳定结算 Promise、流式响应必须有背压、请求体不得整包缓冲。
const http = require("node:http");
const https = require("node:https");
const { Readable } = require("node:stream");

// 扩展资源只能走 nd-ext；workspace/path 只能由主进程 IPC 内部访问，渲染层一律 404。
function isBlockedProxyPath(pathname) {
  return /^\/v1\/extensions\/[^/]+\/ui\//.test(pathname) ||
    /^\/v1\/roles\/[^/]+\/workspace\/path(?:\/|$)/.test(pathname);
}

function createAbortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Request aborted"), { name: "AbortError" });
}

// 上游未正常结束就断开（aborted / error / close without end）时使用的错误码。
function createUpstreamAbortError() {
  return Object.assign(new Error("Upstream response aborted before completion"), {
    code: "ERR_STREAM_PREMATURE_CLOSE"
  });
}

function proxyBackendRequest(targetUrl, request, headers, options = {}) {
  if (request.signal?.aborted) {
    return Promise.reject(createAbortError(request.signal));
  }
  return new Promise((resolveResponse, rejectResponse) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body != null;
    const reqHeaders = {};
    const entries = typeof headers?.entries === "function"
      ? headers.entries()
      : Object.entries(headers ?? {});
    for (const [name, value] of entries) {
      const lower = name.toLowerCase();
      if (lower === "host" || lower === "connection" || lower === "transfer-encoding") continue;
      if (lower === "content-length" && (!hasBody || !/^\d+$/.test(String(value)))) continue;
      reqHeaders[lower === "content-length" ? "content-length" : name] = value;
    }
    if (Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
      reqHeaders["content-length"] = String(request.body.byteLength);
    }

    let settled = false;
    let abortRequested = false;
    let upstreamResRef = null;
    let failResponseStream = null;
    let bodyStream = null;
    let signalCleaned = false;

    function cleanupSignal() {
      if (signalCleaned) return;
      signalCleaned = true;
      request.signal?.removeEventListener("abort", onAbort);
    }

    function fail(err) {
      if (settled) return;
      settled = true;
      cleanupSignal();
      rejectResponse(err);
    }

    const upstreamReq = transport.request(parsed, {
      method: request.method,
      headers: reqHeaders,
      agent: parsed.protocol === "https:" ? options.httpsAgent : options.httpAgent
    }, (upstreamRes) => {
      if (settled) {
        upstreamRes.resume();
        return;
      }
      upstreamResRef = upstreamRes;
      const responseHeaders = new Headers();
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        const name = upstreamRes.rawHeaders[i];
        const value = upstreamRes.rawHeaders[i + 1];
        if (!name) continue;
        const lower = name.toLowerCase();
        if (lower === "transfer-encoding" || lower === "connection" || lower === "keep-alive") continue;
        responseHeaders.append(name, value ?? "");
      }
      const status = upstreamRes.statusCode ?? 502;
      if (request.method === "HEAD" || status === 204 || status === 304) {
        upstreamRes.resume();
        settled = true;
        cleanupSignal();
        resolveResponse(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      let closed = false;
      let waitingForPull = false;
      const stream = new ReadableStream({
        start(controller) {
          // 单一幂等失败出口：aborted / error / close-without-end 都从这里结算，
          // 只有正常 end 才 close，避免把上游断流伪装成完整响应。
          function failStream(err) {
            if (closed) return;
            closed = true;
            cleanupSignal();
            try { controller.error(err ?? createUpstreamAbortError()); } catch { /* 已关闭或已取消 */ }
            if (!upstreamRes.destroyed) upstreamRes.destroy();
            if (!upstreamReq.destroyed) upstreamReq.destroy();
          }
          failResponseStream = failStream;

          upstreamRes.on("data", (chunk) => {
            if (closed) return;
            try {
              controller.enqueue(chunk);
            } catch {
              failStream(createUpstreamAbortError());
              return;
            }
            if ((controller.desiredSize ?? 0) <= 0) {
              waitingForPull = true;
              upstreamRes.pause();
            }
          });
          upstreamRes.on("end", () => {
            // 防御性判断：只有声明完整结束的上游才是正常完成。
            if (upstreamRes.complete === false) {
              failStream(createUpstreamAbortError());
              return;
            }
            if (closed) return;
            closed = true;
            cleanupSignal();
            try { controller.close(); } catch { /* 已关闭 */ }
          });
          upstreamRes.on("aborted", () => {
            failStream(abortRequested ? createAbortError(request.signal) : createUpstreamAbortError());
          });
          upstreamRes.on("error", (err) => {
            failStream(err);
          });
          upstreamRes.on("close", () => {
            // 正常 end / 主动取消已先置 closed；此处只处理没有 end 的关闭。
            failStream(abortRequested ? createAbortError(request.signal) : createUpstreamAbortError());
          });
        },
        pull() {
          if (!closed && waitingForPull) {
            waitingForPull = false;
            upstreamRes.resume();
          }
        },
        cancel() {
          closed = true;
          cleanupSignal();
          upstreamRes.destroy();
          upstreamReq.destroy();
        }
      });
      settled = true;
      resolveResponse(new Response(stream, { status, headers: responseHeaders }));
    });

    function onAbort() {
      abortRequested = true;
      const err = createAbortError(request.signal);
      if (bodyStream && !bodyStream.destroyed) bodyStream.destroy(err);
      // 响应已开始下发时，以 AbortError 结算下游正文；尚未返回响应头则由 fail() 拒绝。
      if (failResponseStream) {
        failResponseStream(err);
      }
      if (!upstreamReq.destroyed) upstreamReq.destroy(err);
      if (upstreamResRef && !upstreamResRef.destroyed) upstreamResRef.destroy(err);
      fail(err);
    }

    if (request.signal) {
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
    upstreamReq.on("error", (err) => fail(err));
    upstreamReq.on("close", () => {
      if (!settled) {
        fail(abortRequested ? createAbortError(request.signal) : new Error("Upstream closed before response headers"));
      }
    });

    // 请求体流式转发：Web ReadableStream 直接 pipe，短 Buffer/字符串才整块写出。
    if (hasBody) {
      if (typeof request.body.getReader === "function") {
        bodyStream = Readable.fromWeb(request.body);
        bodyStream.on("error", (err) => {
          upstreamReq.destroy(err);
          fail(err);
        });
        bodyStream.pipe(upstreamReq);
      } else if (Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
        upstreamReq.end(Buffer.from(request.body));
      } else if (typeof request.body === "string") {
        upstreamReq.end(request.body);
      } else {
        upstreamReq.end();
      }
    } else {
      upstreamReq.end();
    }
  });
}

module.exports = { isBlockedProxyPath, createAbortError, proxyBackendRequest };
