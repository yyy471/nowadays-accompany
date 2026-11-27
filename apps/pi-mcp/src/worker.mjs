import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_STEPS = 50;
const MAX_TAIL = 240;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** 由工程池成员的可选参数推出 provider 注册与思考等级所需的最终值。 */
export function resolveModelSpec({ modelName, apiFlavor, maxTokens, contextWindow, thinkingLevel }) {
  // 两个 Google SDK 各自拼接路由前缀，只注册型号的最后一段。
  const modelId = apiFlavor === "google-generative-ai" || apiFlavor === "google-vertex"
    ? modelName.replace(/^(?:publishers\/google\/)?models\//, "") : modelName;
  const completions = apiFlavor === "openai-completions";
  const resolvedMaxTokens = Number.isInteger(maxTokens) && maxTokens >= 1024 && maxTokens <= 131072
    ? maxTokens : completions ? 16384 : 32768;
  const resolvedContextWindow = Number.isInteger(contextWindow) && contextWindow >= 8192 && contextWindow <= 2_000_000
    ? contextWindow : completions ? 128000 : 200000;
  const resolvedThinkingLevel = THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : "off";
  return { modelId, maxTokens: resolvedMaxTokens, contextWindow: resolvedContextWindow,
    thinkingLevel: resolvedThinkingLevel, reasoning: resolvedThinkingLevel !== "off" };
}

function stepTarget(tool, args) {
  const input = args && typeof args === "object" ? args : {};
  const value = tool === "write" || tool === "edit" || tool === "read" ? input.path
    : tool === "draft_test" ? input.file
    : tool === "powershell" || tool === "bash" ? input.command : undefined;
  return typeof value === "string" ? value.slice(0, 160) : "";
}

function stepTail(content, lease) {
  const text = Array.isArray(content)
    ? content.map(part => typeof part?.text === "string" ? part.text : "").join("")
    : typeof content === "string" ? content : "";
  const scrubbed = lease ? text.replaceAll(String(lease), "[lease]") : text;
  return scrubbed.length > MAX_TAIL ? scrubbed.slice(-MAX_TAIL) : scrubbed;
}

// SDK 已展开 ~、@ 和相对路径，在真实文件操作处检查最终路径。
export async function workspaceTools(cwd, { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition }) {
  const root = await fs.realpath(cwd);
  function requireInside(target) {
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error("PI_WORKSPACE_PATH_DENIED");
  }
  async function checked(target) {
    requireInside(target);
    // 新文件可缺少多级父目录。悬空链接由 realpath 拒绝。
    const stat = await fs.lstat(target).catch(error => {
      if (error.code !== "ENOENT") throw error;
    });
    if (!stat) {
      return path.join(await checked(path.dirname(target)), path.basename(target));
    }
    const real = await fs.realpath(target);
    requireInside(real);
    const finalStat = await fs.stat(real);
    if (finalStat.isFile() && finalStat.nlink > 1) throw Error("PI_WORKSPACE_PATH_DENIED");
    return real;
  }
  const read = createReadToolDefinition(root);
  // 复用 SDK 的路径归一化规则；升级 SDK 时需核对该内部模块路径。
  const { resolvePath } = await import(new URL("./utils/paths.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  const executeRead = read.execute;
  read.execute = async (id, args, signal, update, ctx) => {
    const file = await checked(resolvePath(args.path, root, { normalizeUnicodeSpaces: true, stripAtPrefix: true }));
    await fs.access(file);
    return executeRead(id, { ...args, path: pathToFileURL(file).href }, signal, update, { ...ctx, cwd: root });
  };
  const draftTest = {
    name: "draft_test", label: "draft_test", description: "Run a JavaScript test file in the draft workspace.",
    parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"], additionalProperties: false },
    async execute(_id, { file }, signal) {
      if (!file || path.isAbsolute(file) || !/\.(?:js|mjs)$/i.test(file)) throw Error("PI_WORKSPACE_PATH_DENIED");
      const target = await checked(path.resolve(root, file));
      const relativeTarget = path.relative(root, target);
      if (/[{}*?!]|[@+]\(/.test(relativeTarget)) throw Error("PI_WORKSPACE_PATH_DENIED");
      const testPattern = relativeTarget.replace(/[[\]]/g, character => character === "[" ? "[[]" : "[]]");
      const stat = await fs.stat(target).catch(() => { throw Error("PI_WORKSPACE_PATH_DENIED"); });
      if (!stat.isFile() || stat.nlink > 1 || !/\.(?:js|mjs)$/i.test(target)) throw Error("PI_WORKSPACE_PATH_DENIED");
      if (signal?.aborted) throw Error("PI_DRAFT_TEST_CANCELLED");
      const temp = await fs.mkdtemp(path.join(root, ".pi-test-tmp-"));
      try { return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--permission", "--allow-fs-read=" + root, "--allow-fs-write=" + root,
          "--test", "--test-isolation=none", "--", testPattern], { cwd: root, shell: false, windowsHide: true,
          env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            HOME: "", USERPROFILE: "", HOMEDRIVE: "", HOMEPATH: "", APPDATA: "", LOCALAPPDATA: "", PATH: "", NODE_OPTIONS: "", NODE_V8_COVERAGE: "", TEMP: temp, TMP: temp } });
        let output = Buffer.alloc(0), reason;
        const stop = value => { if (!reason) { reason = value; child.kill("SIGKILL"); } };
        const timer = setTimeout(() => stop("PI_DRAFT_TEST_TIMEOUT"), 30000);
        const abort = () => stop("PI_DRAFT_TEST_CANCELLED");
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
          const remaining = 65536 - output.length;
          output = Buffer.concat([output, chunk.subarray(0, Math.max(0, remaining))]);
          if (chunk.length > remaining) stop("PI_DRAFT_TEST_OUTPUT_LIMIT");
        });
        child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
        child.once("close", code => {
          clearTimeout(timer); signal?.removeEventListener("abort", abort);
          if (reason) reject(Error(reason));
          else {
            const text = output.toString("utf8");
            resolve({ content: [{ type: "text", text: `Exit code: ${code ?? "signal"}\n${text}` }], details: { exitCode: code } });
          }
        });
      }); } finally { await fs.rm(temp, { recursive: true, force: true }); }
    },
  };
  const writeFile = async (target, content) => fs.writeFile(await checked(target), content);
  return [
    read,
    createWriteToolDefinition(root, { operations: { writeFile, mkdir: async dir => fs.mkdir(await checked(dir), { recursive: true }) } }),
    createEditToolDefinition(root, { operations: { writeFile, readFile: async file => fs.readFile(await checked(file)),
      access: async file => fs.access(await checked(file), fs.constants.R_OK | fs.constants.W_OK) } }),
    draftTest,
  ];
}

