import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DiaryFileMissingError } from "../src/domain/errors.js";
import { createFixture, withStorage } from "./p2-05-fixture.js";
import type { ModelEvent, ModelRequest } from "../src/domain/model.js";

function submit(
  fixture: ReturnType<typeof createFixture>,
  content: string,
): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

test("getDiarySegment pages through a long diary by code points with boundary metadata", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const head = "开头".repeat(1000); // 2000 码点
    const tail = "结尾标记：藏在日记末尾的细节";
    const content = `${head}\n${"中段".repeat(4000)}\n${tail}`;
    const diary = fixture.app.services.memory.createDiary(fixture.roleId, {
      content,
    });
    const first = fixture.app.services.memory.getDiarySegment(
      fixture.roleId,
      diary.diaryId,
      { fromChar: 0, maxChars: 1000 },
    );
    assert.equal(first.fromChar, 0);
    assert.equal(first.toChar, 1000);
    assert.equal(first.totalChars, Array.from(content).length);
    assert.equal(first.hasMore, true);
    assert.equal(first.content.length, 1000);

    let cursor = first.toChar;
    let last = first;
    while (last.hasMore) {
      last = fixture.app.services.memory.getDiarySegment(
        fixture.roleId,
        diary.diaryId,
        { fromChar: cursor, maxChars: 4000 },
      );
      assert.equal(last.fromChar, cursor);
      cursor = last.toChar;
    }
    assert.equal(last.hasMore, false);
    assert.ok(last.content.endsWith(tail), "分段读取应能到达日记末尾");
    const joined =
      first.content +
      (() => {
        let c = first.toChar;
        let piece = "";
        let view = fixture.app.services.memory.getDiarySegment(
          fixture.roleId,
          diary.diaryId,
          { fromChar: c, maxChars: 4000 },
        );
        while (view.hasMore) {
          piece += view.content;
          c = view.toChar;
          view = fixture.app.services.memory.getDiarySegment(
            fixture.roleId,
            diary.diaryId,
            { fromChar: c, maxChars: 4000 },
          );
        }
        piece += view.content;
        return piece;
      })();
    assert.equal(joined.length, Array.from(content).length);
    assert.ok(joined.endsWith(tail));
  } finally {
    await fixture.close();
  }
});

test("getDiarySegment isolates roles and reports missing files", { timeout: 30_000 }, async () => {
  const fixture = createFixture([]);
  try {
    const diary = fixture.app.services.memory.createDiary(fixture.roleId, {
      content: "隐私日记内容",
    });
    // 角色隔离：不存在的日记编号返回 404。
    assert.throws(
      () =>
        fixture.app.services.memory.getDiarySegment(
          fixture.roleId,
          randomUUID(),
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        (error as { code: string }).code === "DIARY_NOT_FOUND",
    );
    // 文件缺失：删除工作空间文件后读取报 DIARY_FILE_MISSING。
    const relativePath = diary.relativePath;
    withStorage(fixture, (storage) => {
      fs.rmSync(path.join(storage.paths.workspaceDir, relativePath), {
        force: true,
      });
    });
    assert.throws(
      () =>
        fixture.app.services.memory.getDiarySegment(
          fixture.roleId,
          diary.diaryId,
        ),
      (error: unknown) => error instanceof DiaryFileMissingError,
    );
  } finally {
    await fixture.close();
  }
});

test("the agent reads the tail of a long diary through memory_diary after a search hit", { timeout: 30_000 }, async () => {
  const tail = "尾部分析结论：第二把钥匙在花园石凳下。";
  let diaryId = "";
  const fixture = createFixture([
    (request) => {
      const search = request.tools.find(
        (candidate) => candidate.name === "memory_search",
      );
      assert.ok(search);
      return [
        {
          type: "tool_call",
          callId: "wire-search",
          name: search.name,
          arguments: { query: "钥匙" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const searchMessages = request.messages.filter(
        (message) => message.role === "tool" && message.toolName === "memory_search",
      );
      assert.ok(searchMessages.length > 0);
      const outcome = JSON.parse(String(searchMessages[0]?.content)) as {
        result?: { items?: Array<{ type: string; id: string }> };
      };
      const hit = outcome.result?.items?.find(
        (item) => item.type === "diary",
      );
      assert.ok(hit, "memory_search 应命中日记");
      assert.equal(hit.id, diaryId);
      const diaryTool = request.tools.find(
        (candidate) => candidate.name === "memory_diary",
      );
      assert.ok(diaryTool);
      return [
        {
          type: "tool_call",
          callId: "wire-diary-tail",
          name: diaryTool.name,
          arguments: { diaryId: hit.id, fromChar: 4000, maxChars: 20000 },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "钥匙在花园石凳下。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const filler = "日常记录。".repeat(1500); // 7500 码点，远长于搜索片段
    const diary = fixture.app.services.memory.createDiary(fixture.roleId, {
      content: `${filler}\n${tail}`,
    });
    diaryId = diary.diaryId;
    submit(fixture, "查一下日记里钥匙的线索");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "钥匙在花园石凳下。");
  } finally {
    await fixture.close();
  }
});
