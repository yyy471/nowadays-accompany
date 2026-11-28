import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import {
  createBackendApp,
  listen,
  type BackendApp,
  type BackendAppOptions,
} from "../../src/bootstrap/app.js";
import { parseBackendConfig, rolePaths } from "../../src/bootstrap/config.js";
import {
  cosineSimilarityWithBlob,
  EMBEDDING_SPACE_KEY_PREFIX,
  encodeVectorBlob,
  embeddingSpaceKey,
  HttpOpenAiEmbeddingPort,
  isEmbeddingCompatibleProtocol,
  MAX_EMBEDDING_RESPONSE_BYTES,
  normalizeVector,
  validateEmbeddingBaseUrl,
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

interface SeedEventInput {
  content: string;
  title: string;
  summary: string;
  occurredAt: string;
  tags?: Record<string, string[]>;
}

/** 单连接批量落库，避免大量事件逐条开关 SQLite 连接拖慢测试。 */
function seedEvents(
  fixture: Fixture,
  inputs: ReadonlyArray<SeedEventInput>,
): SeededEvent[] {
  return withStorage(fixture, (storage) => {
    const db = storage.business.db;
    const store = new MemoryStore(db);
    return inputs.map((input): SeededEvent => {
      const submitted = storage.business.submitMessage(
        fixture.roleId,
        fixture.windowId,
        {
          content: input.content,
          submissionId: randomUUID(),
          sourcePlatform: "nowadays",
        },
      );
      db.prepare(
        "UPDATE messages SET created_at = ?, updated_at = ? WHERE message_id = ?",
      ).run(input.occurredAt, input.occurredAt, submitted.message.messageId);
      registerMessageEvidence(db, {
        roleId: fixture.roleId,
        messageIds: [submitted.message.messageId],
        executionId: null,
        timeZone: "Asia/Shanghai",
      });
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
  });
}

function seedEvent(
  fixture: Fixture,
  input: SeedEventInput,
): SeededEvent {
  return seedEvents(fixture, [input])[0]!;
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

// ---------------------------------------------------------------------------
// R2-02：重定向拦截、响应上限、跨协议校验、维护守卫、账本与有界回填
// ---------------------------------------------------------------------------

interface MockEmbeddingServer {
  baseUrl: string;
  requests: Array<{ path: string; body: unknown }>;
  close(): Promise<void>;
}

async function startMockEmbeddingServer(
  handler: (input: {
    body: unknown;
    index: number;
    response: http.ServerResponse;
  }) => void,
): Promise<MockEmbeddingServer> {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ path: request.url ?? "", body });
      handler({ body, index: requests.length - 1, response });
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function inputTextsOf(body: unknown): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const input = (body as { input?: unknown }).input;
  return Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string")
    : [];
}

function embeddingResponseBody(
  input: readonly string[],
  usage?: { prompt_tokens: number; total_tokens?: number },
): string {
  return JSON.stringify({
    data: input.map((text, index) => ({
      index,
      embedding: text.includes("海") || text.includes("日出") ? [1, 0, 0] : [0, 0, 1],
    })),
    ...(usage === undefined ? {} : { usage }),
  });
}

async function startAppServer(
  fixture: Fixture,
  hostToken: string,
): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const port = await listen(fixture.app.server, 0, fixture.app.config.host);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    headers: {
      "x-nowadays-host-token": hostToken,
      "content-type": "application/json",
    },
  };
}

