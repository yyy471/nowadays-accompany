import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelSpec } from "../src/worker.mjs";

test("未指定模型参数时按协议补齐默认值与关闭思考", () => {
  assert.deepEqual(resolveModelSpec({ modelName: "gpt", apiFlavor: "openai-completions" }), {
    modelId: "gpt", maxTokens: 16384, contextWindow: 128000, thinkingLevel: "off", reasoning: false,
  });
  for (const apiFlavor of ["anthropic-messages", "google-generative-ai", "google-vertex", "openai-responses"]) {
    assert.deepEqual(resolveModelSpec({ modelName: "model", apiFlavor }), {
      modelId: "model", maxTokens: 32768, contextWindow: 200000, thinkingLevel: "off", reasoning: false,
    }, apiFlavor);
  }
});

test("显式模型参数原样透传并开启 reasoning", () => {
  const spec = resolveModelSpec({
    modelName: "models/gemini-2.5-pro", apiFlavor: "google-generative-ai",
    maxTokens: 32768, contextWindow: 1_000_000, thinkingLevel: "medium",
  });
  assert.deepEqual(spec, {
    modelId: "gemini-2.5-pro", maxTokens: 32768, contextWindow: 1_000_000, thinkingLevel: "medium", reasoning: true,
  });
});

test("越界或非法参数回退到协议默认值", () => {
  const spec = resolveModelSpec({
    modelName: "model", apiFlavor: "openai-completions",
    maxTokens: 10, contextWindow: 1, thinkingLevel: "max",
  });
  assert.deepEqual(spec, {
    modelId: "model", maxTokens: 16384, contextWindow: 128000, thinkingLevel: "off", reasoning: false,
  });
});
