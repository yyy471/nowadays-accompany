import fs from "node:fs/promises";
import path from "node:path";

process.on("disconnect", () => process.exit(1));
process.once("message", async ({ prompt, cwd, baseUrl, lease, modelName, protocol, agentDir }) => {
  let session;
  try {
    const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime } =
      await import("@earendil-works/pi-coding-agent");
    const settingsManager = SettingsManager.inMemory({ cacheWarming: { mode: "off" } });
    const extensionDir = new URL("./extensions/", import.meta.url);
    const extensionFactories = [];
    for (const name of (await fs.readdir(extensionDir)).sort()) {
      if (name.endsWith(".mjs")) extensionFactories.push((await import(new URL(name, extensionDir))).default);
    }
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, extensionFactories,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error("PI_EXTENSION_LOAD_FAILED");
    const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const provider = { baseUrl, apiKey: lease, api: protocol === "openai-chat" ? "openai-completions" : "openai-responses",
      models: [{ id: modelName, name: modelName, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192 }] };
    runtime.registerProvider("nowadays", provider);
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: runtime.getModel("nowadays", modelName),
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), thinkingLevel: "off",
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