async function configureEmbedding(
  baseUrl: string,
  headers: Record<string, string>,
  resourceId: string,
  modelName: string,
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/memory/embedding-settings`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ enabled: true, resourceId, modelName }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { settings: { ready: boolean } };
  assert.equal(body.settings.ready, true);
}

interface TokenTotalsView {
  totals: {
    inputTokens: string;
    totalTokens: string;
    callCount: string;
  };
}

async function readTokenTotals(
  baseUrl: string,
  headers: Record<string, string>,
  category?: string,
): Promise<TokenTotalsView> {
  const params = new URLSearchParams({ range: "today" });
  if (category !== undefined) {
    params.set("category", category);
  }
  const response = await fetch(
    `${baseUrl}/v1/usage/tokens?${params.toString()}`,
    { headers },
  );
  assert.equal(response.status, 200);
  return await response.json() as TokenTotalsView;
}

function embeddingRowCount(fixture: Fixture): number {
  return withStorage(
    fixture,
    (storage) =>
      (storage.business.db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_search_embeddings WHERE role_id = ?",
        )
        .get(fixture.roleId) as { count: number }).count,
  );
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // 后台任务可能正在写库，重试即可。
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`WAIT_TIMEOUT_${timeoutMs}`);
  }
}

test("R2-02 302 重定向被拒绝：端口报错、连接测试 502、检索静默回退 FTS5", async (t) => {
  const redirectTarget = await startMockEmbeddingServer(({ response }) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
  });
  t.after(() => redirectTarget.close());
  const redirecting = await startMockEmbeddingServer(({ response }) => {
    response.writeHead(302, {
      location: `${redirectTarget.baseUrl}/v1/embeddings`,
    });
    response.end();
  });
  t.after(() => redirecting.close());

  const directPort = new HttpOpenAiEmbeddingPort({
    modelKey: "direct:redirect",
    baseUrl: `${redirecting.baseUrl}/v1`,
    modelName: "text-embedding-test",
  });
  await assert.rejects(
    directPort.embed(["hello"]),
    /EMBEDDING_REDIRECT_BLOCKED/,
  );

  const fixture = createFixture({}, "test-host-token");
  t.after(() => closeFixture(fixture));
  const { baseUrl, headers } = await startAppServer(fixture, "test-host-token");
  const resource = fixture.app.services.resources.create({
    kind: "model",
    name: "重定向 Embedding 服务",
    config: {
      protocol: "openai-chat",
      baseUrl: `${redirecting.baseUrl}/v1`,
    },
  });
  await configureEmbedding(
    baseUrl,
    headers,
    resource.resourceId,
    "text-embedding-test",
  );

  const testResponse = await fetch(
    `${baseUrl}/v1/memory/embedding-settings/test`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        resourceId: resource.resourceId,
        modelName: "text-embedding-test",
      }),
    },
  );
  assert.equal(testResponse.status, 502);
  const testBody = await testResponse.json() as {
    error: { code: string; message: string };
  };
  assert.equal(testBody.error.code, "EMBEDDING_TEST_FAILED");

  const event = seedEvent(fixture, {
    content: "周末在杭州旧书店翻到一张旧地图。",
    title: "杭州旧书店",
    summary: "我们在杭州旧书店讨论植物书和旧地图。",
    occurredAt: "2026-10-28T01:10:00.000Z",
  });
  const request = { query: "杭州 旧书店" };
  const fts = fixture.app.services.memory.search(fixture.roleId, request);
  const hybrid = await fixture.app.services.memory.searchHybrid(
    fixture.roleId,
    request,
  );
  assert.deepEqual(
    hybrid.items.map((item) => item.id),
    fts.items.map((item) => item.id),
  );
  assert.deepEqual(hybrid.items.map((item) => item.id), [event.eventId]);
  assert.equal(
    redirectTarget.requests.length,
    0,
    "不得跟随重定向访问目标地址",
  );
});

test("R2-02 响应体超过上限时在 JSON.parse 之前拒绝", async (t) => {
  assert.equal(MAX_EMBEDDING_RESPONSE_BYTES, 16 * 1024 * 1024);
  const maxResponseBytes = 1024;

  // 带 content-length：走声明长度短路。
  const declared = await startMockEmbeddingServer(({ response }) => {
    const body = `{"data":${"x".repeat(4096)}}`;
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  t.after(() => declared.close());
  const declaredPort = new HttpOpenAiEmbeddingPort({
    modelKey: "direct:declared-too-large",
    baseUrl: `${declared.baseUrl}/v1`,
    modelName: "m",
    maxResponseBytes,
  });
  await assert.rejects(
    declaredPort.embed(["a"]),
    /EMBEDDING_RESPONSE_TOO_LARGE/,
  );

  // 无 content-length（chunked）：走增量字节计数，且正文仍是非法 JSON，
  // 若先 JSON.parse 会得到 EMBEDDING_RESPONSE_INVALID，证明上限检查更早。
  const streamed = await startMockEmbeddingServer(({ response }) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"data":');
    response.end(`${"x".repeat(4096)}}`);
  });
  t.after(() => streamed.close());
  const streamedPort = new HttpOpenAiEmbeddingPort({
    modelKey: "direct:streamed-too-large",
    baseUrl: `${streamed.baseUrl}/v1`,
    modelName: "m",
    maxResponseBytes,
  });
  await assert.rejects(
    streamedPort.embed(["a"]),
    /EMBEDDING_RESPONSE_TOO_LARGE/,
  );
});

test("R2-02 跨协议配置被拒绝，OpenAI 兼容连接测试成功并记入 connection_test", async (t) => {
  assert.equal(isEmbeddingCompatibleProtocol("openai-chat"), true);
  assert.equal(isEmbeddingCompatibleProtocol("openai-responses"), true);
  assert.equal(isEmbeddingCompatibleProtocol("anthropic-messages"), false);
  assert.equal(isEmbeddingCompatibleProtocol("google-gemini"), false);
  assert.equal(validateEmbeddingBaseUrl("http://example.test/v1///"), "http://example.test/v1");
  assert.throws(
    () => validateEmbeddingBaseUrl("ftp://example.test/v1"),
    /EMBEDDING_BASE_URL_INVALID/,
  );
  assert.throws(
    () => validateEmbeddingBaseUrl("http://user:pass@example.test/v1"),
    /EMBEDDING_BASE_URL_INVALID/,
  );

  const mock = await startMockEmbeddingServer(({ body, index, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      embeddingResponseBody(
        input.length === 0 ? ["check"] : input,
        index === 0 ? { prompt_tokens: 7, total_tokens: 7 } : undefined,
      ),
    );
  });
  t.after(() => mock.close());

  const fixture = createFixture({}, "test-host-token");
  t.after(() => closeFixture(fixture));
  const { baseUrl, headers } = await startAppServer(fixture, "test-host-token");
  const resources = fixture.app.services.resources;

  for (const protocol of ["anthropic-messages", "google-gemini"] as const) {
    const resource = resources.create({
      kind: "model",
      name: `不兼容协议 ${protocol}`,
      config: { protocol, baseUrl: "http://127.0.0.1:1/v1" },
    });
    const response = await fetch(`${baseUrl}/v1/memory/embedding-settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        enabled: true,
        resourceId: resource.resourceId,
        modelName: "text-embedding-test",
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: { code: string } };
    assert.equal(body.error.code, "EMBEDDING_SETTINGS_INVALID");
  }

  const compatible = resources.create({
    kind: "model",
    name: "兼容 Embedding 服务",
    config: { protocol: "openai-chat", baseUrl: `${mock.baseUrl}/v1` },
  });
  const testResponse = await fetch(
    `${baseUrl}/v1/memory/embedding-settings/test`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        resourceId: compatible.resourceId,
        modelName: "text-embedding-test",
      }),
    },
  );
  assert.equal(testResponse.status, 200);
  const testBody = await testResponse.json() as {
    result: { ok: boolean; dimensions: number; modelName: string };
  };
  assert.deepEqual(testBody.result, {
    ok: true,
    dimensions: 3,
    modelName: "text-embedding-test",
  });
  assert.equal(mock.requests.length, 1);
  const usage = await readTokenTotals(baseUrl, headers, "connection_test");
  assert.equal(usage.totals.inputTokens, "7");
  assert.equal(usage.totals.callCount, "1");

  // 维护期间连接测试同样立即拒绝且不触网。
  resources.beginMaintenance(compatible.resourceId);
  try {
    const blocked = await fetch(
      `${baseUrl}/v1/memory/embedding-settings/test`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          resourceId: compatible.resourceId,
          modelName: "text-embedding-test",
        }),
      },
    );
    assert.equal(blocked.status, 409);
    const blockedBody = await blocked.json() as { error: { code: string } };
    assert.equal(blockedBody.error.code, "RESOURCE_UNDER_MAINTENANCE");
  } finally {
    resources.endMaintenance(compatible.resourceId);
  }
  assert.equal(mock.requests.length, 1, "维护期间不得发出任何连接测试请求");
});

