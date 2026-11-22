#!/usr/bin/env node
/**
 * 仓库迁移辅助：把历史文档中的路径与本地链接从旧布局重写到当前布局。
 * 仅处理相对链接与已知路径前缀，不动外部链接与页内锚点。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(root, "docs");

const TARGET_MOVES = [
  ["desktop/desk-preview/tools/", "tools/art-pipeline/"],
  ["desktop/desk-preview/", "apps/desktop/"],
  ["desktop/scripts/", "apps/desktop/scripts/"],
  ["apps/backend/test-results/", "test-results/backend-acceptance/"],
  ["backend/test-results/", "test-results/backend-acceptance/"],
  ["backend/", "apps/backend/"],
  ["devDoc/", "docs/"],
];

const RENDERER_JS_TO_TS = [
  "appearance-import",
  "image-config",
  "outfit-display",
  "state-version",
  "token-usage",
  "voice-config",
  "components/appearance/preset-lock",
  "components/config/config-texts",
  "components/config/summary",
  "components/image/image-cache",
  "components/model/binding-merge",
  "components/model/model-cache",
  "components/model/model-picker",
  "components/voice/voice-cache",
  "conversation/advance",
  "conversation/fixtures",
  "conversation/history",
  "conversation/performance",
  "conversation/task-actions",
  "conversation/typing-state",
  "conversation/window-model",
  "entry/role-entry",
  "relations/dossier",
  "relations/fold-marks",
];

const EXACT_MOVES = new Map([
  ...RENDERER_JS_TO_TS.flatMap((mod) => [
    [`apps/desktop/renderer/src/${mod}.js`, `apps/desktop/renderer/src/${mod}.ts`],
    [`apps/desktop/renderer/src/${mod}.d.ts`, `apps/desktop/renderer/src/${mod}.ts`],
  ]),
  ["apps/desktop/renderer/src/Relations.tsx", "apps/desktop/renderer/src/pages/Relations.tsx"],
  ["apps/desktop/renderer/src/ui/relationship-journal.css", "apps/desktop/renderer/src/styles/relationship-journal.css"],
  ["apps/desktop/renderer/src/ui/relationship-journal-integration.css", "apps/desktop/renderer/src/styles/relationship-journal-integration.css"],
  ["apps/desktop/renderer/src/ui/relationship-journal-transition.css", "apps/desktop/renderer/src/styles/relationship-journal-transition.css"],
  ["apps/desktop/renderer/src/relations/memory-correction.css", "apps/desktop/renderer/src/styles/memory-correction.css"],
  ["apps/desktop/renderer/src/studio-overrides.css", "apps/desktop/renderer/src/styles/studio-overrides.css"],
  ...[
    "appearance-import",
    "binding-merge",
    "config-texts",
    "conversation-advance",
    "conversation-performance",
    "conversation-typing",
    "conversation-window-model",
    "image-config",
    "model-cache",
    "model-picker",
    "outfit-display",
    "pack3-entry",
    "relations-dossier",
    "state-version",
    "summary-derive",
    "token-usage",
    "voice-config",
    "voice-engines-emotion",
  ].map((name) => [
    `apps/desktop/tests/unit/${name}.test.cjs`,
    `apps/desktop/renderer/tests/${name}.test.ts`,
  ]),
  ...[
    ["conversation", ["agent-context.ts", "agent-graph.ts", "agent-tools.ts", "autonomy-service.ts", "conversation-history.ts", "conversation-service.ts", "input-state.ts", "message-service.ts", "segment-annotation-service.ts"]],
    ["memory", ["memory-query-service.ts", "memory-read-projection.ts", "memory-runtime.ts", "memory-service.ts"]],
    ["role", ["admin-tools.ts", "preset-assistant.ts", "role-access.ts", "role-activity-service.ts", "role-card-dialogue.ts", "role-deletion-service.ts", "role-service.ts"]],
    ["transfer", ["role-transfer.ts", "role-transfer-bindings.ts", "role-transfer-credentials.ts", "role-transfer-data.ts", "role-transfer-files.ts", "role-transfer-package.ts", "role-transfer-publication.ts"]],
    ["media", ["appearance-service.ts", "audio-inspect.ts", "global-voice-service.ts", "image-inspect.ts", "image-service.ts", "media-maintenance.ts", "scene-image-service.ts", "scene-image-settings.ts", "voice-service.ts"]],
    ["resources", ["credential-resolver.ts", "model-binding-resolver.ts", "model-maintenance.ts", "model-service.ts", "resource-service.ts", "token-usage-service.ts"]],
  ].flatMap(([sub, files]) =>
    files.map((f) => [`apps/backend/src/application/${f}`, `apps/backend/src/application/${sub}/${f}`]),
  ),
  ...[
    ["core", ["app-store.ts", "installation-lock.ts", "role-storage.ts", "schema.ts", "secret-store.ts", "token-usage-store.ts", "transaction-group.ts"]],
    ["conversation", ["autonomy-store.ts", "checkpoint-store.ts", "conversation-store.ts", "web-reading.ts"]],
    ["memory", ["evidence.ts", "memory-store.ts"]],
    ["role", ["role-activity-store.ts", "role-store.ts", "worldbook-store.ts"]],
    ["media", ["appearance-store.ts", "image-service-store.ts", "scene-image-settings-store.ts", "scene-image-store.ts", "scene-reference.ts", "voice-service-store.ts", "voice-store.ts"]],
  ].flatMap(([sub, files]) =>
    files.map((f) => [`apps/backend/src/storage/${f}`, `apps/backend/src/storage/${sub}/${f}`]),
  ),
  // Wave 6：后端 tests / fixtures / acceptance / scripts 重组
  ["apps/backend/tests/config-write.ts", "apps/backend/tests/fixtures/config-write.ts"],
  ["apps/backend/tests/legacy-role-fixture.ts", "apps/backend/tests/fixtures/legacy-role-fixture.ts"],
  ["apps/backend/tests/p2-05-fixture.ts", "apps/backend/tests/fixtures/conversation-fixture.ts"],
  ["apps/backend/tests/fixtures/p2-zh-memory.json", "apps/backend/tests/fixtures/zh-memory.json"],
  ["apps/backend/tests/model-providers.test.ts", "apps/backend/tests/unit/model-providers.test.ts"],
  ["apps/backend/tests/role-card-dialogue.test.ts", "apps/backend/tests/unit/role-card-dialogue.test.ts"],
  ["apps/backend/tests/p1-02-storage.test.ts", "apps/backend/tests/unit/storage-schema.test.ts"],
  ["apps/backend/tests/p2-04-continuation.test.ts", "apps/backend/tests/unit/model-continuation.test.ts"],
  ["apps/backend/tests/p2-04-google-gemini.test.ts", "apps/backend/tests/unit/google-gemini.test.ts"],
  ["apps/backend/tests/p2-04-mcp.test.ts", "apps/backend/tests/unit/mcp-local.test.ts"],
  ["apps/backend/tests/p2-04-model.test.ts", "apps/backend/tests/unit/model-protocols.test.ts"],
  ["apps/backend/tests/p2-04-skill.test.ts", "apps/backend/tests/unit/skill-library.test.ts"],
  ["apps/backend/tests/p3-01-autonomy-store.test.ts", "apps/backend/tests/unit/autonomy-store.test.ts"],
  ["apps/backend/tests/p9-tts-engines-emotion.test.ts", "apps/backend/tests/unit/tts-engines-emotion.test.ts"],
  ["apps/backend/tests/p19-model-maintenance.test.ts", "apps/backend/tests/unit/model-maintenance.test.ts"],
  ["apps/backend/tests/p21-media-maintenance.test.ts", "apps/backend/tests/unit/media-maintenance.test.ts"],
  ["apps/backend/tests/p22-agent-context.test.ts", "apps/backend/tests/unit/agent-context.test.ts"],
  ["apps/backend/tests/p25-role-transfer-package.test.ts", "apps/backend/tests/unit/role-transfer-package.test.ts"],
  ["apps/backend/tests/p26-token-usage.test.ts", "apps/backend/tests/unit/token-usage.test.ts"],
  ["apps/backend/tests/p27-worldbooks.test.ts", "apps/backend/tests/unit/worldbooks.test.ts"],
  ["apps/backend/tests/feed-pagination.test.ts", "apps/backend/tests/integration/feed-pagination.test.ts"],
  ["apps/backend/tests/p1-03-role-message.test.ts", "apps/backend/tests/integration/role-message.test.ts"],
  ["apps/backend/tests/p1-04-resource-task.test.ts", "apps/backend/tests/integration/resource-task.test.ts"],
  ["apps/backend/tests/p1-05-api-cli.test.ts", "apps/backend/tests/integration/api-cli-smoke.test.ts"],
  ["apps/backend/tests/p2-02-memory.test.ts", "apps/backend/tests/integration/memory-formation.test.ts"],
  ["apps/backend/tests/p2-03-memory-claim-correction.test.ts", "apps/backend/tests/integration/memory-claim-correction.test.ts"],
  ["apps/backend/tests/p2-03-memory-query.test.ts", "apps/backend/tests/integration/memory-query.test.ts"],
  ["apps/backend/tests/p2-05-agent.test.ts", "apps/backend/tests/integration/agent-graph.test.ts"],
  ["apps/backend/tests/p2-05-api-cli.test.ts", "apps/backend/tests/integration/conversation-api-cli.test.ts"],
  ["apps/backend/tests/p2-05-conversation.test.ts", "apps/backend/tests/integration/conversation-loop.test.ts"],
  ["apps/backend/tests/p2-05-failure.test.ts", "apps/backend/tests/integration/conversation-failure.test.ts"],
  ["apps/backend/tests/p2-05-mcp.test.ts", "apps/backend/tests/integration/mcp-execution.test.ts"],
  ["apps/backend/tests/p2-05-memory-chain.test.ts", "apps/backend/tests/integration/memory-chain.test.ts"],
  ["apps/backend/tests/p2-05-memory-delivery.test.ts", "apps/backend/tests/integration/memory-delivery.test.ts"],
  ["apps/backend/tests/p2-05-recovery.test.ts", "apps/backend/tests/integration/conversation-recovery.test.ts"],
  ["apps/backend/tests/p2-05-skill.test.ts", "apps/backend/tests/integration/skill-execution.test.ts"],
  ["apps/backend/tests/p2-05-stream.test.ts", "apps/backend/tests/integration/model-stream.test.ts"],
  ["apps/backend/tests/p3-02-autonomy-runtime.test.ts", "apps/backend/tests/integration/autonomy-runtime.test.ts"],
  ["apps/backend/tests/p3-03-autonomy-scheduling.test.ts", "apps/backend/tests/integration/autonomy-scheduling.test.ts"],
  ["apps/backend/tests/p3-review-fixes.test.ts", "apps/backend/tests/integration/autonomy-boundaries.test.ts"],
  ["apps/backend/tests/p4-checkpoint-recovery.test.ts", "apps/backend/tests/integration/checkpoint-recovery.test.ts"],
  ["apps/backend/tests/p4-internal-recovery.test.ts", "apps/backend/tests/integration/internal-recovery.test.ts"],
  ["apps/backend/tests/p4-internal-startup.test.ts", "apps/backend/tests/integration/internal-startup.test.ts"],
  ["apps/backend/tests/p4-recovery.test.ts", "apps/backend/tests/integration/process-recovery.test.ts"],
  ["apps/backend/tests/p4-user-recovery.test.ts", "apps/backend/tests/integration/user-recovery.test.ts"],
  ["apps/backend/tests/p5-background-tools.test.ts", "apps/backend/tests/integration/background-tools.test.ts"],
  ["apps/backend/tests/p5-diary.test.ts", "apps/backend/tests/integration/diary-lifecycle.test.ts"],
  ["apps/backend/tests/p5-memory-capacity.test.ts", "apps/backend/tests/integration/memory-capacity.test.ts"],
  ["apps/backend/tests/p5-reconcile.test.ts", "apps/backend/tests/integration/reconcile-unknown.test.ts"],
  ["apps/backend/tests/p5-skill-run.test.ts", "apps/backend/tests/integration/skill-run.test.ts"],
  ["apps/backend/tests/p5-task-decisions.test.ts", "apps/backend/tests/integration/task-decisions.test.ts"],
  ["apps/backend/tests/p6-appearance.test.ts", "apps/backend/tests/integration/appearance-management.test.ts"],
  ["apps/backend/tests/p6-daily-outfit.test.ts", "apps/backend/tests/integration/daily-outfit.test.ts"],
  ["apps/backend/tests/p7-performance.test.ts", "apps/backend/tests/integration/conversation-performance.test.ts"],
  ["apps/backend/tests/p8-voice.test.ts", "apps/backend/tests/integration/voice-tts.test.ts"],
  ["apps/backend/tests/p9-tts-unified.test.ts", "apps/backend/tests/integration/tts-unified.test.ts"],
  ["apps/backend/tests/p10-auto-scene.test.ts", "apps/backend/tests/integration/scene-image-auto.test.ts"],
  ["apps/backend/tests/p10-scene-image.test.ts", "apps/backend/tests/integration/scene-image-core.test.ts"],
  ["apps/backend/tests/p11-scene-image-planning.test.ts", "apps/backend/tests/integration/scene-image-planning.test.ts"],
  ["apps/backend/tests/p12-role-settings.test.ts", "apps/backend/tests/integration/role-settings.test.ts"],
  ["apps/backend/tests/p13-comfyui.test.ts", "apps/backend/tests/integration/comfyui-client.test.ts"],
  ["apps/backend/tests/p14-role-activity.test.ts", "apps/backend/tests/integration/role-activity.test.ts"],
  ["apps/backend/tests/p15-resource-management.test.ts", "apps/backend/tests/integration/resource-management.test.ts"],
  ["apps/backend/tests/p16-role-deletion.test.ts", "apps/backend/tests/integration/role-deletion.test.ts"],
  ["apps/backend/tests/p17-message-receipt.test.ts", "apps/backend/tests/integration/message-receipt.test.ts"],
  ["apps/backend/tests/p18-278-review-fixes.test.ts", "apps/backend/tests/integration/workflow-simplification-fixes.test.ts"],
  ["apps/backend/tests/p19-preset-assistant-pack1.test.ts", "apps/backend/tests/integration/preset-assistant-core.test.ts"],
  ["apps/backend/tests/p20-preset-assistant-pack2.test.ts", "apps/backend/tests/integration/preset-assistant-outfits.test.ts"],
  ["apps/backend/tests/p21-pack3-preset-assets.test.ts", "apps/backend/tests/integration/preset-assistant-assets.test.ts"],
  ["apps/backend/tests/p22-first-activation.test.ts", "apps/backend/tests/integration/first-activation.test.ts"],
  ["apps/backend/tests/p23-web-reading.test.ts", "apps/backend/tests/integration/web-reading.test.ts"],
  ["apps/backend/tests/p26-role-transfer.test.ts", "apps/backend/tests/integration/role-transfer.test.ts"],
  ["apps/backend/reviews/20261104-p2-05-review.ts", "apps/backend/tests/acceptance/conversation-review.acceptance.ts"],
  ["apps/backend/reviews/20261104-p2-05-fix-recheck.ts", "apps/backend/tests/acceptance/conversation-fixes.acceptance.ts"],
  ["apps/backend/reviews/20261104-p2-05-model-continuation.ts", "apps/backend/tests/acceptance/model-continuation.acceptance.ts"],
  ["apps/backend/reviews/20261104-p2-06-acceptance.ts", "apps/backend/tests/acceptance/delivery-pipeline.acceptance.ts"],
  ["apps/backend/reviews/20261104-p3-review.ts", "apps/backend/tests/acceptance/autonomy-review.acceptance.ts"],
  ["apps/backend/reviews/20261104-p3-fix-recheck.ts", "apps/backend/tests/acceptance/autonomy-fixes.acceptance.ts"],
  ["apps/backend/reviews/20261104-p3-reservation-boundary-review.ts", "apps/backend/tests/acceptance/autonomy-reservation-boundary.acceptance.ts"],
  ["apps/backend/reviews/20261104-p4-acceptance.ts", "apps/backend/tests/acceptance/recovery-acceptance.acceptance.ts"],
  ["apps/backend/reviews/20261104-p4-recovery-recheck.ts", "apps/backend/tests/acceptance/recovery-recheck.acceptance.ts"],
  ["apps/backend/reviews/20261105-p4-remaining-acceptance.ts", "apps/backend/tests/acceptance/recovery-remaining.acceptance.ts"],
  ["apps/backend/reviews/20261106-p5-background-tools.ts", "apps/backend/tests/acceptance/background-tools.acceptance.ts"],
  ["apps/backend/reviews/20261106-p5-task-decisions.ts", "apps/backend/tests/acceptance/task-decisions.acceptance.ts"],
  ["apps/backend/reviews/20261106-p5-reconcile-unknown.ts", "apps/backend/tests/acceptance/reconcile-unknown.acceptance.ts"],
  ["apps/backend/reviews/20261106-p5-memory-capacity.ts", "apps/backend/tests/acceptance/memory-capacity.acceptance.ts"],
  ["apps/backend/reviews/20261106-p5-skill-run.ts", "apps/backend/tests/acceptance/skill-run.acceptance.ts"],
  ["apps/backend/reviews/20261106-p5-diary-read.ts", "apps/backend/tests/acceptance/diary-read.acceptance.ts"],
  ["apps/backend/reviews/20261104-p2-06-real-diagnostics.ts", "apps/backend/scripts/eval/real-model-diagnostics.ts"],
  ["apps/backend/reviews/20261104-p2-06-real-model.ts", "apps/backend/scripts/eval/real-model-smoke.ts"],
  ["apps/backend/scripts/accept-offline.mjs", "apps/backend/scripts/verify/accept-offline.mjs"],
  ["apps/backend/scripts/acceptance-lib.mjs", "apps/backend/scripts/verify/acceptance-lib.mjs"],
  ["apps/backend/scripts/acceptance.test.mjs", "apps/backend/scripts/verify/acceptance.test.mjs"],
  ["apps/backend/scripts/fs-guard.mjs", "apps/backend/scripts/verify/fs-guard.mjs"],
  ["apps/backend/scripts/process-smoke.ts", "apps/backend/scripts/verify/process-smoke.ts"],
  ...[
    "role-boundary-cases.mjs", "role-boundary-delivery.mjs", "role-boundary-wire.mjs",
    "role-boundary-wire.test.mjs", "role-life-aging-dialogue.mjs", "role-life-change.mjs",
    "role-live-evidence.mjs", "role-live-matrix.mjs", "role-prompt-ablation.mjs",
    "role-world-http-fixtures.mjs", "role-world-http-fixtures.test.mjs", "role-world-http-summary.mjs",
    "role-world-http-transport.mjs", "role-world-http.mjs", "role-world-scenarios.mjs",
    "score-role-dialogue.mjs", "score-role-dialogue.test.mjs", "summarize-world-dialogue.mjs",
    "verify-role-life-http.mjs",
  ].map((s) => [`apps/backend/scripts/${s}`, `apps/backend/scripts/eval/${s}`]),
]);

function toOldDocPath(file) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  if (rel.startsWith("docs/")) return `devDoc/${rel.slice("docs/".length)}`;
  if (rel.startsWith("apps/backend/")) return `backend/${rel.slice("apps/backend/".length)}`;
  if (rel.startsWith("apps/desktop/")) return `desktop/desk-preview/${rel.slice("apps/desktop/".length)}`;
  return rel;
}

function testTarget(name) {
  if (["unit/", "helpers/", "integration/", "e2e/", "live/"].some((sub) => name.startsWith(sub))) {
    return `apps/desktop/tests/${name}`;
  }
  if (["electron-executable.cjs", "config-page-controls.cjs", "run-e2e.cjs"].includes(name)) {
    return `apps/desktop/tests/helpers/${name}`;
  }
  if (name === "feed-integration.test.ts") return "apps/desktop/tests/integration/feed-integration.test.ts";
  if (name.endsWith(".test.cjs")) return `apps/desktop/tests/unit/${name}`;
  if (name.endsWith("-check.cjs")) return `apps/desktop/tests/e2e/${name.slice(0, -"-check.cjs".length)}.e2e.cjs`;
  if (name === "relations-review-234.cjs") return "apps/desktop/tests/e2e/relations-review-234.e2e.cjs";
  if (name.endsWith(".mjs") || name.endsWith(".py")) return `apps/desktop/tests/live/${name}`;
  return null;
}

function normalizeTarget(oldTarget) {
  for (const prefix of ["desktop/desk-preview/tests/", "apps/desktop/tests/"]) {
    if (oldTarget.startsWith(prefix)) {
      const mapped = testTarget(oldTarget.slice(prefix.length));
      if (mapped) return mapped;
    }
  }
  if (oldTarget.startsWith("apps/desktop/")) {
    const name = oldTarget.slice("apps/desktop/".length);
    if (["main.cjs", "settings-preload.cjs", "backend-paths.cjs"].includes(name)) return `apps/desktop/electron/${name}`;
  }
  if (oldTarget.startsWith("desktop/desk-preview/tests/")) {
    const name = oldTarget.slice("desktop/desk-preview/tests/".length);
    const mapped = testTarget(name);
    if (mapped) return mapped;
  }
  if (["main.cjs", "settings-preload.cjs", "backend-paths.cjs"].includes(oldTarget.slice("desktop/desk-preview/".length))) {
    return `apps/desktop/electron/${oldTarget.slice("desktop/desk-preview/".length)}`;
  }
  if (oldTarget === "desktop/desk-preview/package.json") return "apps/desktop/package.json";
  if (oldTarget === "desktop/desk-preview/ART-GENERATION-GUIDE.md") return "apps/desktop/ART-GENERATION-GUIDE.md";
  for (const [from, to] of TARGET_MOVES) {
    if (oldTarget === from.slice(0, -1)) return to.slice(0, -1);
    if (oldTarget.startsWith(from)) return `${to}${oldTarget.slice(from.length)}`;
  }
  return oldTarget;
}

function mapTarget(oldTarget) {
  let current = normalizeTarget(oldTarget);
  for (let i = 0; i < 4; i += 1) {
    const next = EXACT_MOVES.get(current);
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

function rewriteLinks(file, text) {
  const oldDoc = path.join(root, toOldDocPath(file));
  const oldDir = path.dirname(oldDoc);
  const newDir = path.dirname(file);
  return text.replace(/(!?\[[^\]\n]*\]\()([^)\n]+)(\))/g, (whole, open, inner, close) => {
    const trimmed = inner.trim();
    if (!trimmed || /^(?:https?:|mailto:|#|file:)/i.test(trimmed) || trimmed.startsWith("<")) return whole;
    const hashIndex = trimmed.indexOf("#");
    const queryIndex = trimmed.indexOf("?");
    const cut = [hashIndex, queryIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? trimmed.length;
    const targetPart = trimmed.slice(0, cut);
    const suffix = trimmed.slice(cut);
    const lineMatch = /:\d+(?:-\d+)?$/.exec(targetPart);
    const lineSuffix = lineMatch ? lineMatch[0] : "";
    const pureTarget = lineMatch ? targetPart.slice(0, -lineSuffix.length) : targetPart;
    if (!pureTarget) return whole;
    const oldResolved = path.resolve(oldDir, pureTarget);
    const oldRelative = path.relative(root, oldResolved).split(path.sep).join("/");
    const mapped = mapTarget(oldRelative);
    if (mapped === oldRelative) return whole;
    const newResolved = path.resolve(root, mapped);
    // 已退役文件不制造“看似存在”的新路径；历史链接保留旧目标，由文档巡检白名单登记。
    if (!fs.existsSync(newResolved)) return whole;
    let relative = path.relative(newDir, newResolved).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    return `${open}${relative}${lineSuffix}${suffix}${close}`;
  });
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

const files = [
  ...walk(docsDir),
  path.join(root, "README.md"),
  path.join(root, "AGENTS.md"),
  path.join(root, "apps", "backend", "README.md"),
  path.join(root, "apps", "desktop", "ART-GENERATION-GUIDE.md"),
].filter((file) => fs.existsSync(file));
for (const file of files) {
  let text = fs.readFileSync(file, "utf8");
  const original = text;
  text = rewriteLinks(file, text);
  text = text
    .replace(/(?<![A-Za-z0-9_./-])desktop\/desk-preview\/tools\//g, "tools/art-pipeline/")
    .replace(/(?<![A-Za-z0-9_./-])desktop\/desk-preview\//g, "apps/desktop/")
    .replace(/(?<![A-Za-z0-9_./-])desktop\/scripts\//g, "apps/desktop/scripts/")
    .replace(/(?<![A-Za-z0-9_./-])backend\//g, "apps/backend/")
    .replace(/devDoc\//g, "docs/")
    .replace(/(?<![A-Za-z0-9_./-])cd backend\b/g, "cd apps/backend")
    .replace(/Set-Location ([^\r\n]*?)(?<!\\apps)\\backend\b/g, "Set-Location $1\\apps\\backend");
  if (text !== original) {
    fs.writeFileSync(file, text);
    console.log(path.relative(root, file));
  }
}
console.log(`已重写 ${files.length} 份 Markdown 的候选链接。`);
