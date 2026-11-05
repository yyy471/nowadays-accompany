// 手动真实联调入口，不加入 npm test；密钥只从用户明确指定的文件读取。
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { HttpModelAdapter } from "../src/model/protocols.js";
import { HttpMemoryModel } from "../src/application/memory-runtime.js";
import { rolePaths } from "../src/bootstrap/config.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { createFixtureWithModel, addBinding, withStorage } from "../tests/p2-05-fixture.js";

const credentialPath = process.env.NOWADAYS_ACCEPTANCE_CREDENTIAL_FILE;
const outputPath = process.env.NOWADAYS_REVIEW_OUTPUT;
if (!credentialPath || !outputPath) throw new Error("EXPLICIT_CREDENTIAL_AND_OUTPUT_REQUIRED");
const output = path.resolve(outputPath);
fs.mkdirSync(output, { recursive: true });
const key = fs.readFileSync(credentialPath, "utf8").trim();
process.env.NOWADAYS_ACCEPTANCE_API_KEY = key;
const realFetch = globalThis.fetch;
let paidCalls = 0;
const network: Array<{ path: string; method: string; status?: number }> = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== "https://api.deepseek.com") throw new Error("UNEXPECTED_UPSTREAM");
  if (init?.method === "POST" && ++paidCalls > 12) throw new Error("ACCEPTANCE_CALL_LIMIT");
  const entry: (typeof network)[number] = { path: url.pathname, method: init?.method ?? "GET" };
  network.push(entry);
  const response = await realFetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(60_000)]) });
  entry.status = response.status;
  return response;
};
const results: Array<{ id: string; passed: boolean; observed?: unknown; error?: string }> = [];
const save = () => fs.writeFileSync(path.join(output, "real-model-report.json"), JSON.stringify({ provider: "DeepSeek", model: "deepseek-flash", protocol: "anthropic-messages", paidRequestsStarted: paidCalls, network, results }, null, 2).replaceAll(key, "[REDACTED]"));
async function probe(id: string, action: () => Promise<{ passed: boolean; observed: unknown }>) {
  try { results.push({ id, ...await action() }); }
  catch (error) { results.push({ id, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  save();
  console.log(JSON.stringify({ id, passed: results.at(-1)?.passed }));
}
const baseConfig = { protocol: "anthropic-messages" as const, baseUrl: "https://api.deepseek.com/anthropic", credentialRef: "env:NOWADAYS_ACCEPTANCE_API_KEY" };
let memoryOutput = "";
let memoryCalls = 0;
let memoryFinished = false;
const fixture = createFixtureWithModel({ async *stream() {} }, {
  maxToolRounds: 6,
  disableMemoryRuntime: false,
  modelPortFactory: (binding) => new HttpModelAdapter(binding.config, key),
  memoryModelFactory: (binding) => {
    const adapter = new HttpModelAdapter(binding.config, key);
    return { async form(input) {
      memoryCalls += 1;
      const model = new HttpMemoryModel({ async *stream(request) {
        for await (const event of adapter.stream(request)) { if (event.type === "text_delta") memoryOutput += event.text; yield event; }
      } }, binding);
      try { return await model.form(input); }
      finally { memoryFinished = true; }
    } };
  },
});
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { save(); console.error("REAL_ACCEPTANCE_TIMEOUT"); process.exit(2); }, 240_000);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
try {
  const chat = fixture.app.services.resources.listBindings(fixture.roleId).find((item) => item.capability === "chat_model")!;
  fixture.app.services.resources.update(chat.resourceId, { config: baseConfig });
  fixture.app.services.resources.replaceBindings(fixture.roleId, [{ capability: "chat_model", resourceId: chat.resourceId, modelName: "deepseek-flash" }]);
  await probe("M01-anthropic-model-list", async () => {
    const list = await fixture.app.services.modelServices.listModels(baseConfig);
    return { passed: list.models.includes("deepseek-flash"), observed: list };
  });
  await probe("M02-openai-model-list", async () => {
    const list = await fixture.app.services.modelServices.listModels({ ...baseConfig, protocol: "openai-chat", baseUrl: "https://api.deepseek.com" });
    return { passed: list.models.includes("deepseek-flash"), observed: list };
  });
  await probe("M03-connection-button", async () => {
    const result = await fixture.app.services.modelServices.test({ ...baseConfig, model: "deepseek-flash" });
    return { passed: result.ok, observed: result };
  });
  const send = (content: string) => fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, { content, submissionId: randomUUID(), sourcePlatform: "nowadays" });
  const executions = () => withStorage(fixture, (storage) => storage.business.db.prepare("SELECT execution_id, status, trigger_type FROM executions ORDER BY rowid").all());
  await probe("M04-real-streamed-conversation", async () => {
    send("这是联调验收，不需要工具。请用一句简短中文回复：你准备好一起记录星河观测计划了吗？");
    await fixture.app.conversation.waitForIdle(fixture.roleId, 65_000);
    const messages = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 20).items;
    const completed = messages.filter((item) => item.sender === "assistant" && item.status === "completed");
    return { passed: completed.length === 1, observed: { messages: messages.map((item) => ({ sender: item.sender, status: item.status, content: item.content })), executions: executions() } };
  });
  const workspace = rolePaths(fixture.app.config.dataRoot, fixture.roleId).workspaceDir;
  const mcp = fixture.app.services.resources.create({ kind: "mcp", name: "acceptance-local", config: {
    command: process.execPath,
    args: ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href, "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.resolve("src/mcp/local-server.ts")).href)})`],
    env: { NOWADAYS_WORKSPACE: workspace },
  } });
  addBinding(fixture, "mcp", mcp.resourceId);
  const skills = path.join(fixture.root, "skills");
  fs.mkdirSync(path.join(skills, "acceptance-note"), { recursive: true });
  fs.writeFileSync(path.join(skills, "acceptance-note", "SKILL.md"), "---\nname: acceptance-note\ndescription: 保存观测计划笔记\n---\n按用户指定的相对路径，通过 MCP workspace_write 保存完整 Markdown。成功后用一句中文确认。\n");
  const skill = fixture.app.services.resources.create({ kind: "skill", name: "acceptance-note", config: { sourcePath: skills } });
  addBinding(fixture, "skill", skill.resourceId);
  const marker = `星河验收-${randomUUID().slice(0, 8)}`;
  await probe("M05-real-agent-skill-mcp", async () => {
    send(`请先读取 acceptance-note Skill，然后实际调用 MCP workspace_write 把文件保存到 notes/acceptance.md，正文为：# 星河观测计划\n${marker}\n我与阿澄约定未来三年共同记录观测，下周三讨论望远镜方案，预算1200元，这是重要的共同计划，请记住。只做必要工具调用，成功后用一句话确认。`);
    await fixture.app.conversation.waitForIdle(fixture.roleId, 130_000);
    const note = path.join(workspace, "notes/acceptance.md");
    const content = fs.existsSync(note) ? fs.readFileSync(note, "utf8") : "";
    const calls = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT tool_name, status FROM tool_calls ORDER BY rowid").all());
    const modelCalls = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT purpose, status, error_code, usage_json FROM model_calls ORDER BY rowid").all());
    return { passed: content.includes(marker), observed: { saved: content.includes(marker), note: content, calls, modelCalls, executions: executions() } };
  });
  await probe("M06-real-memory-formation", async () => {
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    const deadline = Date.now() + 65_000;
    while (memoryCalls > 0 && !memoryFinished && Date.now() < deadline) await delay(100);
    const data = withStorage(fixture, (storage) => {
      const memory = new MemoryStore(storage.business.db);
      return { events: memory.listEvents(fixture.roleId), batches: memory.listBatches(fixture.roleId, 10), status: memory.getMemoryStatus(fixture.roleId) };
    });
    return { passed: data.events.length > 0 && data.batches.every((item) => item.status === "completed"), observed: { memoryCalls, memoryFinished, output: memoryOutput, ...data } };
  });
  if (results.find((item) => item.id === "M06-real-memory-formation")?.passed) {
    await probe("M07-real-memory-recall", async () => {
      send("我们星河观测计划约定持续几年，预算多少？请先读取相关事件详情核实后简短回答，不要写文件。");
      await fixture.app.conversation.waitForIdle(fixture.roleId, 90_000);
      const messages = fixture.app.services.messages.list(fixture.roleId, fixture.windowId, 0, 30).items;
      const last = messages.at(-1);
      const recalls = withStorage(fixture, (storage) => storage.business.db.prepare("SELECT * FROM memory_recalls ORDER BY rowid").all());
      return { passed: last?.status === "completed" && /1200|1,200|一千二/.test(last.content), observed: { reply: last, recalls, executions: executions() } };
    });
  }
} finally {
  save();
  await fixture.close();
  delete process.env.NOWADAYS_ACCEPTANCE_API_KEY;
  globalThis.fetch = realFetch;
  clearInterval(alive); clearTimeout(watchdog);
}
if (results.some((item) => !item.passed)) process.exitCode = 1;
