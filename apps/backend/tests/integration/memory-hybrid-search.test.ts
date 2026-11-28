import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
  createBackendApp,
  listen,
  type BackendApp,
  type BackendAppOptions,
} from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import {
  encodeVectorBlob,
  normalizeVector,
  type EmbeddingPort,
} from "../../src/application/memory/memory-hybrid-search.js";
import { localDateFromIso, registerMessageEvidence, sha256 } from "../../src/storage/memory/evidence.js";
import { MemoryStore } from "../../src/storage/memory/memory-store.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";
import { BUSINESS_SCHEMA_VERSION } from "../../src/storage/core/schema.js";

interface Fixture {
  root: string;
  app: BackendApp;
  roleId: string;
  windowId: string;
  dataRoot: string;
  config: ReturnType<typeof parseBackendConfig>;
}

function createFixture(
  options: BackendAppOptions = {},
  hostToken?: string,
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-memory-hybrid-"));
  const baseConfig = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const config = hostToken === undefined ? baseConfig : { ...baseConfig, hostToken };
  const app = createBackendApp(config, {
    disableMemoryRuntime: true,
    ...options,
  });
  const created = app.services.roles.createRole({
    displayName: "混合检索验证角色",
    definition: { text: "一个会回忆的角色。" },
  });
  return {
    root,
    app,
    config,
    roleId: created.roleId,
    windowId: created.defaultWindowId,
    dataRoot: app.config.dataRoot,
  };
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.app.close();
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function withStorage<T>(fixture: Fixture, action: (storage: RoleStorage) => T): T {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.dataRoot, fixture.roleId),
  );
  try {
    return action(storage);
  } finally {
    storage.close();
  }
}

interface SeededEvent {
  eventId: string;
  experienceDate: string;
}

function seedEvent(
  fixture: Fixture,
  input: {
    content: string;
    title: string;
    summary: string;
    occurredAt: string;
    tags?: Record<string, string[]>;
  },
): SeededEvent {
  return withStorage(fixture, (storage) => {
    const db = storage.business.db;
    const submitted = storage.business.submitMessage(fixture.roleId, fixture.windowId, {
      content: input.content,
      submissionId: randomUUID(),
      sourcePlatform: "nowadays",
    });
    db.prepare(
      "UPDATE messages SET created_at = ?, updated_at = ? WHERE message_id = ?",
    ).run(input.occurredAt, input.occurredAt, submitted.message.messageId);
    registerMessageEvidence(db, {
      roleId: fixture.roleId,
      messageIds: [submitted.message.messageId],
      executionId: null,
      timeZone: "Asia/Shanghai",
    });
    const store = new MemoryStore(db);
    const evidence = store
      .listEvidence(fixture.roleId)
      .find((item) => item.sourceId === submitted.message.messageId);
    assert.ok(evidence);
    const experienceDate = localDateFromIso(input.occurredAt, "Asia/Shanghai");
    const event = store.createEvent({
      roleId: fixture.roleId,
      title: input.title,
      summary: input.summary,
      subjectiveExperience: "",
      occurredAtStart: input.occurredAt,
      occurredAtEnd: null,
      experienceDate,
      tags: input.tags ?? {},
      evidenceIds: [evidence.evidenceId],
      currentRound: 0,
      now: input.occurredAt,
    });
    return { eventId: event.eventId, experienceDate };
  });
}

