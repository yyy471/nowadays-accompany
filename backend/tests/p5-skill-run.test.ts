import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillLibrary } from "../src/skills/skill-library.js";
import {
  addBinding,
  createFixture,
  withStorage,
  type Fixture,
} from "./p2-05-fixture.js";

function submit(fixture: Fixture, content: string): void {
  fixture.app.conversation.submitMessage(fixture.roleId, fixture.windowId, {
    content,
    submissionId: randomUUID(),
    sourcePlatform: "nowadays",
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await delay(20);
  }
  throw new Error("WAIT_TIMEOUT");
}

interface SkillPack {
  root: string;
  resourceId: string;
}

function createSkillPack(
  fixture: Fixture,
  files: Record<string, string>,
): SkillPack {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p5-skill-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
  const resource = fixture.app.services.resources.create({
    kind: "skill",
    name: "随包脚本 Skill",
    config: { sourcePath: root },
  });
  addBinding(fixture, "skill", resource.resourceId);
  return { root, resourceId: resource.resourceId };
}

test("resolveScript only allows existing .js/.mjs files inside the skill directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p5-resolve-"));
  try {
    fs.mkdirSync(path.join(root, "demo"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: 演示\n---\n正文",
      "utf8",
    );
    fs.writeFileSync(path.join(root, "demo", "run.mjs"), "export {}", "utf8");
    fs.writeFileSync(path.join(root, "demo", "data.txt"), "数据", "utf8");
    fs.mkdirSync(path.join(root, "outside"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "outside", "evil.mjs"),
      "export {}",
      "utf8",
    );
    const library = new SkillLibrary(root);
    const resolved = library.resolveScript("demo", "run.mjs");
    assert.equal(path.basename(resolved.absolutePath), "run.mjs");
    assert.equal(resolved.directory, path.join(root, "demo"));
    assert.throws(() => library.resolveScript("demo", "data.txt"));
    assert.throws(() => library.resolveScript("demo", "missing.mjs"));
    assert.throws(() => library.resolveScript("demo", "../outside/evil.mjs"));
    assert.throws(() => library.resolveScript("demo", path.join(root, "outside", "evil.mjs")));
    assert.throws(() => library.resolveScript("missing", "run.mjs"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test("skill_run executes a bundled script that reads its own resources and writes to the workspace", { timeout: 60_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const run = request.tools.find(
        (candidate) => candidate.name === "skill_run",
      );
      assert.ok(run, "skill_run 应在工具目录中");
      return [
        {
          type: "tool_call",
          callId: "wire-skill-run",
          name: run.name,
          arguments: { skill: "demo", script: "run.mjs" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "脚本已运行。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const workspace = withStorage(
      fixture,
      (storage) => storage.paths.workspaceDir,
    );
    fs.mkdirSync(workspace, { recursive: true });
    createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 演示随包脚本\n---\n正文",
      "demo/run.mjs": [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        "const data = fs.readFileSync(path.join('data.txt'), 'utf8');",
        `fs.writeFileSync(path.join(process.env.NOWADAYS_WORKSPACE, 'skill-output.txt'), data, 'utf8');`,
        "console.log('bundled:', data.trim());",
      ].join("\n"),
      "demo/data.txt": "随包资源内容\n",
    });
    submit(fixture, "运行 demo 的脚本");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(
      fs.readFileSync(path.join(workspace, "skill-output.txt"), "utf8"),
      "随包资源内容\n",
    );
    const detail = withStorage(fixture, (storage) => {
      const call = storage.business.db
        .prepare(
          "SELECT tool_call_id, task_id, status FROM tool_calls WHERE tool_name = 'skill_run'",
        )
        .get() as {
        tool_call_id: string;
        task_id: string;
        status: string;
      };
      const result = storage.business.db
        .prepare(
          "SELECT status, adapted_result_json FROM tool_results WHERE tool_call_id = ?",
        )
        .get(call.tool_call_id) as {
        status: string;
        adapted_result_json: string;
      };
      const task = storage.business.getTask(fixture.roleId, call.task_id);
      return { call, result, task };
    });
    assert.equal(detail.call.status, "success");
    assert.equal(detail.result.status, "success");
    assert.match(detail.result.adapted_result_json, /bundled: 随包资源内容/);
    assert.equal(detail.task.status, "completed");
    assert.equal(detail.task.endReason, "回复完成");
  } finally {
    await fixture.close();
  }
});

test("skill_run records script failures with exit codes and keeps them in the call record", { timeout: 60_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const run = request.tools.find(
        (candidate) => candidate.name === "skill_run",
      );
      assert.ok(run);
      return [
        {
          type: "tool_call",
          callId: "wire-skill-fail",
          name: run.name,
          arguments: { skill: "demo", script: "fail.mjs" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "脚本失败已记录。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 演示失败\n---\n正文",
      "demo/fail.mjs": [
        "console.error('爆炸原因');",
        "process.exit(3);",
      ].join("\n"),
    });
    submit(fixture, "运行会失败的脚本");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const result = withStorage(
      fixture,
      (storage) =>
        storage.business.db
          .prepare(
            "SELECT status, diagnostic_code, adapted_result_json FROM tool_results WHERE diagnostic_code = 'SKILL_SCRIPT_EXIT'",
          )
          .get() as {
          status: string;
          diagnostic_code: string;
          adapted_result_json: string;
        },
    );
    assert.equal(result.status, "failed");
    assert.equal(result.diagnostic_code, "SKILL_SCRIPT_EXIT");
    const adapted = JSON.parse(result.adapted_result_json) as {
      exitCode?: number;
    };
    assert.equal(adapted.exitCode, 3);
  } finally {
    await fixture.close();
  }
});

test("reading a skill and its script stays read-only while a disabled skill offers no run tool", { timeout: 30_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const read = request.tools.find(
        (candidate) => candidate.name === "skill_read",
      );
      assert.ok(read);
      assert.equal(
        request.tools.some((candidate) => candidate.name === "skill_run"),
        false,
        "读取正文不应提供执行工具",
      );
      return [
        {
          type: "tool_call",
          callId: "wire-read-script",
          name: read.name,
          arguments: { skill: "demo", path: "helper.mjs" },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    (request) => {
      assert.equal(
        request.tools.some(
          (candidate) =>
            candidate.name === "skill_run" ||
            candidate.name === "skill_read",
        ),
        false,
        "禁用 Skill 后不应再提供读取或执行工具",
      );
      return [
        { type: "text_delta", text: "禁用后无 Skill 工具。" },
        { type: "completed", stopReason: "stop" },
      ];
    },
  ]);
  try {
    const pack = createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 演示只读\n---\n正文",
      "demo/helper.mjs": "console.log('不应被执行');",
    });
    submit(fixture, "读取脚本正文");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const calls = withStorage(
      fixture,
      (storage) =>
        storage.business.db
          .prepare("SELECT COUNT(*) AS count FROM tool_calls")
          .get() as { count: number },
    );
    assert.equal(calls.count, 0, "读取正文不产生外部调用记录");

    fixture.app.services.resources.update(pack.resourceId, {
      enabled: false,
    });
    submit(fixture, "禁用后再试一次");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    const disabledCalls = withStorage(
      fixture,
      (storage) =>
        storage.business.db
          .prepare("SELECT COUNT(*) AS count FROM tool_calls")
          .get() as { count: number },
    );
    assert.equal(disabledCalls.count, 0, "禁用 Skill 后无外部调用");
  } finally {
    await fixture.close();
  }
});

test("a new message does not kill an already dispatched skill script and its real result stays on the original call", { timeout: 60_000 }, async () => {
  const fixture = createFixture(
    [
      (request) => {
        const run = request.tools.find(
          (candidate) => candidate.name === "skill_run",
        );
        assert.ok(run);
        return [
          {
            type: "tool_call",
            callId: "wire-skill-interrupt",
            name: run.name,
            arguments: { skill: "demo", script: "run.mjs", timeoutMs: 60_000 },
          },
          { type: "completed", stopReason: "tool_calls" },
        ];
      },
      [
        { type: "text_delta", text: "脚本已完成。" },
        { type: "completed", stopReason: "stop" },
      ],
      [
        { type: "text_delta", text: "先回应新消息。" },
        { type: "completed", stopReason: "stop" },
      ],
    ],
    { toolForegroundWaitMs: 5_000 },
  );
  try {
    const effect = path.join(fixture.root, "skill-effect");
    const finished = path.join(fixture.root, "skill-finished");
    const release = path.join(fixture.root, "skill-release");
    createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 插话脚本样例\n---\n正文",
      "demo/run.mjs": [
        "import fs from 'node:fs';",
        "import { setTimeout as delay } from 'node:timers/promises';",
        `fs.writeFileSync(${JSON.stringify(effect)}, 'first effect');`,
        `const deadline = Date.now() + 15000;`,
        `while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await delay(20);`,
        `fs.writeFileSync(${JSON.stringify(finished)}, 'finished');`,
      ].join("\n"),
    });
    submit(fixture, "执行一个有副作用的脚本");
    await waitUntil(() => fs.existsSync(effect));
    submit(fixture, "先回答这条新消息");
    await waitUntil(() => {
      const status = withStorage(fixture, (storage) =>
        (
          storage.business.db
            .prepare(
              "SELECT status FROM executions ORDER BY rowid ASC LIMIT 1",
            )
            .get() as { status: string }
        ).status,
      );
      return status === "superseded";
    });
    fs.writeFileSync(release, "", "utf8");
    await fixture.app.conversation.waitForIdle(fixture.roleId);

    assert.equal(fs.existsSync(effect), true);
    assert.equal(fs.existsSync(finished), true, "插话后脚本应继续执行到真实结束");
    const call = withStorage(fixture, (storage) => {
      const rows = storage.business.db
        .prepare(
          "SELECT tc.status, tr.diagnostic_code FROM tool_calls tc LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id ORDER BY tc.rowid ASC",
        )
        .all() as Array<{ status: string; diagnostic_code: string | null }>;
      return rows;
    });
    assert.deepEqual(call, [{ status: "success", diagnostic_code: null }]);
    const messages = fixture.app.services.messages.list(
      fixture.roleId,
      fixture.windowId,
      0,
      20,
    );
    assert.ok(
      messages.items.some(
        (message) =>
          message.sender === "assistant" &&
          message.status === "completed" &&
          message.content === "先回应新消息。",
      ),
    );
  } finally {
    await fixture.close();
  }
});