test("R2-02 混合检索用量入账，维护期零请求静默回退 FTS5", async (t) => {
  const mock = await startMockEmbeddingServer(({ body, index, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      embeddingResponseBody(
        input.length === 0 ? ["check"] : input,
        index === 0 ? { prompt_tokens: 42, total_tokens: 42 } : undefined,
      ),
    );
  });
  t.after(() => mock.close());

  const fixture = createFixture({}, "test-host-token");
  t.after(() => closeFixture(fixture));
  const { baseUrl, headers } = await startAppServer(fixture, "test-host-token");
  const resource = fixture.app.services.resources.create({
    kind: "model",
    name: "入账 Embedding 服务",
    config: { protocol: "openai-chat", baseUrl: `${mock.baseUrl}/v1` },
  });
  await configureEmbedding(
    baseUrl,
    headers,
    resource.resourceId,
    "text-embedding-test",
  );
  const event = seedEvent(fixture, {
    content: "清晨去海边看日出，海风很凉。",
    title: "海边日出",
    summary: "我们清晨去海边看日出。",
    occurredAt: "2026-11-01T01:10:00.000Z",
  });
  const request = { query: "海边 日出" };

  const before = await readTokenTotals(baseUrl, headers, "memory");
  const hybrid = await fixture.app.services.memory.searchHybrid(
    fixture.roleId,
    request,
  );
  assert.ok(hybrid.items.some((item) => item.id === event.eventId));
  const after = await readTokenTotals(baseUrl, headers, "memory");
  assert.equal(
    Number(after.totals.inputTokens) - Number(before.totals.inputTokens),
    42,
    "Embedding usage.prompt_tokens 必须进入 memory 用途账本",
  );
  assert.ok(mock.requests.length >= 2);

  const requestsBeforeMaintenance = mock.requests.length;
  fixture.app.services.resources.beginMaintenance(resource.resourceId);
  try {
    const fts = fixture.app.services.memory.search(fixture.roleId, request);
    const during = await fixture.app.services.memory.searchHybrid(
      fixture.roleId,
      request,
    );
    assert.deepEqual(
      during.items.map((item) => item.id),
      fts.items.map((item) => item.id),
    );
  } finally {
    fixture.app.services.resources.endMaintenance(resource.resourceId);
  }
  assert.equal(
    mock.requests.length,
    requestsBeforeMaintenance,
    "维护期间不得向 /embeddings 发出任何请求",
  );
});

