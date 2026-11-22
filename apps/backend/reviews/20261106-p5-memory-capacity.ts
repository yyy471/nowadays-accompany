import fs from "node:fs";
import path from "node:path";
import type { MemoryFormationInput, MemoryModelPort } from "../src/domain/memory.js";
import { MemoryService } from "../src/application/memory-service.js";
import { MemoryStore } from "../src/storage/memory-store.js";
import { DEFAULT_MEMORY_BUDGET_CHARS } from "../src/domain/memory.js";
import {
  createFixture,
  seedEvent,
  withStorage,
  type Fixture,
} from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p5-memory-capacity");
const onlyCase = process.env.NOWADAYS_REVIEW_CASE ?? null;

interface CaseResult {
  id: string;
  contractPassed: boolean;
  observed?: unknown;
  probeError?: string;
}

const results: CaseResult[] = [];
function record(result: CaseResult): void {
  results.push(result);
  fs.writeFileSync(path.join(output, "p5-capacity-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.contractPassed, error: result.probeError }));
}

fs.mkdirSync(output, { recursive: true });
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P5_CAPACITY_TIMEOUT"); process.exit(2); }, 120_000);

class CapturingMemoryModel implements MemoryModelPort {
  readonly inputs: MemoryFormationInput[] = [];
  async form(input: MemoryFormationInput): Promise<unknown> {
    this.inputs.push(input);
    return { operations: [] };
  }
}

function seedMaterial(fixture: Fixture): void {
  seedEvent(fixture, {
    content: "甲".repeat(20_000),
    title: "容量材料一",
    summary: "用于容量评审",
    occurredAt: "2026-11-05T02:00:00.000Z",
  });
  seedEvent(fixture, {
    content: "乙".repeat(20_000),
    title: "容量材料二",
    summary: "用于容量评审",
    occurredAt: "2026-11-05T03:00:00.000Z",
  });
}

function batchesOf(fixture: Fixture) {
  return withStorage(
    fixture,
    (storage) =>
      storage.business.db
        .prepare(
          "SELECT batch_id, status, context_budget_chars, output_reserve_chars FROM memory_batches ORDER BY rowid ASC",
        )
        .all() as Array<{
        batch_id: string;
        status: string;
        context_budget_chars: number;
        output_reserve_chars: number;
      }>,
  );
}

async function runDeclared(capacity: {
  maxInputChars: number;
  maxOutputChars: number;
}): Promise<{ fixture: Fixture; model: CapturingMemoryModel; batches: ReturnType<typeof batchesOf> }> {
  const model = new CapturingMemoryModel();
  const fixture = createFixture([], {
    disableMemoryRuntime: false,
    memoryModelFactory: () => model,
  });
  const chatBinding = fixture.app.services.resources
    .listBindings(fixture.roleId)
    .find((binding) => binding.capability === "chat_model");
  if (!chatBinding) throw new Error("P5_CHAT_BINDING_MISSING");
  fixture.app.services.resources.update(chatBinding.resourceId, {
    config: {
      protocol: "openai-chat",
      baseUrl: "http://offline.invalid/v1",
      maxInputChars: capacity.maxInputChars,
      maxOutputChars: capacity.maxOutputChars,
    },
  });
  seedMaterial(fixture);
  await fixture.app.conversation.runMemoryPending(fixture.roleId);
  return { fixture, model, batches: batchesOf(fixture) };
}

async function caseTwoCapacities(): Promise<CaseResult> {
  const small = await runDeclared({ maxInputChars: 30_000, maxOutputChars: 4_000 });
  try {
    const large = await runDeclared({ maxInputChars: 80_000, maxOutputChars: 4_000 });
    try {
      const overhead = 1_000;
      const bounded = (inputs: MemoryFormationInput[], max: number) =>
        inputs.every(
          (input) =>
            Array.from(JSON.stringify(input)).length + overhead + 4_000 <= max,
        );
      const smallBudgets = small.batches.map((row) => row.context_budget_chars);
      const largeBudgets = large.batches.map((row) => row.context_budget_chars);
      return {
        id: "two-capacities",
        contractPassed:
          small.batches.length > large.batches.length &&
          small.batches.length >= 2 &&
          large.batches.length === 1 &&
          smallBudgets.every((value) => value <= 30_000 - 5_000) &&
          largeBudgets.every((value) => value <= 80_000 - 5_000) &&
          small.batches.every((row) => row.output_reserve_chars === 4_000) &&
          bounded(small.model.inputs, 30_000) &&
          bounded(large.model.inputs, 80_000) &&
          small.batches.every((row) => row.status === "completed") &&
          large.batches.every((row) => row.status === "completed") &&
          (small.model.inputs[0]?.evidence[0]?.content ?? "").startsWith("甲"),
        observed: {
          small: { batches: small.batches, inputs: small.model.inputs.length },
          large: { batches: large.batches, inputs: large.model.inputs.length },
        },
      };
    } finally {
      await large.fixture.close();
    }
  } finally {
    await small.fixture.close();
  }
}

async function caseLegacyDefault(): Promise<CaseResult> {
  const model = new CapturingMemoryModel();
  const fixture = createFixture([], {
    disableMemoryRuntime: false,
    memoryModelFactory: () => model,
  });
  try {
    seedEvent(fixture, {
      content: "无容量声明的内容".repeat(200),
      title: "默认预算材料",
      summary: "默认预算",
      occurredAt: "2026-11-05T02:00:00.000Z",
    });
    await fixture.app.conversation.runMemoryPending(fixture.roleId);
    const batches = batchesOf(fixture);
    return {
      id: "legacy-default-budget",
      contractPassed:
        batches.length > 0 &&
        batches.every(
          (row) =>
            row.context_budget_chars === DEFAULT_MEMORY_BUDGET_CHARS &&
            row.output_reserve_chars === 4_000 &&
            row.status === "completed",
        ) &&
        model.inputs.length === batches.length,
      observed: { batches },
    };
  } finally {
    await fixture.close();
  }
}

async function caseCapacityExceeded(): Promise<CaseResult> {
  const fixture = createFixture([]);
  try {
    seedEvent(fixture, {
      content: "容量不足用例",
      title: "容量不足",
      summary: "容量不足",
      occurredAt: "2026-11-05T02:00:00.000Z",
    });
    const result = await withStorage(fixture, (storage) => {
      const service = new MemoryService(
        new MemoryStore(storage.business.db),
        new CapturingMemoryModel(),
        {
          capacity: {
            maxInputChars: 3_000,
            maxOutputChars: 4_000,
            source: "declared",
          },
          requestOverheadChars: 1_000,
        },
      );
      return service.runBatch(fixture.roleId);
    });
    return {
      id: "capacity-exceeded",
      contractPassed:
        result.status === "failed" && result.errorCode === "MEMORY_CAPACITY_EXCEEDED",
      observed: result,
    };
  } finally {
    await fixture.close();
  }
}

const cases: Array<() => Promise<CaseResult>> = [
  caseTwoCapacities,
  caseLegacyDefault,
  caseCapacityExceeded,
];

try {
  for (const run of cases) {
    if (onlyCase !== null && !run.name.toLowerCase().includes(onlyCase.toLowerCase())) {
      continue;
    }
    try {
      record(await run());
    } catch (error) {
      record({ id: run.name, contractPassed: false, probeError: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  }
} finally {
  clearTimeout(watchdog);
  clearInterval(alive);
}
process.exitCode = results.some((r) => r.probeError) ? 2 : results.some((r) => !r.contractPassed) ? 1 : 0;
