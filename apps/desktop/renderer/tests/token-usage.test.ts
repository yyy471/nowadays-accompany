import assert from "node:assert/strict";
import { test } from "node:test";
import * as targetModule from "../src/token-usage.ts";

const load = async () => targetModule;

test("formatTokenCount 与 formatExactTokenCount 适配小额、百万与超 64 位 BigInt", async () => {
  const { formatExactTokenCount, formatTokenCount, parseTokenBigInt } = await load();

  assert.equal(parseTokenBigInt("-10"), 0n);
  assert.equal(parseTokenBigInt("abc"), 0n);
  assert.equal(parseTokenBigInt("12000000000000000000"), 12_000_000_000_000_000_000n);

  assert.equal(formatTokenCount("0"), "0");
  assert.equal(formatTokenCount("1234"), "1,234");
  assert.equal(formatTokenCount("9999"), "9,999");
  assert.equal(formatTokenCount("10000"), "10K");
  assert.equal(formatTokenCount("12540"), "12.5K");
  assert.equal(formatTokenCount("999999"), "999.9K");
  assert.equal(formatTokenCount("1000000"), "1M");
  assert.equal(formatTokenCount("1250000"), "1.25M");
  assert.equal(formatTokenCount("1200000"), "1.2M");
  assert.equal(formatTokenCount("1500000000"), "1.5B");
  assert.equal(formatTokenCount("2500000000000"), "2.5T");

  // 超过 JS 53 位与 SQLite 64 位整数上限仍无损换算与精确输出
  assert.equal(formatTokenCount("12000000000000000000"), "12,000,000T");
  assert.equal(formatExactTokenCount("12000000000000000000"), "12,000,000,000,000,000,000");
  assert.equal(
    formatExactTokenCount("1234567890123456789012345"),
    "1,234,567,890,123,456,789,012,345",
  );
  assert.equal(formatTokenCount("1234567890123456789012345"), "1,234,567,890,123.45T");
});

test("formatCacheHitRate、sharePercent 与 buildTokenUsageQuery 边界准确", async () => {
  const {
    buildTokenUsageQuery,
    categoryLabel,
    formatCacheHitRate,
    sharePercent,
  } = await load();

  assert.equal(formatCacheHitRate("0", "0"), "—");
  assert.equal(formatCacheHitRate("500", "1000"), "50%");
  assert.equal(formatCacheHitRate("431", "1000"), "43.1%");
  assert.equal(formatCacheHitRate("1500", "1000"), "100%");
  assert.equal(formatCacheHitRate("6000000000000000000", "12000000000000000000"), "50%");

  assert.equal(sharePercent("0", "100"), 0);
  assert.equal(sharePercent("1", "0"), 0);
  assert.equal(sharePercent("1", "1000000000000000000"), 1);
  assert.equal(sharePercent("6000000000000000000", "12000000000000000000"), 50);
  assert.equal(sharePercent("12000000000000000000", "12000000000000000000"), 100);

  assert.equal(categoryLabel("autonomy"), "自主生活");
  assert.equal(categoryLabel("scene_plan"), "过场图规划");

  assert.equal(buildTokenUsageQuery({ range: "all" }), "/v1/usage/tokens?range=all");
  assert.equal(
    buildTokenUsageQuery({
      range: "30d",
      roleKey: "__global__",
      category: "connection_test",
      modelKey: "res-1::openai-chat::gpt-4.1",
    }),
    "/v1/usage/tokens?range=30d&roleKey=__global__&category=connection_test&modelKey=res-1%3A%3Aopenai-chat%3A%3Agpt-4.1",
  );
});