class PartialBatchEmbeddingPort implements EmbeddingPort {
  readonly modelKey = "offline:partial-batch";
  calls = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    // 第 1 次是查询向量，第 2 次是首批文档；之后全部失败。
    if (this.calls <= 2) {
      return texts.map(() => normalizeVector([1, 0, 0]));
    }
    throw new Error("EMBEDDING_NETWORK_FAILED");
  }
}

test("R2-02 批次中途失败不丢已算向量（增量落盘）", async (t) => {
  const port = new PartialBatchEmbeddingPort();
  const fixture = createFixture({
    embeddingPort: port,
    embeddingBatchSize: 10,
    onlineBackfillMaxBatches: 2,
    embeddingBatchTimeoutMs: 500,
  });
  t.after(() => closeFixture(fixture));

  const inputs: SeedEventInput[] = Array.from({ length: 50 }, (_, index) => ({
    content: index === 0
      ? "目标记忆：在河边散步时想起旧事。"
      : `普通记忆第 ${index + 1} 条：日常散步记录。`,
    title: index === 0 ? "目标记忆" : `普通记忆 ${index + 1}`,
    summary: `第 ${index + 1} 条测试记忆。`,
    occurredAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
  }));
  seedEvents(fixture, inputs);

  const hybrid = await fixture.app.services.memory.searchHybrid(
    fixture.roleId,
    { query: "目标记忆", limit: 5 },
  );
  assert.ok(hybrid.items.length > 0, "批次失败不得中断检索");
  assert.equal(
    port.calls,
    3,
    "查询 + 首批成功、第二批失败后应立即停止在线补算",
  );
  assert.equal(
    embeddingRowCount(fixture),
    10,
    "首批 10 条向量必须已增量落盘，不能因第二批失败而丢失",
  );
});

class CountingEmbeddingPort implements EmbeddingPort {
  readonly modelKey = "offline:counting";
  calls = 0;

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls += 1;
    return texts.map(() => normalizeVector([1, 0, 0]));
  }
}

test("R2-02 在线补算有界，后台回填补齐剩余向量并在关闭时收尾", async (t) => {
  const port = new CountingEmbeddingPort();
  const fixture = createFixture({
    embeddingPort: port,
    embeddingBatchSize: 20,
    onlineBackfillMaxBatches: 2,
    embeddingBatchTimeoutMs: 1000,
  });
  t.after(() => closeFixture(fixture));
  // R3-11：后台回填只在角色活动时运行。
  fixture.app.services.activity.resume(fixture.roleId);

  seedEvents(
    fixture,
    Array.from({ length: 200 }, (_, index) => ({
      content: `批量记忆第 ${index + 1} 条内容。`,
      title: `批量记忆 ${index + 1}`,
      summary: `批量记忆第 ${index + 1} 条的摘要。`,
      occurredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    })),
  );

  const startedAt = Date.now();
  const outcome = await fixture.app.services.memory.searchHybrid(
    fixture.roleId,
    { query: "批量记忆", limit: 10 },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(outcome.items.length > 0);
  assert.ok(
    elapsed < 5000,
    `首轮检索不应等待全部 200 条文档，实际 ${elapsed}ms`,
  );
  assert.equal(
    port.calls,
    3,
    "实时路径只允许查询向量 + 最多 2 批文档向量",
  );
  assert.equal(
    embeddingRowCount(fixture),
    40,
    "首轮只同步落盘 2 批，剩余交给后台",
  );

  await waitForCondition(() => embeddingRowCount(fixture) === 200, 15_000);
  assert.equal(embeddingRowCount(fixture), 200, "后台回填应补齐全部向量");
  assert.equal(port.calls, 11, "查询 1 次 + 在线 2 批 + 后台 8 批");

  // close 应等待后台任务收尾且不抛错；重复关闭保持幂等。
  await fixture.app.close();
});

// ---------------------------------------------------------------------------
// R3-04：版本化向量空间指纹；R3-11：后台回填生命周期与资源影响
// ---------------------------------------------------------------------------

interface StoredEmbeddingRow {
  document_id: number;
  model_key: string;
  dimensions: number;
  content_hash: string;
  vector_blob: Buffer;
}

function embeddingRows(fixture: Fixture): StoredEmbeddingRow[] {
  return withStorage(
    fixture,
    (storage) =>
      storage.business.db
        .prepare(
          `SELECT document_id, model_key, dimensions, content_hash, vector_blob
           FROM memory_search_embeddings WHERE role_id = ?`,
        )
        .all(fixture.roleId) as StoredEmbeddingRow[],
  );
}

function configureEmbeddingDirect(
  fixture: Fixture,
  resourceId: string,
  modelName = "text-embedding-test",
): void {
  fixture.app.services.memoryEmbeddingSettings.update({
    enabled: true,
    resourceId,
    modelName,
  });
}

test("R3-04 同资源同模型切换同维端点后使用新向量空间缓存", async (t) => {
  const serverA = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
    );
  });
  t.after(() => serverA.close());
  const serverB = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [0, 1, 0] })),
      }),
    );
  });
  t.after(() => serverB.close());

  const fixture = createFixture();
  t.after(() => closeFixture(fixture));
  const resources = fixture.app.services.resources;
  const resource = resources.create({
    kind: "model",
    name: "同维 Embedding 服务",
    config: { protocol: "openai-chat", baseUrl: `${serverA.baseUrl}/v1` },
  });
  configureEmbeddingDirect(fixture, resource.resourceId);
  const event = seedEvent(fixture, {
    content: "清晨去海边看日出，海风很凉。",
    title: "海边日出",
    summary: "我们清晨去海边看日出。",
    occurredAt: "2026-11-01T01:10:00.000Z",
  });

  const memory = fixture.app.services.memory;
  const request = { query: "海边日出", limit: 5 };
  await memory.searchHybrid(fixture.roleId, request);
  const firstRows = embeddingRows(fixture);
  assert.equal(firstRows.length, 1);
  const keyA = firstRows[0]!.model_key;
  assert.ok(keyA.startsWith(EMBEDDING_SPACE_KEY_PREFIX));
  assert.notEqual(
    keyA,
    `${resource.resourceId}:text-embedding-test`,
    "旧版「资源:模型」缓存键必须失效",
  );
  assert.equal(firstRows[0]!.dimensions, 3);
  assert.equal(serverA.requests.length, 2);

  // 同一资源、同一模型别名，仅切换端点：新空间必须重新向量化。
  resources.update(resource.resourceId, {
    config: { protocol: "openai-chat", baseUrl: `${serverB.baseUrl}/v1` },
  });
  await memory.searchHybrid(fixture.roleId, request);
  const secondRows = embeddingRows(fixture);
  const keyB = secondRows[0]!.model_key;
  assert.notEqual(keyB, keyA);
  assert.equal(secondRows[0]!.dimensions, 3);
  assert.equal(serverB.requests.length, 2, "新端点必须重新计算查询与文档向量");

  // 新空间命中自己的缓存，不再重复请求文档向量。
  await memory.searchHybrid(fixture.roleId, request);
  assert.equal(serverB.requests.length, 3);

  // 切回原端点同样得到全新的空间键，不复用 B 空间缓存。
  resources.update(resource.resourceId, {
    config: { protocol: "openai-chat", baseUrl: `${serverA.baseUrl}/v1` },
  });
  const back = await memory.searchHybrid(fixture.roleId, request);
  assert.ok(back.items.some((item) => item.id === event.eventId));
  assert.equal(serverA.requests.length, 4);
  assert.equal(embeddingRows(fixture)[0]!.model_key, keyA);
});

