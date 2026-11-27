import fs from "node:fs/promises";
import path from "node:path";

// SDK 已展开 ~、@ 和相对路径，在真实文件操作处检查最终路径。
export async function workspaceTools(cwd, { createWriteToolDefinition, createEditToolDefinition }) {
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
    if (stat.isFile() && stat.nlink > 1) throw Error("PI_WORKSPACE_PATH_DENIED");
    return real;
  }
  const writeFile = async (target, content) => fs.writeFile(await checked(target), content);
  return [
    createWriteToolDefinition(root, { operations: { writeFile, mkdir: async dir => fs.mkdir(await checked(dir), { recursive: true }) } }),
    createEditToolDefinition(root, { operations: { writeFile, readFile: async file => fs.readFile(await checked(file)),
      access: async file => fs.access(await checked(file), fs.constants.R_OK | fs.constants.W_OK) } }),
  ];
}

process.on("disconnect", () => process.exit(1));
process.once("message", async ({ prompt, cwd, baseUrl, lease, modelName, apiFlavor, agentDir, sharedTools, skills }) => {
  let session;
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
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    // 两个 Google SDK 各自拼接路由前缀，只注册型号的最后一段。
    const modelId = apiFlavor === "google-generative-ai" || apiFlavor === "google-vertex"
      ? modelName.replace(/^(?:publishers\/google\/)?models\//, "") : modelName;
    const provider = { baseUrl, apiKey: lease, api: apiFlavor,
      models: [{ id: modelId, name: modelId, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192 }] };
    runtime.registerProvider("nowadays", provider);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("nowadays", modelId),
      customTools: await workspaceTools(cwd, sdk), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off",
      ...(process.platform === "win32" && { tools: ["-bash", "+powershell"] }) }));
    await session.bindExtensions({});
    await session.prompt(prompt);
    const last = session.messages.at(-1);
    if (last?.role !== "assistant" || ["error", "aborted"].includes(last.stopReason)) throw new Error("PI_MODEL_FAILED");
    process.send({ state: "completed", result: session.getLastAssistantText() ?? "" });
  } catch (error) {
    process.send({ state: "failed", error: String(error.message).replaceAll(lease, "[lease]").slice(0, 500) });
  } finally {
    session?.dispose();
    process.disconnect();
  }
});
