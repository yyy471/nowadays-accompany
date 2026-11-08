"use strict";

const { app, BrowserWindow, Menu, Tray, net, protocol } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const home = "desk://bundle/index.html";
const icon = join(__dirname, "assets", "window.png");
const assets = /^\/(?:index\.html|[a-z0-9-_]+\.(?:js|css)|assets\/(?:FONTS-LICENSE\.txt|[a-z0-9-_]+\.(?:webp|svg|woff|png|ico)))$/i;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "desk",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

let window;
let tray;
let quitting = false;
let backendChild = null;
let backendBaseUrl = process.env.NOWADAYS_BACKEND_URL || "";
let mockLlmServer = null;
let mockLlmBaseUrl = "";
let backendReadyPromise = null;

function resolveNode24Executable() {
  const candidates = [
    resolve(__dirname, "..", "..", "prototypes", "p0", ".runtime", "node-v24.22.2-win-x64", "node.exe"),
    process.env.NOWADAYS_NODE_PATH || ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "node";
}

/**
 * 启动内置离线 OpenAI 兼容模型响应器（遵循 AGENTS.md：默认离线不自动调用付费接口，
 * 同时让整个 LangGraph 编排、SQLite 事务落盘、SSE 流式增量、记忆整理批次 100% 走真实后端链路）
 */
function startOfflineLlmServer() {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            data: [
              { id: "nowadays-companion-v1" },
              { id: "deepseek-chat" },
              { id: "claude-3-7-sonnet" }
            ]
          })
        );
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        let rawBody = "";
        req.on("data", (chunk) => {
          rawBody += chunk.toString();
        });
        req.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(rawBody || "{}");
          } catch {
            parsed = {};
          }
          const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
          const systemText = String(messages.find((m) => m.role === "system")?.content || "");
          const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
          const userContent = String(lastUserMsg?.content || "").trim();

          // 判断是否为后台记忆整理请求（MemoryRuntime 调用，system 包含“你是记忆整理器”）
          const isMemoryFormation = systemText.includes("你是记忆整理器");

          if (isMemoryFormation) {
            let memInput = {};
            try {
              memInput = JSON.parse(userContent || "{}");
            } catch {
              memInput = {};
            }
            const evList = Array.isArray(memInput.evidence) ? memInput.evidence : [];
            const firstEv = evList[0];
            const operations = firstEv
              ? [
                  {
                    op: "create_event",
                    localKey: "xiacheng_chat_" + String(memInput.currentRound || 1),
                    title: "与夏澄在光影书房的窗畔书信交谈",
                    summary: `围绕「${String(firstEv.content || "日常陪伴").slice(0, 36)}」进行了温暖的书信交流，并记录在心境档案中。`,
                    subjectiveExperience: "窗边的阳光很暖，能收到他的来信让我觉得格外安心。",
                    occurredAtStart: firstEv.occurredAt || new Date().toISOString(),
                    occurredAtEnd: null,
                    experienceDate: firstEv.localDate || new Date().toISOString().slice(0, 10),
                    tags: {
                      person: ["夏澄", "用户"],
                      topic: ["窗畔书信", "日常共读"],
                      place: ["光影书房"],
                      emotion: ["温暖", "晴柔"],
                      source: ["nowadays"]
                    },
                    evidenceIds: evList.map((e) => e.evidenceId)
                  }
                ]
              : [];
            const jsonText = JSON.stringify({ operations });
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive"
            });
            const delta = {
              id: "chatcmpl-mem",
              choices: [{ index: 0, delta: { content: jsonText }, finish_reason: null }]
            };
            const doneChunk = {
              id: "chatcmpl-mem",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 }
            };
            res.write(`data: ${JSON.stringify(delta)}\n\n`);
            res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          // 连接测试快速响应 (POST /v1/model-services/test)
          if (userContent === "ping") {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive"
            });
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-ping", choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ id: "chatcmpl-ping", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }

          // 离线模型的固定回复（仅用于本地验证，不调用真实模型）
          const replyText = `嗯，我正坐在书桌前认真读你的信呢。关于「${userContent.slice(0, 28) || "刚才聊到的话题"}」，我已经记在心上了，我们随时接着往下聊。`;

          if (parsed.stream === false) {
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(
              JSON.stringify({
                id: `chatcmpl-${randomUUID()}`,
                object: "chat.completion",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: replyText },
                    finish_reason: "stop"
                  }
                ],
                usage: { prompt_tokens: 92, completion_tokens: 64, total_tokens: 156 }
              })
            );
            return;
          }

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          });

          // 分块流式推送，让前端呈现细腻的钢笔落墨打字机动效与中断感知验证
          const chunks = replyText.match(/.{1,6}/gu) || [replyText];
          let idx = 0;
          const timer = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
              clearInterval(timer);
              return;
            }
            if (idx < chunks.length) {
              const delta = {
                id: "chatcmpl-stream",
                choices: [{ index: 0, delta: { content: chunks[idx] }, finish_reason: null }]
              };
              res.write(`data: ${JSON.stringify(delta)}\n\n`);
              idx += 1;
            } else {
              clearInterval(timer);
              const finalChunk = {
                id: "chatcmpl-stream",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 96, completion_tokens: chunks.length * 6 }
              };
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            }
          }, 22);

          res.on("close", () => clearInterval(timer));
        });
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not Found" } }));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      mockLlmServer = server;
      mockLlmBaseUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolvePromise(mockLlmBaseUrl);
    });
  });
}