test("R3-04 共享同一地址与模型的另一资源不复用旧向量空间", async (t) => {
  const server = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
    );
  });
  t.after(() => server.close());

  const fixture = createFixture();
  t.after(() => closeFixture(fixture));
  const resources = fixture.app.services.resources;
  const memory = fixture.app.services.memory;
  const config = { protocol: "openai-chat" as const, baseUrl: `${server.baseUrl}/v1` };
  const first = resources.create({
    kind: "model",
    name: "凭据上下文 A",
    config,
  });
  const second = resources.create({
    kind: "model",
    name: "凭据上下文 B",
    config,
  });
  configureEmbeddingDirect(fixture, first.resourceId);
  seedEvent(fixture, {
    content: "清晨去海边看日出。",
    title: "海边日出",
    summary: "我们清晨去海边看日出。",
    occurredAt: "2026-11-01T01:10:00.000Z",
  });
  const request = { query: "海边日出", limit: 5 };

  await memory.searchHybrid(fixture.roleId, request);
  const keyA = embeddingRows(fixture)[0]!.model_key;
  assert.equal(server.requests.length, 2);

  configureEmbeddingDirect(fixture, second.resourceId);
  await memory.searchHybrid(fixture.roleId, request);
  const keyB = embeddingRows(fixture)[0]!.model_key;
  assert.notEqual(keyB, keyA, "不同资源必须得到独立缓存键");
  assert.equal(
    server.requests.length,
    4,
    "新资源必须重新计算查询与文档向量，不能复用旧资源缓存",
  );

  await memory.searchHybrid(fixture.roleId, request);
  assert.equal(server.requests.length, 5, "新资源自己的缓存可以复用");
});

test("R3-04 同缓存键返回维度漂移的文档向量时整批放弃", async (t) => {
  let calls = 0;
  const port: EmbeddingPort = {
    modelKey: "offline:dimension-drift",
    async embed(texts) {
      calls += 1;
      const values = calls === 1 ? [1, 0, 0] : [1, 0];
      return texts.map(() => normalizeVector(values));
    },
  };
  const fixture = createFixture({
    embeddingPort: port,
    embeddingBatchSize: 10,
    embeddingBatchTimeoutMs: 500,
  });
  t.after(() => closeFixture(fixture));
  const event = seedEvent(fixture, {
    content: "清晨去海边看日出。",
    title: "海边日出",
    summary: "我们清晨去海边看日出。",
    occurredAt: "2026-11-01T01:10:00.000Z",
  });
  const request = { query: "海边日出", limit: 5 };
  const fts = fixture.app.services.memory.search(fixture.roleId, request);
  const hybrid = await fixture.app.services.memory.searchHybrid(
    fixture.roleId,
    request,
  );
  assert.deepEqual(
    hybrid.items.map((item) => item.id),
    fts.items.map((item) => item.id),
  );
  assert.deepEqual(hybrid.items.map((item) => item.id), [event.eventId]);
  assert.equal(calls, 2, "查询向量与首批文档向量各调用一次");
  assert.equal(
    embeddingRowCount(fixture),
    0,
    "与查询维度不符的返回向量不得写入缓存或参与融合",
  );
});

