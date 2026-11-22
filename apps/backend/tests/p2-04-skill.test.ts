import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SkillFileInvalidError,
  SkillNotFoundError,
} from "../src/domain/errors.js";
import { SkillLibrary } from "../src/skills/skill-library.js";

function createSkillsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-skills-"));
  fs.mkdirSync(path.join(root, "meeting-notes"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "meeting-notes", "SKILL.md"),
    [
      "---",
      "name: meeting-notes",
      "description: 整理会议记录与待办",
      "---",
      "",
      "# 会议记录",
      "",
      "先读取 reference.md，再按模板整理。",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "meeting-notes", "reference.md"),
    "模板：参会人、结论、待办。\n",
    "utf8",
  );
  fs.mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "not-a-skill", "README.md"),
    "不是 Skill",
    "utf8",
  );
  return root;
}

test("skill frontmatter accepts YAML quoted and block scalar values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p2-04-yaml-"));
  try {
    fs.mkdirSync(path.join(root, "quoted"));
    fs.writeFileSync(
      path.join(root, "quoted", "SKILL.md"),
      '---\nname: "quoted"\ndescription: "整理引号内的简介"\n---\n# 引号\n',
      "utf8",
    );
    fs.mkdirSync(path.join(root, "single"));
    fs.writeFileSync(
      path.join(root, "single", "SKILL.md"),
      "---\nname: 'single'\ndescription: '单引号简介'\n---\n# 单引号\n",
      "utf8",
    );
    fs.mkdirSync(path.join(root, "folded"));
    fs.writeFileSync(
      path.join(root, "folded", "SKILL.md"),
      [
        "---",
        "name: folded",
        "description: >-",
        "  读取并整理笔记。",
        "  在用户询问笔记时使用。",
        "---",
        "# 折叠",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(root, "literal"));
    fs.writeFileSync(
      path.join(root, "literal", "SKILL.md"),
      [
        "---",
        "name: literal",
        "description: |",
        "  第一行简介。",
        "  第二行简介。",
        "---",
        "# 保留换行",
        "",
      ].join("\n"),
      "utf8",
    );
    const library = new SkillLibrary(root);
    const byDirectory = new Map(
      library.list().map((skill) => [skill.directory, skill]),
    );
    assert.equal(byDirectory.get("quoted")?.name, "quoted");
    assert.equal(byDirectory.get("quoted")?.description, "整理引号内的简介");
    assert.equal(library.read("quoted").directory, "quoted");
    assert.equal(byDirectory.get("single")?.description, "单引号简介");
    assert.equal(
      byDirectory.get("folded")?.description,
      "读取并整理笔记。 在用户询问笔记时使用。",
    );
    assert.equal(
      byDirectory.get("literal")?.description,
      "第一行简介。\n第二行简介。",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skill library loads metadata, body and referenced files on demand", () => {
  const root = createSkillsRoot();
  try {
    const library = new SkillLibrary(root);
    const skills = library.list();
    assert.equal(skills.length, 1);
    assert.deepEqual(skills[0], {
      name: "meeting-notes",
      description: "整理会议记录与待办",
      directory: "meeting-notes",
    });
    const skill = library.read("meeting-notes");
    assert.match(skill.body, /先读取 reference\.md/);
    assert.equal(skill.name, "meeting-notes");
    const reference = library.readFile("meeting-notes", "reference.md");
    assert.equal(reference.path, "reference.md");
    assert.match(reference.content, /参会人/);
    assert.throws(
      () => library.read("missing"),
      (error: unknown) => error instanceof SkillNotFoundError,
    );
    assert.throws(
      () => library.readFile("meeting-notes", "../README.md"),
      (error: unknown) => error instanceof SkillFileInvalidError,
    );
    assert.throws(
      () => library.readFile("meeting-notes", path.join(root, "outside.md")),
      (error: unknown) => error instanceof SkillFileInvalidError,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
