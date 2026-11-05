// 只诊断失败原因，不修改提示词、返回结果或业务库。
import fs from "node:fs";
import path from "node:path";
import { HttpModelAdapter } from "../src/model/protocols.js";
import { memoryFormationResponseSchema } from "../src/domain/memory.js";

const credentialPath = process.env.NOWADAYS_ACCEPTANCE_CREDENTIAL_FILE;
const outputPath = process.env.NOWADAYS_REVIEW_OUTPUT;
if (!credentialPath || !outputPath) throw new Error("EXPLICIT_CREDENTIAL_AND_OUTPUT_REQUIRED");
const key = fs.readFileSync(credentialPath, "utf8").trim();
const output = path.resolve(outputPath);
const report = JSON.parse(fs.readFileSync(path.join(output, "real-model-report.json"), "utf8"));
const memory = report.results.find((item: { id: string }) => item.id === "M06-real-memory-formation");
const original = JSON.parse(memory.observed.output);
const parsed = memoryFormationResponseSchema.safeParse(original);
const candidate = structuredClone(original);
const mapping = { people: "person", topics: "topic", places: "place", emotions: "emotion", sources: "source" };
for (const operation of candidate.operations) {
  if (!operation.tags) continue;
  for (const [from, to] of Object.entries(mapping)) {
    if (from in operation.tags) { operation.tags[to] = operation.tags[from]; delete operation.tags[from]; }
  }
}
const remapped = memoryFormationResponseSchema.safeParse(candidate);
const actualFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.deepseek.com") throw new Error("UNEXPECTED_UPSTREAM");
  return actualFetch(input, { ...init, signal: AbortSignal.timeout(60_000) });
};
const results: unknown[] = [];
try {
  const adapter = new HttpModelAdapter({ protocol: "anthropic-messages", baseUrl: "https://api.deepseek.com/anthropic" }, key);
  for (const limit of [16, 1024]) {
    let text = "";
    let completion: unknown;
    let usage: unknown;
    for await (const event of adapter.stream({ modelName: "deepseek-flash", system: "Reply with the single word pong.", messages: [{ role: "user", content: "ping" }], tools: [], maxOutputTokens: limit })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "usage") usage = event;
      if (event.type === "completed") completion = { stopReason: event.stopReason, incomplete: event.incomplete ?? false };
    }
    results.push({ maxOutputTokens: limit, text, completion, usage });
  }
  const result = {
    paidRequestsStarted: 2,
    connectionDiagnostics: results,
    memoryDiagnostics: {
      originalValid: parsed.success,
      issues: parsed.success ? [] : parsed.error.issues,
      originalTagKeys: Object.keys(original.operations[0].tags),
      remapForDiagnosisOnly: mapping,
      remappedValid: remapped.success,
      persistedRemappedData: false,
    },
  };
  fs.writeFileSync(path.join(output, "real-diagnostics-report.json"), JSON.stringify(result, null, 2).replaceAll(key, "[REDACTED]"));
  console.log(JSON.stringify(result, null, 2).replaceAll(key, "[REDACTED]"));
} finally { globalThis.fetch = actualFetch; }
