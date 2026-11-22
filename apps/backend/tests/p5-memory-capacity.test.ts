import assert from "node:assert/strict";
import test from "node:test";
import { MemoryService } from "../src/application/memory-service.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { RoleStorage } from "../src/storage/role-storage.js";
import { rolePaths } from "../src/bootstrap/config.js";
import {
  DEFAULT_MEMORY_BUDGET_CHARS,
  type MemoryFormationInput,
  type MemoryModelPort,
} from "../src/domain/memory.js";
import {
  createFixture,
  seedEvent,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

class CapturingMemoryModel implements MemoryModelPort {
  readonly inputs: MemoryFormationInput[] = [];

  async form(input: MemoryFormationInput): Promise<unknown> {
    this.inputs.push(input);
    return { operations: [] };
  }
}

function seedEvidence(
  fixture: Fixture,
  content: string,
  occurredAt: string,
): void {
  seedEvent(fixture, {
    content,
    title: `事件-${occurredAt}`,
    summary: "用于容量测试的证据",
    occurredAt,
  });
}

/** 异步运行记忆整理期间保持存储连接打开（withStorage 会同步关闭）。 */
async function runMemory(
  fixture: Fixture,
  run: (store: MemoryStore) => Promise<unknown>,
): Promise<void> {
  const storage = RoleStorage.openExisting(
    rolePaths(fixture.app.config.dataRoot, fixture.roleId),
  );
  try {
    await run(new MemoryStore(storage.business.db));
  } finally {
    storage.close();
  }
}

function batchesOf(fixture: Fixture) {
  return withStorage(
    fixture,
    (storage) =>
      storage.business.db
        .prepare(
          "SELECT context_budget_chars, output_reserve_chars, status FROM memory_batches ORDER BY rowid ASC",
        )
        .all() as Array<{
        context_budget_chars: number;
        output_reserve_chars: number;
        status: string;
      }>,
  );
}

test("declared capacity bounds the assembled request and splits evidence across batches", { timeout: 30_000 }, async () => {
  const model = new CapturingMemoryModel();
  const fixture = createFixture([], { disableMemoryRuntime: true });
  try {
    seedEvidence(fixture, "甲".repeat(20_000), "2026-11-03T10:00:00.000Z");
    seedEvidence(fixture, "乙".repeat(20_000), "2026-11-03T11:00:00.000Z");
    await runMemory(fixture, (store) => {
      const service = new MemoryService(store, model, {
        capacity: {
          maxInputChars: 30_000,
          maxOutputChars: 4_000,
          source: "declared",
        },
        requestOverheadChars: 1_000,
      });
      return service.runPending(fixture.roleId);
    });
    assert.ok(model.inputs.length >= 2, "小容量应把证据分到多批");
    for (const input of model.inputs) {
      const requestChars = Array.from(JSON.stringify(input)).length;
      assert.ok(
        requestChars + 1_000 + 4_000 <= 30_000,
        `请求长度 ${requestChars} 加预留应不超过声明容量`,
      );
    }
    const batches = batchesOf(fixture);
    assert.ok(batches.length >= 2);
    for (const batch of batches) {
      assert.equal(batch.output_reserve_chars, 4_000);
      assert.ok(batch.context_budget_chars <= 30_000 - 4_000 - 1_000);
      assert.ok(batch.context_budget_chars > 0);
      assert.equal(batch.status, "completed");
    }
    // 跨批按 role_sequence 顺序处理。
    assert.equal(
      (model.inputs[0]?.evidence[0]?.content ?? "").slice(0, 1),
      "甲",
    );
    assert.equal(
      (model.inputs.at(-1)?.evidence[0]?.content ?? "").slice(0, 1),
      "乙",
    );
  } finally {
    await fixture.close();
  }
});

test("a larger declared capacity batches the same material in fewer rounds", { timeout: 30_000 }, async () => {
  const model = new CapturingMemoryModel();
  const fixture = createFixture([], { disableMemoryRuntime: true });
  try {
    seedEvidence(fixture, "甲".repeat(20_000), "2026-11-03T10:00:00.000Z");
    seedEvidence(fixture, "乙".repeat(20_000), "2026-11-03T11:00:00.000Z");
    await runMemory(fixture, (store) => {
      const service = new MemoryService(store, model, {
        capacity: {
          maxInputChars: 80_000,
          maxOutputChars: 4_000,
          source: "declared",
        },
        requestOverheadChars: 1_000,
      });
      return service.runPending(fixture.roleId);
    });
    assert.equal(model.inputs.length, 1);
    assert.equal(model.inputs[0]?.evidence.length, 2);
    const requestChars = Array.from(JSON.stringify(model.inputs[0])).length;
    assert.ok(requestChars + 1_000 + 4_000 <= 80_000);
  } finally {
    await fixture.close();
  }
});

test("without a declared capacity the legacy conservative budget is kept", { timeout: 30_000 }, async () => {
  const model = new CapturingMemoryModel();
  const fixture = createFixture([], { disableMemoryRuntime: true });
  try {
    seedEvidence(fixture, "内容".repeat(100), "2026-11-03T10:00:00.000Z");
    await runMemory(fixture, (store) => {
      const service = new MemoryService(store, model);
      return service.runBatch(fixture.roleId);
    });
    const batch = withStorage(
      fixture,
      (storage) =>
        storage.business.db
          .prepare(
            "SELECT context_budget_chars, output_reserve_chars FROM memory_batches LIMIT 1",
          )
          .get() as {
          context_budget_chars: number;
          output_reserve_chars: number;
        },
    );
    assert.equal(batch.context_budget_chars, DEFAULT_MEMORY_BUDGET_CHARS);
    assert.equal(batch.output_reserve_chars, 4_000);
  } finally {
    await fixture.close();
  }
});

test("a declared capacity smaller than the fixed overhead fails with MEMORY_CAPACITY_EXCEEDED", { timeout: 30_000 }, async () => {
  const fixture = createFixture([], { disableMemoryRuntime: true });
  try {
    seedEvidence(fixture, "小容量测试", "2026-11-03T10:00:00.000Z");
    let errorCode: string | null = null;
    let batchId: string | null | undefined;
    await runMemory(fixture, async (store) => {
      const service = new MemoryService(store, new CapturingMemoryModel(), {
        capacity: {
          maxInputChars: 3_000,
          maxOutputChars: 4_000,
          source: "declared",
        },
        requestOverheadChars: 1_000,
      });
      const result = await service.runBatch(fixture.roleId);
      errorCode = result.errorCode;
      batchId = result.batchId;
    });
    assert.equal(errorCode, "MEMORY_CAPACITY_EXCEEDED");
    assert.equal(batchId, null);
  } finally {
    await fixture.close();
  }
});

test("a failed model call keeps progress so the retry continues from the same evidence", { timeout: 30_000 }, async () => {
  const fixture = createFixture([], { disableMemoryRuntime: true });
  try {
    seedEvidence(fixture, "甲".repeat(20_000), "2026-11-03T10:00:00.000Z");
    seedEvidence(fixture, "乙".repeat(20_000), "2026-11-03T11:00:00.000Z");
    const failing: MemoryModelPort = {
      async form() {
        throw new Error("MEMORY_MODEL_DOWN");
      },
    };
    let firstStatus: string | null = null;
    await runMemory(fixture, async (store) => {
      const service = new MemoryService(store, failing, {
        capacity: {
          maxInputChars: 30_000,
          maxOutputChars: 4_000,
          source: "declared",
        },
        requestOverheadChars: 1_000,
        retryDelaysMs: [0],
      });
      // 单批失败即停；不用 runPending，避免退避为 0 的重试无限循环。
      const result = await service.runBatch(fixture.roleId);
      firstStatus = result.status;
    });
    assert.equal(firstStatus, "failed");
    // 失败后证据未推进：再次运行（模拟重试）仍从第一条证据开始并成功。
    const model = new CapturingMemoryModel();
    let completed = 0;
    await runMemory(fixture, async (store) => {
      const service = new MemoryService(store, model, {
        capacity: {
          maxInputChars: 30_000,
          maxOutputChars: 4_000,
          source: "declared",
        },
        requestOverheadChars: 1_000,
        retryDelaysMs: [0],
      });
      for (let round = 0; round < 10; round += 1) {
        const result = await service.runBatch(fixture.roleId);
        if (result.status === "none") {
          break;
        }
        if (result.status === "completed") {
          completed += 1;
        }
      }
    });
    assert.ok(model.inputs.length >= 2);
    assert.equal(completed, 2, "重试后两批证据都应完成");
  } finally {
    await fixture.close();
  }
});

test("escaped evidence and legacy oversized segments stay within declared capacity", { timeout: 30_000 }, async () => {
  const model = new CapturingMemoryModel();
  const fixture = createFixture([], { disableMemoryRuntime: true });
  try {
    seedEvidence(fixture, "\\".repeat(4_000), "2026-11-03T10:00:00.000Z");
    seedEvidence(fixture, '"'.repeat(4_000), "2026-11-03T11:00:00.000Z");
    await runMemory(fixture, async (store) => {
      // 模拟上一版本按原始字符切出的旧分段：单段远大于序列化后的容量。
      const seeded = store.startBatch({
        roleId: fixture.roleId,
        budgetChars: 4_000,
        outputReserveChars: 500,
      });
      assert.ok(seeded);
      store.finishBatch({
        roleId: fixture.roleId,
        batchId: seeded.batch.batchId,
        status: "failed",
        errorCode: "LEGACY_SEGMENT_SEED",
        nextRetryAt: new Date(0).toISOString(),
      });
      const service = new MemoryService(store, model, {
        capacity: {
          maxInputChars: 3_000,
          maxOutputChars: 500,
          source: "declared",
        },
        requestOverheadChars: 1_000,
      });
      const result = await service.runPending(fixture.roleId);
      assert.equal(result.status, "completed");
      assert.equal(result.evidenceProcessed, 2);
    });
    assert.ok(model.inputs.length > 2, "转义后的证据应拆成更多请求");
    for (const input of model.inputs) {
      const requestChars = Array.from(JSON.stringify(input)).length;
      assert.ok(
        requestChars + 1_000 + 500 <= 3_000,
        `请求长度 ${requestChars} 加开销与预留应不超过 3,000`,
      );
      assert.equal(input.evidence.length, 1);
    }
    const segments = withStorage(
      fixture,
      (storage) =>
        storage.business.db
          .prepare(
            "SELECT segment_index, from_char, to_char, status FROM memory_evidence_segments ORDER BY evidence_id ASC, segment_index ASC",
          )
          .all() as Array<{
          segment_index: number;
          from_char: number;
          to_char: number;
          status: string;
        }>,
    );
    assert.ok(segments.length > 2);
    assert.ok(segments.every((segment) => segment.status === "processed"));
  } finally {
    await fixture.close();
  }
});