test("V31 升级到 V32 建向量缓存表，删除文档时级联清理", async (t) => {
  const fixture = createFixture();
  const event = seedEvent(fixture, {
    content: "升级前已经入库的一次散步。",
    title: "升级前的散步",
    summary: "沿着河堤走了很久。",
    occurredAt: "2026-09-01T01:00:00.000Z",
  });
  await fixture.app.close();
  const paths = rolePaths(fixture.dataRoot, fixture.roleId);
  const legacy = new Database(paths.businessDatabasePath);
  try {
    legacy.exec("DROP TABLE IF EXISTS memory_search_embeddings; PRAGMA user_version = 31;");
  } finally {
    legacy.close();
  }
  const reopened = createBackendApp(fixture.config, { disableMemoryRuntime: true });
  t.after(async () => {
    await reopened.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const storage = RoleStorage.openExisting(paths);
  try {
    assert.equal(storage.business.schemaVersion, BUSINESS_SCHEMA_VERSION);
    const table = storage.business.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("memory_search_embeddings") as { name: string } | undefined;
    assert.equal(table?.name, "memory_search_embeddings");
    const document = storage.business.db
      .prepare("SELECT document_id FROM memory_search_documents WHERE role_id = ? AND record_id = ?")
      .get(fixture.roleId, event.eventId) as { document_id: number };
    storage.business.db.prepare(
      `INSERT INTO memory_search_embeddings
       (document_id, role_id, model_key, content_hash, dimensions, vector_blob, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      document.document_id,
      fixture.roleId,
      "test:model",
      "hash",
      2,
      encodeVectorBlob(normalizeVector([1, 0])),
      new Date().toISOString(),
    );
    storage.business.db
      .prepare("DELETE FROM memory_search_documents WHERE document_id = ?")
      .run(document.document_id);
    const remaining = storage.business.db
      .prepare("SELECT COUNT(*) AS count FROM memory_search_embeddings WHERE document_id = ?")
      .get(document.document_id) as { count: number };
    assert.equal(remaining.count, 0);
  } finally {
    storage.close();
  }
});

test("未配置时混合检索与纯 FTS5 完全一致，外部调用为零", async (t) => {
  const fixture = createFixture();
  t.after(() => closeFixture(fixture));
  const originalFetch = globalThis.fetch;
  const scopedGlobal = globalThis as unknown as { fetch: typeof fetch };
  let fetchCalls = 0;
  scopedGlobal.fetch = ((...args: Parameters<typeof fetch>) => {
    fetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;
  t.after(() => {
    scopedGlobal.fetch = originalFetch;
  });
  const event = seedEvent(fixture, {
    content: "上周六我和小林去了杭州旧书店。",
    title: "杭州旧书店",
    summary: "角色和小林在杭州旧书店讨论植物书和旧地图。",
    occurredAt: "2026-10-28T01:10:00.000Z",
  });
  const request = { query: "杭州 旧书店" };
  const fts = fixture.app.services.memory.search(fixture.roleId, request);
  const hybrid = await fixture.app.services.memory.searchHybrid(fixture.roleId, request);
  assert.deepEqual(
    hybrid.items.map((item) => item.id),
    fts.items.map((item) => item.id),
  );
  assert.deepEqual(hybrid.items.map((item) => item.id), [event.eventId]);
  assert.equal(fetchCalls, 0, "未配置 Embedding 时不得产生任何外部调用");
  const rows = withStorage(fixture, (storage) =>
    storage.business.db
      .prepare("SELECT COUNT(*) AS count FROM memory_search_embeddings")
      .get() as { count: number });
  assert.equal(rows.count, 0);
});

test("Embedding 端口抛错或超时都静默降级回纯 FTS5", async (t) => {
  const failing: EmbeddingPort = {
    modelKey: "offline:failing",
    async embed() {
      throw new Error("EMBEDDING_NETWORK_FAILED");
    },
  };
  const fixture = createFixture({ embeddingPort: failing });
  t.after(() => closeFixture(fixture));
  const event = seedEvent(fixture, {
    content: "雨天在小巷口吃热汤面。",
    title: "雨天的热汤面",
    summary: "雨下得很大，我们在小巷口吃热汤面。",
    occurredAt: "2026-10-29T01:10:00.000Z",
  });
  const request = { query: "热汤面" };
  const fts = fixture.app.services.memory.search(fixture.roleId, request);
  const hybrid = await fixture.app.services.memory.searchHybrid(fixture.roleId, request);
  assert.deepEqual(
    hybrid.items.map((item) => item.id),
    fts.items.map((item) => item.id),
  );
  assert.deepEqual(hybrid.items.map((item) => item.id), [event.eventId]);

  const hanging: EmbeddingPort = {
    modelKey: "offline:hanging",
    embed() {
      return new Promise<Float32Array[]>(() => {
        // 永不返回：验证检索层自身的超时竞速，而不是依赖端口抛错。
      });
    },
  };
  const timeoutFixture = createFixture({ embeddingPort: hanging });
  t.after(() => closeFixture(timeoutFixture));
  const timedEvent = seedEvent(timeoutFixture, {
    content: "深夜在阳台看流星。",
    title: "阳台流星",
    summary: "深夜在阳台看流星，风有点凉。",
    occurredAt: "2026-10-30T01:10:00.000Z",
  });
  const timed = await timeoutFixture.app.services.memory.searchHybrid(
    timeoutFixture.roleId,
    { query: "流星" },
  );
  assert.deepEqual(timed.items.map((item) => item.id), [timedEvent.eventId]);
});

test("真实本地 /embeddings 端点写入缓存，内容变更后自动重算", async (t) => {
  const requests: string[][] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        input: string[];
      };
      requests.push(payload.input);
      const data = payload.input.map((text, index) => ({
        index,
        embedding: text.includes("海") || text.includes("日出")
          ? [1, 0, 0]
          : [0, 0, 1],
      }));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address() as AddressInfo;

  const fixture = createFixture({}, "test-host-token");
  t.after(() => closeFixture(fixture));
  const event = seedEvent(fixture, {
    content: "清晨去海边看日出。",
    title: "海边日出",
    summary: "我们清晨去海边看日出，海风很凉。",
    occurredAt: "2026-11-01T01:10:00.000Z",
  });
  const resource = fixture.app.services.resources.create({
    kind: "model",
    name: "本地 Embedding 服务",
    config: {
      protocol: "openai-chat",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
  });
  const appPort = await listen(fixture.app.server, 0, fixture.app.config.host);
  const headers = {
    "x-nowadays-host-token": "test-host-token",
    "content-type": "application/json",
  };
  const baseUrl = `http://127.0.0.1:${appPort}`;

  const configured = await fetch(`${baseUrl}/v1/memory/embedding-settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      enabled: true,
      resourceId: resource.resourceId,
      modelName: "text-embedding-test",
    }),
  });
  assert.equal(configured.status, 200);
  const configuredBody = await configured.json() as { settings: { ready: boolean } };
  assert.equal(configuredBody.settings.ready, true);
  const readBack = await fetch(`${baseUrl}/v1/memory/embedding-settings`, { headers });
  assert.equal(readBack.status, 200);

  const search = () => fetch(`${baseUrl}/v1/roles/${fixture.roleId}/memory/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "海边看日出", limit: 5 }),
  });
  const first = await (await search()).json() as { items: Array<{ id: string }> };
  assert.equal(first.items[0]?.id, event.eventId);
  assert.equal(requests.reduce((total, batch) => total + batch.length, 0), 2);
  const rowsAfterFirst = withStorage(fixture, (storage) =>
    storage.business.db
      .prepare("SELECT document_id, content_hash FROM memory_search_embeddings")
      .all() as Array<{ document_id: number; content_hash: string }>);
  assert.equal(rowsAfterFirst.length, 1);

  const second = await (await search()).json() as { items: Array<{ id: string }> };
  assert.equal(second.items[0]?.id, event.eventId);
  assert.equal(requests.at(-1)?.length, 1);
  assert.equal(requests.reduce((total, batch) => total + batch.length, 0), 3);

  const documentId = rowsAfterFirst[0]!.document_id;
  withStorage(fixture, (storage) => {
    storage.business.db.prepare(
      "UPDATE memory_search_documents SET body = ?, updated_at = ? WHERE document_id = ?",
    ).run("后来我们改在书房整理照片。", "2026-11-02T00:00:00.000Z", documentId);
  });
  const third = await (await search()).json() as { items: Array<{ id: string }> };
  assert.equal(third.items[0]?.id, event.eventId);
  assert.equal(requests.at(-1)?.length, 1);
  assert.equal(requests.reduce((total, batch) => total + batch.length, 0), 5);
  const refreshed = withStorage(fixture, (storage) =>
    storage.business.db
      .prepare("SELECT content_hash FROM memory_search_embeddings WHERE document_id = ?")
      .get(documentId) as { content_hash: string });
  assert.equal(refreshed.content_hash, sha256("海边日出\n后来我们改在书房整理照片。"));
});

interface BenchmarkCluster {
  title: string;
  body: string;
  query: string;
  date: string;
  terms: readonly string[];
}

const BENCHMARK_CLUSTERS: readonly BenchmarkCluster[] = [
  { title: "胃疼的夜晚", body: "上次胃疼得睡不着，蜷在床上到天亮。", query: "之前肚子不舒服", date: "2026-09-01", terms: ["胃疼", "肚子", "腹痛"] },
  { title: "海边日出", body: "和恋人清晨去海边看日出，海风很凉。", query: "早起海岸边迎朝阳", date: "2026-09-02", terms: ["海边", "海岸", "日出", "朝阳"] },
  { title: "旧书店淘书", body: "在旧书店淘到一本绝版诗集，纸页发黄。", query: "二手书摊买到稀缺诗歌本", date: "2026-09-03", terms: ["旧书店", "书摊", "诗集", "诗歌", "绝版", "稀缺"] },
  { title: "猫咪打翻热可可", body: "猫咪打翻热可可，地毯湿了一大片。", query: "小猫弄洒巧克力热饮", date: "2026-09-04", terms: ["猫咪", "小猫", "热可可", "巧克力", "热饮"] },
  { title: "雨中登山", body: "和朋友雨中登山，鞋子全湿了。", query: "下雨天爬山下着雨", date: "2026-09-05", terms: ["登山", "爬山", "雨中", "下雨"] },
  { title: "深夜烧烤摊", body: "半夜在路边摊吃烧烤，喝冰啤酒。", query: "凌晨街头撸串配冷饮", date: "2026-09-06", terms: ["烧烤", "撸串", "啤酒", "冷饮", "路边摊", "街头"] },
  { title: "学弹吉他", body: "开始学弹吉他，手指磨出了茧。", query: "拨弦练到手起硬皮", date: "2026-09-07", terms: ["吉他", "拨弦", "硬皮", "茧"] },
  { title: "搬家那天", body: "搬家那天累坏了，新房间朝南。", query: "乔迁新居收拾东西很疲惫", date: "2026-09-08", terms: ["搬家", "乔迁", "新居", "房间"] },
  { title: "公司团建漂流", body: "公司团建去漂流，河水很急。", query: "单位组织划船水势湍急", date: "2026-09-09", terms: ["漂流", "划船", "团建", "水势", "湍急"] },
  { title: "奶奶包饺子", body: "奶奶包了韭菜鸡蛋饺子，很香。", query: "外婆动手包薄皮扁食", date: "2026-09-10", terms: ["奶奶", "外婆", "饺子", "扁食", "韭菜"] },
  { title: "深夜写代码", body: "熬夜写代码，修复了一个老 bug。", query: "通宵编程修补程序错误", date: "2026-09-11", terms: ["代码", "编程", "通宵", "程序", "错误"] },
  { title: "公园放风筝", body: "周末在公园放风筝，线断了。", query: "假日草地放纸鸢线绳缠住树梢", date: "2026-09-12", terms: ["风筝", "纸鸢", "公园", "草地", "线绳"] },
];

class ClusterEmbeddingPort implements EmbeddingPort {
  readonly modelKey = "offline:semantic-benchmark";
  calls = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map((text) =>
      normalizeVector(
        BENCHMARK_CLUSTERS.map((cluster) =>
          cluster.terms.some((term) => text.includes(term)) ? 1 : 0,
        ),
      ));
  }
}