test("R3-04 异维端点切换后旧向量不复用，维度失配重新回填", async (t) => {
  const server3d = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
    );
  });
  t.after(() => server3d.close());
  const server2d = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, 0] })),
      }),
    );
  });
  t.after(() => server2d.close());

  const fixture = createFixture();
  t.after(() => closeFixture(fixture));
  const resources = fixture.app.services.resources;
  const memory = fixture.app.services.memory;
  const resource = resources.create({
    kind: "model",
    name: "异维 Embedding 服务",
    config: { protocol: "openai-chat", baseUrl: `${server3d.baseUrl}/v1` },
  });
  configureEmbeddingDirect(fixture, resource.resourceId);
  seedEvent(fixture, {
    content: "清晨去海边看日出。",
    title: "海边日出",
    summary: "我们清晨去海边看日出。",
    occurredAt: "2026-11-01T01:10:00.000Z",
  });
  const request = { query: "海边日出", limit: 5 };

  await memory.searchHybrid(fixture.roleId, request);
  assert.equal(embeddingRows(fixture)[0]!.dimensions, 3);

  resources.update(resource.resourceId, {
    config: { protocol: "openai-chat", baseUrl: `${server2d.baseUrl}/v1` },
  });
  await memory.searchHybrid(fixture.roleId, request);
  const switched = embeddingRows(fixture)[0]!;
  assert.equal(switched.dimensions, 2, "新空间按新端点维度落库");
  assert.equal(server2d.requests.length, 2);

  await memory.searchHybrid(fixture.roleId, request);
  assert.equal(server2d.requests.length, 3, "同空间缓存应可复用");

  // 即使缓存键未变，维度与当前查询不符的旧向量也必须重新回填。
  withStorage(fixture, (storage) => {
    storage.business.db
      .prepare(
        `UPDATE memory_search_embeddings
         SET dimensions = ?, vector_blob = ? WHERE document_id = ?`,
      )
      .run(
        3,
        encodeVectorBlob(normalizeVector([1, 0, 0])),
        switched.document_id,
      );
  });
  await memory.searchHybrid(fixture.roleId, request);
  assert.equal(server2d.requests.length, 5, "维度失配必须重新向量化文档");
  assert.equal(embeddingRows(fixture)[0]!.dimensions, 2);
});

test("R3-11 停止角色不调度后台回填，恢复活动后继续补齐", async (t) => {
  const port = new CountingEmbeddingPort();
  const fixture = createFixture({
    embeddingPort: port,
    embeddingBatchSize: 10,
    onlineBackfillMaxBatches: 0,
    embeddingBatchTimeoutMs: 1000,
  });
  t.after(() => closeFixture(fixture));
  seedEvents(
    fixture,
    Array.from({ length: 25 }, (_, index) => ({
      content: `停启记忆第 ${index + 1} 条。`,
      title: `停启记忆 ${index + 1}`,
      summary: `停启记忆第 ${index + 1} 条摘要。`,
      occurredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    })),
  );
  const memory = fixture.app.services.memory;
  const request = { query: "停启记忆", limit: 5 };

  await memory.searchHybrid(fixture.roleId, request);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(embeddingRowCount(fixture), 0, "已停止角色不得启动后台回填");
  assert.equal(memory.isBackfilling(fixture.roleId), false);

  fixture.app.services.activity.resume(fixture.roleId);
  await memory.searchHybrid(fixture.roleId, request);
  await waitForCondition(() => embeddingRowCount(fixture) === 25, 10_000);
  assert.equal(embeddingRowCount(fixture), 25);
  await waitForCondition(() => !memory.isBackfilling(fixture.roleId), 5_000);
});

interface HangingEmbeddingServer extends MockEmbeddingServer {
  pending: http.ServerResponse[];
}

async function startHangingDocumentServer(
  query: string,
): Promise<HangingEmbeddingServer> {
  const pending: http.ServerResponse[] = [];
  const base = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    if (input.length === 1 && input[0] === query) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
      );
      return;
    }
    // 文档向量请求挂起：由测试决定取消或收尾。
    pending.push(response);
  });
  return { ...base, pending };
}

function flushHangingResponses(server: HangingEmbeddingServer): void {
  for (const response of server.pending) {
    try {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
      );
    } catch {
      // 传输已由取消关闭。
    }
  }
}