process.on("disconnect", () => process.exit(1));
process.once("message", async ({ prompt, cwd, baseUrl, lease, modelName, apiFlavor, agentDir, sharedTools, skills, allowShell,
  jobId, maxTokens, contextWindow, thinkingLevel }) => {
  let session;
  const steps = [];
  const startedSteps = new Map();
  // 步骤日志放在草稿目录上一级，避免进入扩展发布文件；仅在目录确属本工程时落盘。
  const stepLogPath = jobId && path.basename(path.dirname(cwd)) === jobId
    ? path.join(path.dirname(cwd), "steps.json") : null;
  const writeSteps = async () => {
    if (!stepLogPath) return;
    try {
      await fs.writeFile(stepLogPath, JSON.stringify({ jobId, updatedAt: new Date().toISOString(), steps }));
    } catch { /* 诊断日志失败绝不影响任务执行 */ }
  };
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } = sdk;
    const settingsManager = SettingsManager.inMemory({ cacheWarming: { mode: "off" }, retry: { enabled: false, provider: { maxRetries: 0 } } });
    const extensionDir = new URL("./extensions/", import.meta.url);
    const extensionFactories = [];
    for (const name of (await fs.readdir(extensionDir)).sort()) {
      if (!name.endsWith(".mjs")) continue;
      const extension = (await import(new URL(name, extensionDir))).default;
      extensionFactories.push(name === "shared-tools.mjs"
        ? pi => extension(pi, { sharedTools, baseUrl, lease, skills })
        : extension);
    }
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error("PI_EXTENSION_LOAD_FAILED");
    const extensionToolNames = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const spec = resolveModelSpec({ modelName, apiFlavor, maxTokens, contextWindow, thinkingLevel });
    const provider = { baseUrl, apiKey: lease, api: apiFlavor,
      models: [{ id: spec.modelId, name: spec.modelId, reasoning: spec.reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: spec.contextWindow, maxTokens: spec.maxTokens }] };
    runtime.registerProvider("nowadays", provider);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("nowadays", spec.modelId),
      customTools: await workspaceTools(cwd, sdk), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: spec.thinkingLevel,
      tools: ["read", "write", "edit", "draft_test", ...(allowShell === true ? [process.platform === "win32" ? "powershell" : "bash"] : []), ...extensionToolNames] }));
    await session.bindExtensions({});
    session.subscribe(event => {
      if (event.type === "tool_execution_start") {
        startedSteps.set(event.toolCallId, { tool: event.toolName, target: stepTarget(event.toolName, event.args) });
        return;
      }
      if (event.type !== "tool_execution_end") return;
      const start = startedSteps.get(event.toolCallId);
      startedSteps.delete(event.toolCallId);
      const tail = stepTail(event.result?.content, lease);
      steps.push({
        at: new Date().toISOString(),
        tool: typeof event.toolName === "string" ? event.toolName : start?.tool,
        ...(start?.target ? { target: start.target } : {}),
        isError: Boolean(event.isError),
        ...(typeof event.durationMs === "number" ? { durationMs: Math.round(event.durationMs) } : {}),
        ...(typeof event.result?.details?.exitCode === "number" ? { exitCode: event.result.details.exitCode } : {}),
        ...(tail ? { tail } : {}),
      });
      if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS);
      void writeSteps();
    });
    await session.prompt(prompt);
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) throw new Error("PI_MODEL_FAILED");
    process.send({ state: "completed", result: session.getLastAssistantText() ?? "" });
  } catch (error) {
    process.send({ state: "failed", error: String(error.message).replaceAll(lease, "[lease]").slice(0, 500) });
  } finally {
    await writeSteps();
    session?.dispose();
    process.disconnect();
  }
});
