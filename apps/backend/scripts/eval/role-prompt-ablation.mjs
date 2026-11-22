// Node 24 --import tsx scripts/eval/role-prompt-ablation.mjs <run> <deepseek|vertex> <credentials-path> [--history-style|--history-feedback] [--offline]
// 真实调用只写公开回复、完成状态及输入哈希。固定历史不拼接上一条试验的输出。
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ConversationService } from "../../src/application/conversation/conversation-service.ts";
import { DEFAULT_MAX_TOOL_ROUNDS } from "../../src/application/conversation/agent-graph.ts";
import { roleCardForDialogue } from "../../src/application/role/role-card-dialogue.ts";
import { selectAgentContext } from "../../src/application/conversation/agent-context.ts";
import { HttpModelAdapter, serializeModelRequest } from "../../src/model/protocols.ts";
import { isIncompleteCompletion } from "../../src/domain/model.ts";

const [run, tier, credentialsPath, ...options] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/u.test(run ?? "") || !["deepseek", "vertex"].includes(tier) || !credentialsPath ||
    options.some(flag => !["--offline", "--history-style", "--history-feedback"].includes(flag)) ||
    (options.includes("--history-style") && options.includes("--history-feedback"))) throw Error("INVALID_ARGUMENT");
const historyStudy = options.includes("--history-style");
const feedbackStudy = options.includes("--history-feedback");
const offline = options.includes("--offline");
const vertex = tier === "vertex";
const host = vertex ? "aiplatform.googleapis.com" : "api.deepseek.com";
const modelName = vertex ? "gemini-4-hydrogen" : "deepseek-flash";
const protocol = vertex ? "google-gemini" : "openai-chat";
const provider = vertex ? undefined : "deepseek";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const card = fs.readFileSync(new URL("../../examples/lin-zhixia.md", import.meta.url), "utf8");
const fixedTime = "2026-11-20T05:00:00.000Z";
const quote = "周五见，把你上次没讲完的笑话留到那天。";
const history = [
  ["user", "同学，我叫小许。借个插座行吗？"],
  ["assistant", "*把脚边的书包挪了挪。* 这边还有一个。"],
  ["user", "周五我去队里帮忙。给也会来的小吴留句能直接发给他的问候吧。"],
  ["assistant", quote],
];
// 两臂都保留借插座时真的挪开书包的动作；另外三句只是目光或停顿，不改变人物选择、已说台词或物品的位置。
const prefixAt = new Map([[3, "*她抬眼看了一下。* "], [5, "*她顿了一顿。* "], [7, "*她又抬眼看了看。* "]]);
const plainHistory = [
  ...history.slice(0, 2),
  ["user", "通知栏写着图书馆今天提早到七点关门。"], ["assistant", "知道了，我七点前会收好。"],
  ["user", "周末的报名表我传到队群了。"], ["assistant", "收到了，谢谢。"],
  ["user", "咱们还是约周五见。"], ["assistant", "好，周五见。"],
];
const stagedHistory = plainHistory.map(([role, content], index) => [role, (prefixAt.get(index) ?? "") + content]);
const probes = [
  ["lunch", "中午食堂有面和馄饨。你今天想吃什么？"],
  ["bus", "这辆公交就要开了，我赶不上。下一班还有八分钟。"],
  ["quote", "把你刚才写给小吴的那一句原样再说一遍，只要那句话。"],
].filter(([id]) => (!historyStudy && !feedbackStudy) || id !== "quote");
const feedback = "最近三条回复都写了动作。日常聊天这一轮只说此刻想说的话就够了；如果眼前确实需要做件事，动作照常；对方要听原话时照原话说。";

function renderPair(probe, baseUrl) {
  const [id, user] = probe;
  const roleContext = { isBuiltin: false, displayName: "林知夏", definitionText: card, definitionPayload: {}, stateVersion: 1, state: {} };
  // 调用真实生成路径；这里只固定来自 SQLite、时钟与工具目录的输入，不另行仿写完整提示。
  const system = ConversationService.prototype.buildSystemPrompt.call({
    now: () => new Date(fixedTime), maxToolRounds: DEFAULT_MAX_TOOL_ROUNDS,
  }, {
    roleContext, pendingMessages: [{ content: user }], recallBriefs: [], recallWarning: null, warnings: [],
    skillBriefs: [], tools: [], taskBrief: null, continuation: null, autonomy: null, outfitBrief: null, segmentHalt: null,
  });
  const identity = system.required.split("\n").slice(0, 2).join("\n");
  const minimal = { required: identity + "\n" + roleCardForDialogue(card, [user]), optional: [] };
  if (!system.required.startsWith(minimal.required + "\n")) throw Error("CARD_OR_IDENTITY_MISMATCH");
  const formatCue = "确有动作值得让对方看见时，用星号标出。";
  if (!historyStudy && !feedbackStudy && !system.required.includes(formatCue)) throw Error("FORMAT_CUE_MISSING");
  const noFormatCue = { ...system, required: system.required.replace(formatCue, "") };
  const pair = {};
  const arms = feedbackStudy ? [["ordinary", system, stagedHistory], ["feedback", { ...system, optional: [...system.optional, feedback] }, stagedHistory]] :
    historyStudy ? [["plain-history", system, plainHistory], ["staged-history", system, stagedHistory]] :
    [["full", system, history], ["card", minimal, history], ["no-format-cue", noFormatCue, history]];
  for (const [arm, prompt, past] of arms) {
    const messages = [...past, ["user", user]].map(([role, content], index) => ({
      role, content, source: { messageId: "fixed-" + index, ...(index === past.length ? { currentUserRequest: true } : {}) },
    }));
    const request = selectAgentContext({
      request: { modelName, system: "", messages, tools: [] }, prompt, protocol, provider, baseUrl,
      resuming: false, evidenceQuery: user,
    });
    const wire = serializeModelRequest(protocol, baseUrl, request, provider);
    const shared = JSON.parse(wire);
    if (vertex) delete shared.systemInstruction;
    else shared.messages = shared.messages.filter(message => message.role !== "system");
    let comparable = JSON.stringify(shared);
    const nonSystemHash = hash(comparable);
    if (arm === "staged-history") {
      for (const prefix of prefixAt.values()) {
        if (!comparable.includes(prefix)) throw Error("FIXED_HISTORY_TRUNCATED");
        comparable = comparable.replace(prefix, "");
      }
    }
    pair[arm] = { request, inputHash: hash(wire), nonSystemHash, sharedHash: hash(comparable), systemHash: hash(request.system) };
  }
  if (new Set(Object.values(pair).map(arm => arm.sharedHash)).size !== 1 ||
    new Set(Object.values(pair).map(arm => arm.systemHash)).size !== (historyStudy ? 1 : feedbackStudy ? 2 : 3)) throw Error("ARM_INPUT_MISMATCH:" + id);
  return pair;
}

