import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";
import {
  createFixture,
  withStorage,
  type Fixture,
} from "../tests/p2-05-fixture.js";

const output = path.resolve(process.env.NOWADAYS_REVIEW_OUTPUT ?? "test-results/p5-diary-read");
const onlyCase = process.env.NOWADAYS_REVIEW_CASE ?? null;
const done = (text: string): ModelEvent[] => [{ type: "text_delta", text }, { type: "completed", stopReason: "stop" }];
const callTool = (name: string, callId: string, args: Record<string, unknown> = {}): ModelEvent[] =>
  [{ type: "tool_call", callId, name, arguments: args }, { type: "completed", stopReason: "tool_calls" }];

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

interface CaseResult {
  id: string;
  contractPassed: boolean;
  observed?: unknown;
  probeError?: string;
}

const results: CaseResult[] = [];
function record(result: CaseResult): void {
  results.push(result);
  fs.writeFileSync(path.join(output, "p5-diary-report.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ id: result.id, passed: result.contractPassed, error: result.probeError }));
}

fs.mkdirSync(output, { recursive: true });
const alive = setInterval(() => {}, 1000);
const watchdog = setTimeout(() => { console.error("P5_DIARY_TIMEOUT"); process.exit(2); }, 120_000);

async function caseTailAfterSearch(): Promise<CaseResult> {
  const tail = "尾部分析结论：第二把钥匙在花园石凳下。";
  let diaryId = "";
  const fixture = createFixture([
    (request: ModelRequest) => {
      const search = request.tools.find((t) => t.name === "memory_search");
      if (!search) throw new Error("P5_SEARCH_MISSING");
      return callTool(search.name, "wire-search", { query: "钥匙" });
    },
    (request: ModelRequest) => {
      const searchMessage = request.messages.find(
        (message) => message.role === "tool" && message.toolName === "memory_search",
      );
      if (!searchMessage) throw new Error("P5_SEARCH_RESULT_MISSING");
      const outcome = JSON.parse(String(searchMessage.content)) as {
        result?: { items?: Array<{ type: string; id: string }> };
      };
      const hit = outcome.result?.items?.find((item) => item.type === "diary");
      if (!hit) throw new Error("P5_DIARY_HIT_MISSING");
      const diaryTool = request.tools.find((t) => t.name === "memory_diary");
      if (!diaryTool) throw new Error("P5_DIARY_TOOL_MISSING");
      return callTool(diaryTool.name, "wire-diary-tail", {
        diaryId: hit.id,
        fromChar: 4000,
        maxChars: 20000,
      });
    },
    (request: ModelRequest) => {
      const diaryMessage = request.messages.find(
        (message) => message.role === "tool" && message.toolName === "memory_diary",
      );
      if (!diaryMessage) throw new Error("P5_DIARY_RESULT_MISSING");
      if (!String(diaryMessage.content).includes(tail)) {
        throw new Error("P5_DIARY_TAIL_MISSING");
      }
      return done("钥匙在花园石凳下。");
    },
  ]);
  try {
    const filler = "日常记录。".repeat(1500);
    const diary = fixture.app.services.memory.createDiary(fixture.roleId, {
      content: `${filler}\n${tail}`,
    });
    diaryId = diary.diaryId;
    submit(fixture, "查一下日记里钥匙的线索");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const recall = withStorage(
      fixture,
      (storage) =>
        storage.business.db
          .prepare(
            "SELECT record_type, record_id FROM memory_recalls WHERE record_id = ?",
          )
          .all(diaryId) as Array<{ record_type: string; record_id: string }>,
    );
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    return {
      id: "tail-after-search",
      contractPassed:
        messages.items.at(-1)?.content === "钥匙在花园石凳下。" &&
        recall.some((row) => row.record_type === "diary"),
      observed: { final: messages.items.at(-1), recall },
    };
  } finally {
    await fixture.close();
  }
}

async function caseIsolationAndMissingFile(): Promise<CaseResult> {
  const fixture = createFixture([]);
  try {
    const diary = fixture.app.services.memory.createDiary(fixture.roleId, {
      content: "隐私日记内容",
    });
    let notFound = false;
    try {
      fixture.app.services.memory.getDiarySegment(fixture.roleId, randomUUID());
    } catch (error) {
      notFound =
        error instanceof Error && "code" in error &&
        (error as { code: string }).code === "DIARY_NOT_FOUND";
    }
    const filePath = withStorage(
      fixture,
      (storage) => path.join(storage.paths.workspaceDir, diary.relativePath),
    );
    fs.rmSync(filePath, { force: true });
    let missing = false;
    try {
      fixture.app.services.memory.getDiarySegment(fixture.roleId, diary.diaryId);
    } catch (error) {
      missing =
        error instanceof Error && "code" in error &&
        (error as { code: string }).code === "DIARY_FILE_MISSING";
    }
    return {
      id: "isolation-and-missing-file",
      contractPassed: notFound && missing,
      observed: { notFound, missing },
    };
  } finally {
    await fixture.close();
  }
}

async function caseSegmentBoundaries(): Promise<CaseResult> {
  const fixture = createFixture([]);
  try {
    const content = `${"前".repeat(5000)}${"尾".repeat(5000)}`;
    const diary = fixture.app.services.memory.createDiary(fixture.roleId, {
      content,
    });
    const first = fixture.app.services.memory.getDiarySegment(
      fixture.roleId,
      diary.diaryId,
      { fromChar: 0, maxChars: 4000 },
    );
    const last = fixture.app.services.memory.getDiarySegment(
      fixture.roleId,
      diary.diaryId,
      { fromChar: 8000, maxChars: 4000 },
    );
    return {
      id: "segment-boundaries",
      contractPassed:
        first.totalChars === 10_000 &&
        first.fromChar === 0 &&
        first.toChar === 4000 &&
        first.hasMore === true &&
        last.fromChar === 8000 &&
        last.toChar === 10_000 &&
        last.hasMore === false &&
        last.content.endsWith("尾".repeat(10)),
      observed: {
        first: { fromChar: first.fromChar, toChar: first.toChar, hasMore: first.hasMore, totalChars: first.totalChars },
        last: { fromChar: last.fromChar, toChar: last.toChar, hasMore: last.hasMore },
      },
    };
  } finally {
    await fixture.close();
  }
}

const cases: Array<() => Promise<CaseResult>> = [
  caseTailAfterSearch,
  caseIsolationAndMissingFile,
  caseSegmentBoundaries,
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
