// 409 UX-05：工作空间笔记格式化与单角色迁移门禁的纯逻辑。
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatNoteBytes,
  pickSelectedNotePath,
  type WorkspaceNoteSummary
} from "../src/components/config/role/workspace-notes.ts";
import {
  canApplyTransfer,
  candidatesForBinding,
  transferCapabilityLabel,
  transferRelationMeta,
  type TransferBinding,
  type TransferPreview,
  type TransferRelation
} from "../src/components/config/role-transfer.ts";

const note = (relativePath: string): WorkspaceNoteSummary => ({
  relativePath,
  name: relativePath.split("/").at(-1) ?? relativePath,
  sizeBytes: 1024,
  updatedAt: "2026-11-27T08:00:00.000Z"
});

const binding = (
  capability: TransferBinding["capability"],
  category: TransferBinding["category"]
): TransferBinding => ({
  key: `${capability}-1`,
  capability,
  category,
  sourceResourceId: "source-resource",
  modelName: null,
  enabled: true
});

const preview = (overrides: Partial<TransferPreview> = {}): TransferPreview => ({
  roleId: "role-1",
  displayName: "林窗",
  localActivityState: null,
  token: "preview-token",
  relation: "same",
  requiresChoice: false,
  packageDigest: "package-digest",
  localFingerprint: null,
  packageFingerprint: "package-fingerprint",
  registered: true,
  bindings: [],
  unresolved: [],
  ...overrides
});

const catalogs = {
  resources: [
    { resourceId: "model-1", kind: "model", name: "对话模型 A" },
    { resourceId: "mcp-1", kind: "mcp", name: "MCP 工具 A" },
    { resourceId: "skill-1", kind: "skill", name: "Skill 知识 A" }
  ],
  voiceServices: [{ serviceId: "voice-1", name: "语音服务 A" }],
  imageServices: [{ serviceId: "image-1", name: "生图服务 A" }]
};

test("formatNoteBytes：按 1024 进位并压低小数", () => {
  assert.equal(formatNoteBytes(0), "0 B");
  assert.equal(formatNoteBytes(-8), "0 B");
  assert.equal(formatNoteBytes(Number.NaN), "0 B");
  assert.equal(formatNoteBytes(512), "512 B");
  assert.equal(formatNoteBytes(1024), "1 KB");
  assert.equal(formatNoteBytes(1536), "1.5 KB");
  assert.equal(formatNoteBytes(1024 * 1024), "1 MB");
});

test("pickSelectedNotePath：空列表清空选择，失效路径退回第一条", () => {
  const items = [note("drafts/b.md"), note("notes/a.md")];
  assert.equal(pickSelectedNotePath([], "notes/a.md"), "");
  assert.equal(pickSelectedNotePath(items, "notes/a.md"), "notes/a.md");
  assert.equal(pickSelectedNotePath(items, "removed.md"), "drafts/b.md");
  assert.equal(pickSelectedNotePath(items, ""), "drafts/b.md");
});

test("transferRelationMeta：每种关系都有可见标签、说明与状态色调", () => {
  const relations: TransferRelation[] = ["new", "same", "package-ahead", "local-ahead", "diverged", "unknown"];
  for (const relation of relations) {
    const meta = transferRelationMeta(relation);
    assert.ok(meta.label.length > 0, `${relation} 缺少标签`);
    assert.ok(meta.detail.length > 0, `${relation} 缺少说明`);
    assert.ok(["ok", "dirty", "error", "off"].includes(meta.tone), `${relation} 色调非法`);
  }
  assert.equal(transferRelationMeta("diverged").tone, "error");
});

test("transferCapabilityLabel：能力与分类都能得到中文标签", () => {
  assert.equal(transferCapabilityLabel("chat_model"), "对话模型");
  assert.equal(transferCapabilityLabel("memory_model"), "记忆模型");
  assert.equal(transferCapabilityLabel("mcp"), "MCP 工具");
  assert.equal(transferCapabilityLabel("skill"), "Skill 知识");
  assert.equal(transferCapabilityLabel("voice"), "语音服务");
  assert.equal(transferCapabilityLabel("image"), "生图服务");
});

test("candidatesForBinding：按类别挑选本机资源与服务", () => {
  assert.deepEqual(candidatesForBinding(binding("chat_model", "model"), catalogs), [{ id: "model-1", name: "对话模型 A" }]);
  assert.deepEqual(candidatesForBinding(binding("mcp", "mcp"), catalogs), [{ id: "mcp-1", name: "MCP 工具 A" }]);
  assert.deepEqual(candidatesForBinding(binding("skill", "skill"), catalogs), [{ id: "skill-1", name: "Skill 知识 A" }]);
  assert.deepEqual(candidatesForBinding(binding("voice", "voice"), catalogs), [{ id: "voice-1", name: "语音服务 A" }]);
  assert.deepEqual(candidatesForBinding(binding("image", "image"), catalogs), [{ id: "image-1", name: "生图服务 A" }]);
});

test("canApplyTransfer：没有预检结果不放行", () => {
  assert.deepEqual(canApplyTransfer(null, null), { allowed: false, reason: "请先预检角色包。" });
});

test("canApplyTransfer：角色未停止时即使选了时间线也不放行", () => {
  for (const localActivityState of ["active", "stopping"] as const) {
    const gate = canApplyTransfer(preview({ localActivityState, requiresChoice: true }), "package");
    assert.equal(gate.allowed, false);
    assert.equal(gate.reason, "请先停止角色活动后再导入。");
  }
});

test("canApplyTransfer：分化时间线缺少选择时被拒", () => {
  const diverged = preview({ relation: "diverged", requiresChoice: true, localActivityState: "stopped" });
  assert.deepEqual(canApplyTransfer(diverged, null), { allowed: false, reason: "请选择要保留的时间线。" });
});

test("canApplyTransfer：选择 package 或 local 后放行，一致时无需选择", () => {
  const diverged = preview({ relation: "diverged", requiresChoice: true, localActivityState: "stopped" });
  assert.equal(canApplyTransfer(diverged, "package").allowed, true);
  assert.equal(canApplyTransfer(diverged, "local").allowed, true);
  assert.equal(canApplyTransfer(preview({ relation: "same", localActivityState: "stopped" }), null).allowed, true);
});
