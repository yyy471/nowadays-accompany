import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const nativeFetch = globalThis.fetch;
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 以前真实联调已验证过该账户的 global 地址。仅读白名单地址，不复制旧库或密钥。
function vertexBase(backend, suppliedUrl) {
  const valid = /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/[\w-]+\/locations\/global\/publishers\/google$/;
  const candidate = suppliedUrl.origin + suppliedUrl.pathname.split("/models/")[0];
  if (valid.test(candidate)) return candidate;
  const project = process.env.NOWADAYS_VERTEX_GLOBAL_PROJECT;
  if (project && /^[\w-]{1,128}$/.test(project)) return suppliedUrl.origin +
    "/v1/projects/" + project + "/locations/global/publishers/google";
  const folder = path.resolve(backend, "../../test-results/backend-acceptance/role-live");
  for (const filename of fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => n.endsWith("vertex-location.txt")).reverse() : []) {
    const appRoot = fs.readFileSync(path.join(folder, filename), "utf8").trim();
    const file = path.join(appRoot, "data", "app.sqlite");
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const records = db.prepare("SELECT json_extract(config_json,'$.baseUrl') AS url FROM resources WHERE kind='model'").all();
      const found = records.find(row => valid.test(row.url));
      if (found) return found.url;
    } finally { db.close(); }
  }
  throw Error("VERTEX_GLOBAL_ROUTE_UNAVAILABLE");
}

export function configureProvider(backend, tier, credentialFile, entries, onCall) {
  const vertex = tier === "vertex";
  const host = vertex ? "aiplatform.googleapis.com" : "api.deepseek.com";
  const origin = "https://" + host;
  const lines = fs.readFileSync(credentialFile, "utf8").split(/\r?\n/);
  const pos = lines.findIndex(line => line.includes(origin + "/"));
  if (pos < 0) throw Error("MODEL_HOST_MISSING");
  const supplied = new URL(lines[pos].match(/https:\/\/[^\s'"\\]+/)[0]);
  if (supplied.origin !== origin || supplied.username || supplied.password) throw Error("MODEL_HOST_MISMATCH");
  const key = supplied.searchParams.get("key") || lines[pos + 1]?.replace(/^sk\s*[:：]\s*/i, "").trim();
  if (!key || /\s/.test(key)) throw Error("MODEL_KEY_UNAVAILABLE");
  process.env.NOWADAYS_LIVE_ROLE_KEY = key;
  const baseUrl = vertex ? vertexBase(backend, supplied) : origin;
  // 只观察真实请求中的已知测试词条，并保留响应原流给正式适配器。
  globalThis.fetch = async (url, options) => {
    if (new URL(url instanceof Request ? url.url : url).origin !== origin) throw Error("MODEL_OUTBOUND_HOST_BLOCKED");
    const body = typeof options?.body === "string" ? JSON.parse(options.body) : {};
    const system = (body.systemInstruction ?? body.system_instruction)?.parts?.map(p => p.text).join("\n") ??
      body.messages?.filter(m => m.role === "system").map(m => m.content).join("\n") ?? "";
    const purpose = system.includes("这是一次自主活动") ? "autonomous" :
      system.includes("你是角色「") ? "chat" : (system.includes("spriteAssetId") ? "expression" : "other");
    const world = entries.filter(e => system.includes(e.content)).map(e => e.title);
    const call = { purpose, world, http: null };
    if (process.env.NOWADAYS_HTTP_RECALL_EVIDENCE === "1" && purpose === "chat") {
      const briefs = /^- \[(?:event|daily_summary|diary)\] [^\r\n]*?（id=([\w-]+)）：([^\r\n]*)/gmu;
      call.recall = [...system.matchAll(briefs)].map(match => ({
        id:match[1],snippet:match[2].replaceAll(key,"[redacted]").slice(0,120),
      }));
    }
    onCall(call);
    try {
      const response = await nativeFetch(url, { ...options, redirect: "error" });
      call.http = response.status;
      const retry = Number(response.headers.get("retry-after"));
      if (retry > 0 && retry <= 300) call.retryMs = retry * 1000;
      return response;
    } catch (error) {
      const code = String(error.cause?.code ?? error.name ?? "NETWORK_ERROR");
      call.networkError = /^[A-Z_0-9]{1,48}$/i.test(code) ? code : "NETWORK_ERROR";
      throw error;
    }
  };
  return { protocol: vertex ? "google-gemini" : "openai-chat", baseUrl, ...(vertex ? {} : {provider:"deepseek"}),
    credentialRef: "env:NOWADAYS_LIVE_ROLE_KEY" };
}

export function httpClient(port) {
  const origin = "http://127.0.0.1:" + port;
  async function request(method, route, body) {
    const multipart = body instanceof FormData;
    const response = await nativeFetch(origin + route, { method,
      headers: body !== undefined && !multipart ? {"Content-Type":"application/json"} : {},
      body: multipart || body === undefined ? body : JSON.stringify(body), redirect: "error" });
    const result = await response.json();
    if (!response.ok) throw Error("HTTP_" + response.status + "_" + (result.error?.code ?? "FAILED") + "_" + route.replace(/[0-9a-f-]{36}/gi,"id"));
    return { status: response.status, body: result };
  }
  return { origin, request, get: async route => (await request("GET", route)).body };
}

export async function openEvents(origin, route, cursor, client) {
  const controller = new AbortController();
  const response = await nativeFetch(origin + route + "/events?after=" + cursor + "&clientId=" + client, { signal: controller.signal });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw Error("SSE_OPEN_FAILED");
  const events = [];
  const decoder = new TextDecoder();
  const done = (async () => {
    let remainder = "";
    for await (const chunk of response.body) {
      remainder += decoder.decode(chunk, { stream: true });
      let stop;
      while ((stop = remainder.indexOf("\n\n")) >= 0) {
        const frame = remainder.slice(0,stop);
        remainder = remainder.slice(stop + 2);
        const line = frame.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        const e = JSON.parse(line.slice(5));
        events.push({ id:e.streamEventId, type:e.type, executionId:e.executionId,
          messageId:e.replyMessageId ?? e.messageId, delta:e.type === "message_delta" ? e.delta ?? e.text : undefined,
          items:e.type === "segment_annotations" ? e.items?.map(s => ({segmentId:s.segmentId,spriteAssetId:s.spriteAssetId})) : undefined });
      }
    }
  })().catch(error => { if (!controller.signal.aborted) return error; });
  return { events, close: async () => { controller.abort(); const failure = await done; if (failure) throw failure; } };
}