async function apiRequest(method, path, body) {
  const res = await fetch(`${backendBaseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * 首次启动或新目录时，仅初始化「夏澄」一个空状态角色实例及基础资源绑定，不注入任何演示数据。
 * 之后的角色由用户配置，不在这里预置（DL-134）。
 */
async function seedInitialBackendDataIfNeeded(backendRoot, appRoot) {
  const rolesList = await apiRequest("GET", "/v1/roles");
  const existing = Array.isArray(rolesList?.items) ? rolesList.items : [];
  if (existing.length > 0) {
    // 同步当前进程启动的离线模型端口到已持久化的 model 资源
    const resList = await apiRequest("GET", "/v1/resources?kind=model");
    for (const item of resList?.items || []) {
      if (item.config?.baseUrl && String(item.config.baseUrl).includes("127.0.0.1")) {
        await apiRequest("PATCH", `/v1/resources/${item.resourceId}`, {
          config: {
            protocol: item.config.protocol || "openai-chat",
            baseUrl: mockLlmBaseUrl,
            maxInputChars: 32000,
            maxOutputChars: 4000
          }
        }).catch(() => {});
      }
    }
    return;
  }

  // 1. 创建离线模型资源与技能资源
  const modelRes = await apiRequest("POST", "/v1/resources", {
    kind: "model",
    name: "本地陪伴模型服务 (OpenAI Chat 兼容)",
    enabled: true,
    config: {
      protocol: "openai-chat",
      baseUrl: mockLlmBaseUrl,
      maxInputChars: 32000,
      maxOutputChars: 4000
    }
  });

  const skillsPath = resolve(backendRoot, "examples", "skills");
  let skillRes = null;
  if (fs.existsSync(skillsPath)) {
    skillRes = await apiRequest("POST", "/v1/resources", {
      kind: "skill",
      name: "日常札记与阅读归档 (Skill)",
      enabled: true,
      config: {
        sourcePath: skillsPath
      }
    });
  }

  const mcpServerPath = resolve(backendRoot, "src", "mcp", "local-server.ts");
  const tsxLoaderUrl = pathToFileURL(resolve(backendRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;

  // 2. 创建角色：「夏澄」（保持空状态，不预置演示消息、日记、唤醒或工作空间稿件）
  const xiacheng = await apiRequest("POST", "/v1/roles", {
    displayName: "夏澄",
    definition: {
      text: "夏澄是一名温和细腻的文学与自由撰稿人，喜欢在二楼光影书房的木桌前读书、整理笔记、写手账，并用棉浆信笺与你分享日常。",
      payload: {
        slug: "xiacheng",
        enName: "Xiacheng",
        subtitle: "光影书房 · 阅读与手账",
        avatar: "assets/xiacheng-day.webp"
      }
    },
    state: {}
  });

  const xiachengWorkspace = resolve(appRoot, "data", "roles", xiacheng.roleId, "workspace");
  fs.mkdirSync(join(xiachengWorkspace, "notes"), { recursive: true });

  const mcpRes = await apiRequest("POST", "/v1/resources", {
    kind: "mcp",
    name: "本地工作空间文件与命令工具 (MCP)",
    enabled: true,
    config: {
      command: resolveNode24Executable(),
      args: [
        "--import",
        tsxLoaderUrl,
        "--input-type=module",
        "-e",
        `import(${JSON.stringify(pathToFileURL(mcpServerPath).href)})`
      ],
      env: {
        NOWADAYS_WORKSPACE: xiachengWorkspace
      }
    }
  });

  const xiachengBindings = [
    { capability: "chat_model", resourceId: modelRes.resourceId, modelName: "nowadays-companion-v1", enabled: true },
    { capability: "memory_model", resourceId: modelRes.resourceId, modelName: "nowadays-companion-v1", enabled: true },
    { capability: "mcp", resourceId: mcpRes.resourceId, enabled: true }
  ];
  if (skillRes) {
    xiachengBindings.push({ capability: "skill", resourceId: skillRes.resourceId, enabled: true });
  }
  await apiRequest("PUT", `/v1/roles/${xiacheng.roleId}/bindings`, { bindings: xiachengBindings });
  await apiRequest("PUT", `/v1/roles/${xiacheng.roleId}/autonomy/budget`, { dailyLimit: 200, unlimited: false });
}

async function ensureBackendRunning() {
  if (backendReadyPromise) {
    return backendReadyPromise;
  }
  backendReadyPromise = (async () => {
    await startOfflineLlmServer();

    if (backendBaseUrl) {
      try {
        const health = await apiRequest("GET", "/v1/health");
        if (health?.status === "ok") {
          return backendBaseUrl;
        }
      } catch {
        // 继续尝试拉起本地受管后端
      }
    }

    const backendRoot = resolve(__dirname, "..", "..", "backend");
    const appRoot = process.env.NOWADAYS_APP_ROOT || resolve(backendRoot, ".nowadays-desktop");
    const nodeBin = resolveNode24Executable();
    const mainScript = resolve(backendRoot, "src", "main.ts");

    await new Promise((resolveStart, rejectStart) => {
      const child = spawn(
        nodeBin,
        ["--import", "tsx", mainScript, "--app-root", appRoot, "--port", "0"],
        {
          cwd: backendRoot,
          env: { ...process.env, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        }
      );
      backendChild = child;
      let stdoutBuf = "";
      let stderrBuf = "";
      const timer = setTimeout(() => {
        rejectStart(new Error(`Backend start timeout: ${stderrBuf}`));
      }, 18000);

      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });

      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() || "";
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("{")) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.event === "listening" && evt.port) {
              clearTimeout(timer);
              backendBaseUrl = `http://${evt.host || "127.0.0.1"}:${evt.port}`;
              resolveStart();
              return;
            }
          } catch {
            // ignore non-json lines
          }
        }
      });

      child.once("error", (err) => {
        clearTimeout(timer);
        rejectStart(err);
      });

      child.once("exit", (code) => {
        if (!backendBaseUrl) {
          clearTimeout(timer);
          rejectStart(new Error(`Backend exited early (${code}): ${stderrBuf}`));
        }
      });
    });

    await seedInitialBackendDataIfNeeded(backendRoot, appRoot);
    return backendBaseUrl;
  })();

  return backendReadyPromise;
}

