import type {
  ChatModelPort,
  ModelContext,
  ModelDecision,
} from "../domain/types.js";

export type ScriptedDecision = (
  context: ModelContext,
) => ModelDecision | Promise<ModelDecision>;

const scripts: Record<string, ScriptedDecision> = {
  c01: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "append_note",
          args: { path: "note.md", text: "P0-C01" },
          rationale: "C01: write one deterministic note",
        }
      : {
          type: "final",
          text: `工具状态=${lastStatus(context)}。`,
          stateUpdate: {
            lastToolStatus: lastStatus(context),
            lastReply: "c01",
          },
        },

  c02: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "append_note",
          args: { path: "note.md", text: "P0-C02" },
          rationale: "C02: tool result must survive the pause",
        }
      : {
          type: "final",
          text: `同次恢复后工具状态=${lastStatus(context)}。`,
          stateUpdate: {
            lastToolStatus: lastStatus(context),
            lastReply: "c02",
          },
        },

  c03: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "append_note",
          args: { path: "note.md", text: "P0-C03" },
          rationale: "C03: tool result must survive process restart",
        }
      : {
          type: "final",
          text: `重启恢复后工具状态=${lastStatus(context)}。`,
          stateUpdate: {
            lastToolStatus: lastStatus(context),
            lastReply: "c03",
          },
        },

  c04Old: (context) => {
    if (context.turn === 0) {
      return {
        type: "tool",
        toolName: "append_note",
        args: { path: "old-note.md", text: "P0-C04-old-tool" },
        rationale: "C04: old execution already has a real tool result",
      };
    }
    const chunks = ["旧回复第一段。", "旧回复第二段。"];
    return {
      type: "final",
      text: chunks.join(""),
      chunks,
      blockAfterChunks: 1,
      barrierKey: "c04-old-model",
      stateUpdate: { lastReply: "old" },
    };
  },

  c04New: () => ({
    type: "final",
    text: "新回复：已收到新消息。",
    chunks: ["新回复：已收到新消息。"],
    stateUpdate: { lastReply: "new" },
  }),

  c05: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "append_note",
          args: { path: "note.md", text: "P0-C05" },
          rationale: "C05: pause after the result, then refresh role data",
        }
      : {
          type: "final",
          text: `最新设定 tone=${String(context.settings.tone)}，最新状态 mood=${String(context.state.mood)}，工具=${lastStatus(context)}。`,
          stateUpdate: {
            lastSeenTone: context.settings.tone,
            lastSeenMood: context.state.mood,
            lastToolStatus: lastStatus(context),
            lastReply: "c05",
          },
        },

  c06: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "append_note_then_hang",
          args: { path: "note.md", text: "P0-C06" },
          rationale: "C06: side effect happens but the response is lost",
        }
      : {
          type: "final",
          text: `工具核查状态=${lastStatus(context)}。`,
          stateUpdate: {
            lastToolStatus: lastStatus(context),
            lastReply: "c06",
          },
        },

  c07: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "append_note",
          args: { path: "note.md", text: "P0-C07" },
          rationale: "C07: tool result must survive a failed business commit",
        }
      : {
          type: "final",
          text: "准备提交本轮回复和状态。",
          stateUpdate: {
            lastToolStatus: lastStatus(context),
            lastReply: "c07",
          },
        },

  c08: (context) =>
    context.turn === 0
      ? {
          type: "tool",
          toolName: "read_note",
          args: { path: "../outside.md" },
          rationale: "C08: explicit tool failure must be distinguishable",
        }
      : {
          type: "final",
          text: `工具状态=${lastStatus(context)}。`,
          stateUpdate: {
            lastToolStatus: lastStatus(context),
            lastReply: "c08",
          },
        },
};

function lastStatus(context: ModelContext): string {
  return context.toolResults.at(-1)?.status ?? "none";
}

export function createScriptedModel(scriptName: string): ChatModelPort {
  const script = scripts[scriptName];
  if (!script) {
    throw new Error(`UNKNOWN_SCRIPT:${scriptName}`);
  }
  return {
    async decide(context) {
      return script(context);
    },
  };
}

export function scriptNames(): string[] {
  return Object.keys(scripts).sort();
}