async function startActiveHangingFixture(
  t: TestContext,
  query: string,
): Promise<{
  fixture: Fixture;
  server: HangingEmbeddingServer;
  resourceId: string;
  query: { query: string; limit: number };
}> {
  const server = await startHangingDocumentServer(query);
  t.after(async () => {
    flushHangingResponses(server);
    await server.close();
  });
  const fixture = createFixture({
    onlineBackfillMaxBatches: 0,
    embeddingBatchSize: 2,
    embeddingBatchTimeoutMs: 30_000,
  });
  t.after(() => closeFixture(fixture));
  fixture.app.services.activity.resume(fixture.roleId);
  const resource = fixture.app.services.resources.create({
    kind: "model",
    name: "挂起 Embedding 服务",
    config: { protocol: "openai-chat", baseUrl: `${server.baseUrl}/v1` },
  });
  configureEmbeddingDirect(fixture, resource.resourceId);
  seedEvents(
    fixture,
    Array.from({ length: 6 }, (_, index) => ({
      content: `挂起记忆第 ${index + 1} 条。`,
      title: `挂起记忆 ${index + 1}`,
      summary: `挂起记忆第 ${index + 1} 条摘要。`,
      occurredAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
    })),
  );
  const request = { query, limit: 5 };
  await fixture.app.services.memory.searchHybrid(fixture.roleId, request);
  await waitForCondition(() => server.pending.length > 0, 5_000);
  return { fixture, server, resourceId: resource.resourceId, query: request };
}

test("R3-11 停止请求中止后台回填，结算后异步确认停止且不再写库", async (t) => {
  const query = "目标记忆";
  const { fixture, resourceId } = await startActiveHangingFixture(t, query);
  const memory = fixture.app.services.memory;
  assert.equal(memory.isBackfilling(fixture.roleId), true);
  assert.ok(
    fixture.app.services.resources
      .inflightRoleIds(resourceId)
      .includes(fixture.roleId),
    "后台回填必须计入资源在途依赖",
  );

  const stopped = fixture.app.services.activity.requestStop(fixture.roleId);
  assert.equal(
    stopped.confirmed,
    false,
    "在途回填结算前不得提前确认停止",
  );
  assert.equal(
    memory.isBackfilling(fixture.roleId),
    true,
    "中止后任务条目保留到真正结算，停止确认与资源维护仍能看到在途依赖",
  );
  await waitForCondition(
    () => fixture.app.services.activity.view(fixture.roleId).state === "stopped",
    5_000,
  );
  assert.equal(memory.isBackfilling(fixture.roleId), false);
  await waitForCondition(
    () =>
      !fixture.app.services.resources
        .inflightRoleIds(resourceId)
        .includes(fixture.roleId),
    5_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(embeddingRowCount(fixture), 0, "取消后不得再写角色库");
});

test("R3-11 close 立即中止忽略 signal 的慢回填", async (t) => {
  const query = "目标记忆";
  const { fixture } = await startActiveHangingFixture(t, query);
  const memory = fixture.app.services.memory;
  assert.equal(memory.isBackfilling(fixture.roleId), true);

  const startedAt = Date.now();
  await fixture.app.close();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2000, `close 应立刻返回，实际 ${elapsed}ms`);
  assert.equal(embeddingRowCount(fixture), 0);
});

test("R3-11 删除角色等待回填收尾，之后不再写库", async (t) => {
  const query = "目标记忆";
  const { fixture, resourceId } = await startActiveHangingFixture(t, query);
  const memory = fixture.app.services.memory;
  assert.equal(memory.isBackfilling(fixture.roleId), true);

  const startedAt = Date.now();
  const result = await fixture.app.services.roleDeletion.remove(
    fixture.roleId,
    true,
  );
  assert.equal(result.roleId, fixture.roleId);
  assert.ok(Date.now() - startedAt < 3000, "删除应等待回填取消而不是批次超时");
  assert.equal(memory.isBackfilling(fixture.roleId), false);
  assert.equal(
    fixture.app.services.resources
      .inflightRoleIds(resourceId)
      .filter((roleId) => roleId === fixture.roleId).length,
    0,
  );
  assert.equal(embeddingRowCount(fixture), 0);
  assert.equal(
    fixture.app.services.roles.listRoles()
      .some((role) => role.roleId === fixture.roleId),
    false,
  );
});

