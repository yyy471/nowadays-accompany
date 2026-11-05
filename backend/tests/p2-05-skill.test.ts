import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelEvent, ModelPort, ModelRequest } from "../src/domain/model.js";
import {
  ScriptedChatModel,
  addBinding,
  createFixtureWithModel,
  withStorage,
} from "./p2-05-fixture.js";

class SkillCallingModel implements ModelPort {
  readonly requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    const toolMessages = request.messages.filter(
      (message) => message.role === "tool",
    );
    if (this.requests.length === 1) {
      assert.match(request.system, /meeting-notes/);
      assert.match(request.system, /整理会议记录与待办/);
      yield {
        type: "tool_call",
        callId: "wire-skill-body",
        name: "skill_read",
        arguments: { skill: "meeting-notes" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    if (this.requests.length === 2) {
      assert.match(toolMessages[0]?.content ?? "", /先读取 reference\.md/);
      yield {
        type: "tool_call",
        callId: "wire-skill-file",
        name: "skill_read",
        arguments: { skill: "meeting-notes", path: "reference.md" },
      };
      yield { type: "completed", stopReason: "tool_calls" };
      return;
    }
    assert.match(toolMessages[1]?.content ?? "", /参会人/);
    yield { type: "text_delta", text: "已按 Skill 模板整理。" };
    yield { type: "completed", stopReason: "stop" };
  }
}

test("skill reads resolve the resource's latest sourcePath between rounds", { timeout: 15_000 }, async () => {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "nowadays-skill-source-"),
  );
  const firstRoot = path.join(fixtureRoot, "first");
  const secondRoot = path.join(fixtureRoot, "second");
  for (const [root, body] of [
    [firstRoot, "旧目录正文"],
    [secondRoot, "新目录正文"],
  ] as const) {
    fs.mkdirSync(path.join(root, "meeting-notes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "meeting-notes", "SKILL.md"),
      [
        "---",
        "name: meeting-notes",
        "description: 整理会议记录与待办",
        "---",
        "",
        `${body}，按模板整理。`,
        "",
      ].join("\n"),
      "utf8",
    );
  }
  let resourceId = "";
  const model = new ScriptedChatModel([
    (request) => {
      const tool = request.tools.find((item) => item.name === "skill_read");
      assert.ok(tool);
      return [
        {
          type: "tool_call",
          callId: "wire-skill-first",
          name: "skill_read",
          arguments: { skill: "meeting-notes" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const tool = request.tools.find((item) => item.name === "skill_read");
      assert.ok(tool);
      fixture.app.services.resources.update(resourceId, {
        config: { sourcePath: secondRoot },
      });
      return [
        {
          type: "tool_call",
          callId: "wire-skill-second",
          name: "skill_read",
          arguments: { skill: "meeting-notes" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      const toolMessages = request.messages.filter(
        (message) => message.role === "tool",
      );
      assert.match(String(toolMessages[0]?.content ?? ""), /旧目录正文/);
      assert.match(String(toolMessages[1]?.content ?? ""), /新目录正文/);
      return [
        { type: "text_delta", text: "已读取最新 Skill 目录。" },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  const fixture = createFixtureWithModel(model);
  try {
    const resource = fixture.app.services.resources.create({
      kind: "skill",
      name: "会议记录",
      config: { sourcePath: firstRoot },
    });
    resourceId = resource.resourceId;
    addBinding(fixture, "skill", resource.resourceId);
    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "读取两次会议 Skill",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(model.requests.length, 3);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "已读取最新 Skill 目录。");
  } finally {
    await fixture.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("enabled skills expose metadata and load body and referenced files on demand", { timeout: 15_000 }, async () => {
  const model = new SkillCallingModel();
  const fixture = createFixtureWithModel(model);
  try {
    const skillsRoot = path.join(fixture.root, "skills");
    fs.mkdirSync(path.join(skillsRoot, "meeting-notes"), { recursive: true });
    fs.writeFileSync(
      path.join(skillsRoot, "meeting-notes", "SKILL.md"),
      [
        "---",
        "name: meeting-notes",
        "description: 整理会议记录与待办",
        "---",
        "",
        "先读取 reference.md，再按模板整理。",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(skillsRoot, "meeting-notes", "reference.md"),
      "模板：参会人、结论、待办。\n",
      "utf8",
    );
    const resource = fixture.app.services.resources.create({
      kind: "skill",
      name: "会议记录",
      config: { sourcePath: skillsRoot },
    });
    addBinding(fixture, "skill", resource.resourceId);

    fixture.app.conversation.submitMessage(
      fixture.roleId,
      fixture.windowId,
      {
        content: "帮我整理今天的会议",
        submissionId: randomUUID(),
        sourcePlatform: "nowadays",
      },
    );
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(model.requests.length, 3);
    const toolCallRows = withStorage(fixture, (storage) =>
      storage.business.db
        .prepare("SELECT COUNT(*) AS count FROM tool_calls")
        .get() as { count: number },
    );
    assert.equal(toolCallRows.count, 0);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.equal(messages.items.at(-1)?.content, "已按 Skill 模板整理。");
  } finally {
    await fixture.close();
  }
});