test("a dispatched skill script reports its real timeout without inventing supersession", { timeout: 60_000 }, async () => {
  const fixture = createFixture([
    (request) => {
      const run = request.tools.find(
        (candidate) => candidate.name === "skill_run",
      );
      assert.ok(run);
      return [
        {
          type: "tool_call",
          callId: "wire-skill-timeout",
          name: run.name,
          arguments: { skill: "demo", script: "run.mjs", timeoutMs: 1_000 },
        },
        { type: "completed", stopReason: "tool_calls" },
      ];
    },
    [
      { type: "text_delta", text: "脚本超时。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  try {
    const effect = path.join(fixture.root, "timeout-effect");
    const finished = path.join(fixture.root, "timeout-finished");
    createSkillPack(fixture, {
      "demo/SKILL.md": "---\nname: demo\ndescription: 超时脚本样例\n---\n正文",
      "demo/run.mjs": [
        "import fs from 'node:fs';",
        "import { setTimeout as delay } from 'node:timers/promises';",
        `fs.writeFileSync(${JSON.stringify(effect)}, 'effect');`,
        "await delay(5000);",
        `fs.writeFileSync(${JSON.stringify(finished)}, 'finished');`,
      ].join("\n"),
    });
    submit(fixture, "运行一个超时脚本");
    await fixture.app.conversation.waitForIdle(fixture.roleId);
    assert.equal(fs.existsSync(effect), true);
    assert.equal(fs.existsSync(finished), false, "超时后不应继续完成脚本");
    const detail = withStorage(fixture, (storage) => {
      const row = storage.business.db
        .prepare(
          "SELECT tc.status, tr.diagnostic_code FROM tool_calls tc LEFT JOIN tool_results tr ON tr.tool_call_id = tc.tool_call_id ORDER BY tc.rowid ASC LIMIT 1",
        )
        .get() as { status: string; diagnostic_code: string | null };
      return row;
    });
    assert.deepEqual(detail, {
      status: "failed",
      diagnostic_code: "SKILL_SCRIPT_TIMEOUT",
    });
  } finally {
    await fixture.close();
  }
});