function stopManagedBackend() {
  if (backendChild && backendChild.exitCode === null) {
    try {
      backendChild.kill("SIGTERM");
    } catch {
      // ignore
    }
    backendChild = null;
  }
  if (mockLlmServer) {
    try {
      mockLlmServer.close();
    } catch {
      // ignore
    }
    mockLlmServer = null;
  }
}

function revealDesk() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function startDesk() {
  try {
    await ensureBackendRunning();
  } catch (err) {
    console.error("[desk-preview] Failed to start managed backend:", err);
  }

  protocol.handle("desk", async (request) => {
    const { hostname, pathname, search } = new URL(request.url);
    if (hostname !== "bundle") {
      return new Response(null, { status: 404 });
    }

    // 1. 暴露当前连接的本地后端地址与状态
    if (pathname === "/api-config.json") {
      return new Response(
        JSON.stringify({
          backendBaseUrl,
          mockLlmBaseUrl,
          connected: Boolean(backendBaseUrl)
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" }
        }
      );
    }

    // 2. 同源代理 /v1/* 请求至真实本地后端
    if (pathname.startsWith("/v1/")) {
      if (!backendBaseUrl) {
        return new Response(
          JSON.stringify({ error: { code: "BACKEND_OFFLINE", message: "本地后端尚未就绪" } }),
          { status: 503, headers: { "content-type": "application/json; charset=utf-8" } }
        );
      }
      const targetUrl = `${backendBaseUrl}${pathname}${search}`;
      const init = {
        method: request.method,
        headers: request.headers
      };
      if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
        init.body = await request.arrayBuffer();
      }
      return net.fetch(targetUrl, init);
    }

    // 3. 静态资源服务
    if (request.method !== "GET" || !assets.test(pathname)) {
      return new Response(null, { status: 404 });
    }
    return net.fetch(pathToFileURL(join(__dirname, pathname.slice(1))).href);
  });

  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    width: 1440,
    height: 840,
    minWidth: 720,
    minHeight: 540,
    useContentSize: true,
    title: "Nowadays · 光影书房",
    icon,
    show: false,
    backgroundColor: "#1b1e2b",
    titleBarStyle: "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", revealDesk);
  window.on("close", (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  tray = new Tray(icon);
  tray.setToolTip("Nowadays · 光影书房");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开光影书房", click: revealDesk },
      { label: "退出 Nowadays", click: () => app.quit() }
    ])
  );
  tray.on("double-click", revealDesk);
  void window.loadURL(home);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", revealDesk);
  app.on("before-quit", () => {
    quitting = true;
    stopManagedBackend();
  });
  app.on("window-all-closed", () => {
    app.quit();
  });
  void app.whenReady().then(startDesk);
}