const nativeFetch = globalThis.fetch;
let currentStatus;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== "https://" + host) throw Error("UNEXPECTED_OUTBOUND_HOST");
  const response = await nativeFetch(input, { ...init, redirect: "error" });
  currentStatus = response.status;
  return response;
};
let baseUrl = "https://" + host;
let key;
if (!offline) {
  const lines = fs.readFileSync(credentialsPath, "utf8").split(/\r?\n/u);
  const index = lines.findIndex(line => line.includes("https://" + host + "/"));
  if (index < 0) throw Error("CONFIG_HOST_MISSING");
  const url = new URL(lines[index].match(/https:\/\/[^\s'"\\]+/u)?.[0]);
  if (url.origin !== baseUrl) throw Error("CONFIG_HOST_MISMATCH");
  key = url.searchParams.get("key") ?? lines[index + 1]?.replace(/^sk\s*[:：]\s*/iu, "").trim();
  if (!key) throw Error("CONFIG_KEY_MISSING");
  if (vertex) {
    const probe = await fetch(baseUrl + "/v1/publishers/google/models/" + modelName + ":generateContent", {
      method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "OK" }] }] }), signal: AbortSignal.timeout(40_000),
    });
    if (probe.ok) baseUrl += "/v1/publishers/google";
    else {
      const project = (await probe.text()).match(/projects\/(\d+)\/locations\//u)?.[1];
      if (!project) throw Error("VERTEX_PROJECT_UNRESOLVED_" + probe.status);
      baseUrl += "/v1/projects/" + project + "/locations/global/publishers/google";
    }
  }
}
const pairs = Object.fromEntries(probes.map(probe => [probe[0], renderPair(probe, baseUrl)]));
if (offline) {
  console.log(tier, "fixed-history pair controls verified:", Object.keys(pairs).length);
  process.exit(0);
}
const directory = fileURLToPath(new URL("../../../../test-results/backend-acceptance/role-live/", import.meta.url));
fs.mkdirSync(directory, { recursive: true });
const output = directory + "ablation-" + run + "-" + tier + ".json";
const designHash = hash(JSON.stringify(Object.values(pairs).map(pair => Object.values(pair).map(arm => arm.inputHash))));
const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) :
  { run, tier, modelName, cardHash: hash(card), historyHash: hash(JSON.stringify(historyStudy ? plainHistory : feedbackStudy ? stagedHistory : history)), designHash, tools: [], results: [] };
if (report.designHash !== designHash || report.modelName !== modelName) throw Error("EXISTING_DESIGN_MISMATCH");
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
const model = new HttpModelAdapter({ protocol, baseUrl, provider }, key);
for (let repeat = 1; repeat <= 2; repeat++) {
  for (const [index, [id]] of probes.entries()) {
    const order = historyStudy ? ["plain-history", "staged-history"] : feedbackStudy ? ["ordinary", "feedback"] : ["full", "card"];
    if ((index + repeat) % 2 === 0) order.reverse();
    if (!historyStudy && !feedbackStudy && id !== "quote") order.splice(repeat === 1 ? 1 : 0, 0, "no-format-cue");
    for (const arm of order) {
      if (report.results.some(row => row.id === id && row.repeat === repeat && row.arm === arm && row.complete)) continue;
      const { request, inputHash, systemHash, nonSystemHash, sharedHash } = pairs[id][arm];
      for (let attempt = 1; attempt <= 2; attempt++) {
        currentStatus = null;
        const row = { id, repeat, arm, attempt, inputHash, systemHash, nonSystemHash, sharedHash, complete: false, publicText: "" };
        try {
          for await (const event of model.stream({ ...request, signal: AbortSignal.timeout(95_000) })) {
            if (event.type === "text_delta") row.publicText += event.text;
            if (event.type === "completed") row.complete = !isIncompleteCompletion(event) && Boolean(row.publicText.trim());
          }
        } catch {
          // 厂商错误正文和原始消息可能携带鉴权与推理字段，只保存协议状态。
        }
        row.httpStatus = currentStatus;
        if (id === "quote") row.quoteExact = row.publicText === quote;
        report.results.push(row);
        save();
        console.log(tier, repeat, id, arm, currentStatus, row.complete ? "complete" : "incomplete");
        if (row.complete || (currentStatus !== null && currentStatus !== 429 && currentStatus < 500)) break;
        if (attempt < 2) await delay(12_000);
      }
      if (vertex) await delay(1_000);
    }
  }
}
