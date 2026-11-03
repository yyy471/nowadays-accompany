import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { caseDir, currentRunId, ensureDir, p0Root, prepareCaseDir } from "../config.js";
import {
  adaptMcpToolResult,
  connectMcp,
  McpToolError,
} from "../mcp/client.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

const checks: CheckResult[] = [];

async function check(
  name: string,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function packageVersion(name: string): string {
  const packageJsonPath = path.join(p0Root, "node_modules", name, "package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };
  return parsed.version ?? "unknown";
}

const SmokeState = Annotation.Root({
  visits: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  trail: Annotation<string[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),
});

async function main(): Promise<void> {
  const dir = prepareCaseDir("p0-01");
  const roleDbPath = path.join(dir, "role.sqlite");
  const executionDbPath = path.join(dir, "execution.sqlite");
  const workspace = ensureDir(path.join(dir, "workspace"));
  const threadId = "p0-01-thread";

  await check("business-sqlite write, rollback and reopen", () => {
    const db = new Database(roleDbPath);
    db.pragma("journal_mode = WAL");
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("state", "v1");
    assert.throws(() => {
      db.transaction(() => {
        db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
          "rolled_back",
          "no",
        );
        throw new Error("injected rollback");
      })();
    });
    assert.equal(
      (
        db.prepare("SELECT value FROM meta WHERE key = ?").get("state") as
          | { value: string }
          | undefined
      )?.value,
      "v1",
    );
    assert.equal(
      db.prepare("SELECT value FROM meta WHERE key = ?").get("rolled_back"),
      undefined,
    );
    db.close();

    const reopened = new Database(roleDbPath, { readonly: true });
    assert.equal(
      (
        reopened.prepare("SELECT value FROM meta WHERE key = ?").get("state") as
          | { value: string }
          | undefined
      )?.value,
      "v1",
    );
    reopened.close();
    return { roleDbPath };
  });

  await check("langgraph checkpoint persists and reopens", async () => {
    const graph = new StateGraph(SmokeState)
      .addNode("visit", async (state) => ({
        visits: state.visits + 1,
        trail: ["visit"],
      }))
      .addEdge(START, "visit")
      .addEdge("visit", END);

    const saver = SqliteSaver.fromConnString(executionDbPath);
    const compiled = graph.compile({ checkpointer: saver });
    const result = (await compiled.invoke(
      {},
      { configurable: { thread_id: threadId } },
    )) as { visits: number; trail: string[] };
    assert.equal(result.visits, 1);
    assert.deepEqual(result.trail, ["visit"]);

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId },
    });
    assert.ok(tuple, "checkpoint tuple must exist before reopen");
    saver.db.close();

    const reopenedSaver = SqliteSaver.fromConnString(executionDbPath);
    const reopenedTuple = await reopenedSaver.getTuple({
      configurable: { thread_id: threadId },
    });
    assert.ok(reopenedTuple, "checkpoint tuple must exist after reopen");
    reopenedSaver.db.close();

    const inspection = new Database(executionDbPath, { readonly: true });
    const tables = (
      inspection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    inspection.close();
    assert.ok(tables.includes("checkpoints"));
    assert.ok(tables.includes("writes"));
    return { executionDbPath, tables };
  });

  await check("stdio MCP call, effect persistence and reconnect", async () => {
    const first = await connectMcp({ workspace });
    try {
      const listed = await first.client.listTools();
      const toolNames = listed.tools.map((tool) => tool.name).sort();
      assert.deepEqual(toolNames, [
        "append_note",
        "append_note_then_hang",
        "get_effect_counts",
        "read_note",
      ]);

      const appended = (await first.callJson("append_note", {
        path: "note.md",
        text: "hello from p0-01",
      })) as { ok: boolean; lines: number; effectCount: number };
      assert.equal(appended.ok, true);
      assert.equal(appended.lines, 1);
      assert.equal(appended.effectCount, 1);

      const direct = fs.readFileSync(path.join(workspace, "note.md"), "utf8");
      assert.equal(direct, "hello from p0-01\n");

      const stats = (await first.callJson("get_effect_counts", {})) as {
        counts: Record<string, number>;
      };
      assert.equal(stats.counts.append_note, 1);
    } finally {
      await first.close();
    }

    const second = await connectMcp({ workspace });
    try {
      const read = (await second.callJson("read_note", {
        path: "note.md",
      })) as { exists: boolean; content: string };
      assert.equal(read.exists, true);
      assert.equal(read.content, "hello from p0-01\n");
      return { workspace };
    } finally {
      await second.close();
    }
  });

  await check(
    "MCP result adaptation keeps text, structured and raw content",
    () => {
      assert.deepEqual(
        adaptMcpToolResult("sample", {
          content: [{ type: "text", text: '{"ok":true}' }],
        }),
        { ok: true },
      );
      assert.equal(
        adaptMcpToolResult("sample", {
          content: [{ type: "text", text: "已完成" }],
        }),
        "已完成",
      );
      assert.deepEqual(
        adaptMcpToolResult("sample", {
          content: [],
          structuredContent: { ok: true },
        }),
        { ok: true },
      );
      assert.deepEqual(
        adaptMcpToolResult("sample", {
          content: [{ type: "image", data: "image-data" }],
        }),
        { content: [{ type: "image", data: "image-data" }] },
      );
      assert.deepEqual(adaptMcpToolResult("sample", { content: [] }), {
        content: [],
      });
      assert.throws(
        () =>
          adaptMcpToolResult("sample", {
            isError: true,
            content: [{ type: "text", text: "boom" }],
          }),
        McpToolError,
      );
      return { cases: 6 };
    },
  );

  const report = {
    case: "P0-01",
    runId: currentRunId(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    versions: {
      "@langchain/langgraph": packageVersion("@langchain/langgraph"),
      "@langchain/core": packageVersion("@langchain/core"),
      "@langchain/langgraph-checkpoint-sqlite": packageVersion(
        "@langchain/langgraph-checkpoint-sqlite",
      ),
      "@modelcontextprotocol/sdk": packageVersion("@modelcontextprotocol/sdk"),
      "better-sqlite3": packageVersion("better-sqlite3"),
      zod: packageVersion("zod"),
      typescript: packageVersion("typescript"),
    },
    checks,
    ok: checks.every((item) => item.ok),
  };

  fs.writeFileSync(
    path.join(caseDir("p0-01"), "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
  }
}

await main();