test("R3-11 全局 Embedding 选择进入影响与维护计划，删除时清理配置", async (t) => {
  const server = await startMockEmbeddingServer(({ body, response }) => {
    const input = inputTextsOf(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
      }),
    );
  });
  t.after(() => server.close());
  const fixture = createFixture();
  t.after(() => closeFixture(fixture));
  fixture.app.services.activity.resume(fixture.roleId);
  const resources = fixture.app.services.resources;
  const settings = fixture.app.services.memoryEmbeddingSettings;
  const selected = resources.create({
    kind: "model",
    name: "全局 Embedding 服务",
    config: { protocol: "openai-chat", baseUrl: `${server.baseUrl}/v1` },
  });
  const unrelated = resources.create({
    kind: "model",
    name: "无关模型服务",
    config: { protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" },
  });
  configureEmbeddingDirect(fixture, selected.resourceId);

  const impact = resources.impact(selected.resourceId);
  assert.equal(impact.globalEmbedding, true);
  const dependency = impact.roles.find(
    (role) => role.roleId === fixture.roleId,
  );
  assert.ok(dependency !== undefined);
  assert.ok(dependency.usages.includes("memory"));
  assert.equal(
    resources.references(selected.resourceId).canDelete,
    true,
    "全局选择不改变既有 canDelete 规则",
  );

  const plan = resources.maintenancePlan(selected.resourceId, {
    config: { protocol: "openai-chat", baseUrl: `${server.baseUrl}/v2` },
  });
  assert.equal(plan.connectionChanged, true);
  assert.ok(plan.pauseRoleIds.includes(fixture.roleId));

  // 停用的选择无法再接收新调用：不进入影响范围，也不因维护暂停角色。
  resources.update(selected.resourceId, { enabled: false });
  assert.equal(resources.impact(selected.resourceId).globalEmbedding, undefined);
  const disabledPlan = resources.maintenancePlan(selected.resourceId, {
    config: { protocol: "openai-chat", baseUrl: `${server.baseUrl}/v2` },
  });
  assert.deepEqual(
    disabledPlan.pauseRoleIds,
    [],
    "不能接收新调用的 Embedding 资源不应暂停角色",
  );
  assert.equal(settings.get().ready, false);

  // 删除非选中资源不改变现有 Embedding 配置。
  resources.remove(unrelated.resourceId);
  assert.deepEqual(settings.get().resourceId, selected.resourceId);
  assert.equal(settings.get().enabled, true);

  // 删除选中资源即使已停用，也要在同一决策事务内清空配置。
  resources.remove(selected.resourceId);
  const cleared = settings.get();
  assert.equal(cleared.enabled, false);
  assert.equal(cleared.resourceId, null);
  assert.equal(cleared.modelName, null);
  assert.equal(cleared.ready, false);
});

test("R3-04 向量空间指纹稳定且随资源、端点、协议、服务商与模型区分", () => {
  const base = {
    baseUrl: "http://Example.Test:8080/v1/",
    protocol: "openai-chat",
    provider: "openai",
    modelName: "text-embedding-test",
  };
  assert.equal(embeddingSpaceKey(base), embeddingSpaceKey({ ...base }));
  assert.equal(
    embeddingSpaceKey(base),
    embeddingSpaceKey({ ...base, baseUrl: "http://example.test:8080/v1" }),
  );
  assert.notEqual(
    embeddingSpaceKey(base),
    embeddingSpaceKey({ ...base, resourceId: "resource-a" }),
  );
  assert.notEqual(
    embeddingSpaceKey({ ...base, resourceId: "resource-a" }),
    embeddingSpaceKey({ ...base, resourceId: "resource-b" }),
    "共享同一地址与模型的另一资源必须使用独立向量空间",
  );
  assert.equal(
    embeddingSpaceKey({ ...base, resourceId: "resource-a" }),
    embeddingSpaceKey({ ...base, resourceId: "resource-a" }),
  );
  assert.notEqual(
    embeddingSpaceKey(base),
    embeddingSpaceKey({ ...base, baseUrl: "http://example.test:8080/v2" }),
  );
  assert.notEqual(
    embeddingSpaceKey(base),
    embeddingSpaceKey({ ...base, protocol: "openai-responses" }),
  );
  assert.notEqual(
    embeddingSpaceKey(base),
    embeddingSpaceKey({ ...base, provider: "other" }),
  );
  assert.notEqual(
    embeddingSpaceKey(base),
    embeddingSpaceKey({ ...base, modelName: "alias-b" }),
  );
});

test("R3-09 cosineSimilarityWithBlob 兼容对齐与非对齐缓冲区偏移并拦截无效长度", () => {
  const query = normalizeVector([1, 2, 3, 4]);
  const same = encodeVectorBlob(query);
  const ortho = encodeVectorBlob(normalizeVector([-2, 1, -4, 3]));
  // 4 字节对齐路径
  const alignedScore = cosineSimilarityWithBlob(query, same, 4);
  assert.ok(alignedScore !== null && Math.abs(alignedScore - 1) < 1e-5);
  // 故意错开 1 字节偏移覆盖非对齐回退路径
  const padded = Buffer.concat([Buffer.from([0x7f]), same]);
  const unaligned = padded.subarray(1);
  assert.equal(unaligned.byteOffset % 4, 1);
  const unalignedScore = cosineSimilarityWithBlob(query, unaligned, 4);
  assert.ok(unalignedScore !== null && Math.abs(unalignedScore - 1) < 1e-5);
  const orthoScore = cosineSimilarityWithBlob(query, ortho, 4);
  assert.ok(orthoScore !== null && Math.abs(orthoScore) < 1e-5);
  // 维度或字节长度不匹配返回 null
  assert.equal(cosineSimilarityWithBlob(query, same, 3), null);
  assert.equal(cosineSimilarityWithBlob(query, same.subarray(0, 12), 4), null);
});