function rankingMetrics(
  results: ReadonlyArray<ReadonlyArray<{ id: string }>>,
  targets: readonly string[],
  k = 3,
): { recallAt3: number; mrr: number } {
  let hits = 0;
  let reciprocal = 0;
  results.forEach((items, index) => {
    const rank = items.findIndex((item) => item.id === targets[index]) + 1;
    if (rank > 0 && rank <= k) {
      hits += 1;
    }
    if (rank > 0) {
      reciprocal += 1 / rank;
    }
  });
  return {
    recallAt3: hits / results.length,
    mrr: reciprocal / results.length,
  };
}

test("固定中文同义改写召回基准：纯 FTS5 漏召回，混合召回精准", async (t) => {
  const port = new ClusterEmbeddingPort();
  const fixture = createFixture({ embeddingPort: port });
  t.after(() => closeFixture(fixture));
  const events = BENCHMARK_CLUSTERS.map((cluster, index) =>
    seedEvent(fixture, {
      content: `第${index + 1}条长期记忆：${cluster.body}`,
      title: cluster.title,
      summary: cluster.body,
      occurredAt: `${cluster.date}T01:00:00.000Z`,
    }));
  const targets = events.map((event) => event.eventId);
  const memory = fixture.app.services.memory;

  const ftsResults = BENCHMARK_CLUSTERS.map((cluster) =>
    memory.search(fixture.roleId, { query: cluster.query, limit: 3 }).items);
  const hybridResults: Array<Array<{ id: string }>> = [];
  for (const cluster of BENCHMARK_CLUSTERS) {
    const outcome = await memory.searchHybrid(
      fixture.roleId,
      { query: cluster.query, limit: 3 },
    );
    hybridResults.push(outcome.items);
  }

  const ftsMetrics = rankingMetrics(ftsResults, targets);
  const hybridMetrics = rankingMetrics(hybridResults, targets);
  assert.ok(
    ftsMetrics.recallAt3 < 0.25,
    `纯 FTS5 同义查询 recall@3 应低于 0.25，实际 ${ftsMetrics.recallAt3}`,
  );
  assert.equal(hybridMetrics.recallAt3, 1);
  assert.ok(
    hybridMetrics.mrr >= 0.9,
    `混合召回 MRR 应不低于 0.9，实际 ${hybridMetrics.mrr}`,
  );

  // 精确字面查询仍应把对应记忆排在首位。
  const exact = await memory.searchHybrid(fixture.roleId, {
    query: "旧书店 绝版诗集",
    limit: 3,
  });
  assert.equal(exact.items[0]?.id, targets[2]);
  assert.ok(
    exact.items.every((item) => item.id === targets[2]),
    "精确字面查询不得混入不相关记忆",
  );

  // 时间过滤必须生效：只返回指定日期内的记忆，且目标仍被召回。
  const filtered = await memory.searchHybrid(fixture.roleId, {
    query: BENCHMARK_CLUSTERS[0]!.query,
    dateFrom: BENCHMARK_CLUSTERS[0]!.date,
    dateTo: BENCHMARK_CLUSTERS[0]!.date,
    limit: 3,
  });
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0]?.id, targets[0]);
  assert.ok(
    filtered.items.every((item) => item.experienceDate === BENCHMARK_CLUSTERS[0]!.date),
    "混合检索不得绕过日期过滤",
  );
});
