import assert from "node:assert/strict";
import path from "node:path";
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { prepareCaseDir } from "../config.js";

const ProbeState = Annotation.Root({
  steps: Annotation<string[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),
});

function buildGraph(checkpointer: SqliteSaver) {
  return new StateGraph(ProbeState)
    .addNode("before", async () => ({ steps: ["before"] }))
    .addNode("gate", async () => {
      const resumeValue = interrupt({ question: "pause" });
      return { steps: [`gate:${String(resumeValue)}`] };
    })
    .addNode("after", async () => ({ steps: ["after"] }))
    .addEdge(START, "before")
    .addEdge("before", "gate")
    .addEdge("gate", "after")
    .addEdge("after", END)
    .compile({ checkpointer });
}

async function main(): Promise<void> {
  const dir = prepareCaseDir("probe-interrupt");
  const dbPath = path.join(dir, "execution.sqlite");
  const threadId = "probe-thread";

  const saver = SqliteSaver.fromConnString(dbPath);
  const graph = buildGraph(saver);

  const first = (await graph.invoke(
    {},
    { configurable: { thread_id: threadId } },
  )) as { steps: string[]; __interrupt__?: unknown };
  console.log("first:", JSON.stringify(first));
  assert.deepEqual(first.steps, ["before"]);
  assert.ok(first.__interrupt__, "first invoke must pause at interrupt()");

  saver.db.close();

  const reopenedSaver = SqliteSaver.fromConnString(dbPath);
  const reopenedGraph = buildGraph(reopenedSaver);
  const resumed = (await reopenedGraph.invoke(new Command({ resume: "go" }), {
    configurable: { thread_id: threadId },
  })) as { steps: string[] };
  console.log("resumed:", JSON.stringify(resumed));
  assert.deepEqual(resumed.steps, ["before", "gate:go", "after"]);
  reopenedSaver.db.close();

  console.log(
    JSON.stringify({
      case: "probe-interrupt",
      ok: true,
      firstSteps: first.steps,
      resumedSteps: resumed.steps,
      dbPath,
    }),
  );
}

await main();
