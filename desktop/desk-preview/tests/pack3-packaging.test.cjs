"use strict";

// 桌面壳的后端与预置素材布局（310 §3.2）。运行：在 desktop/desk-preview 下执行 `npm test`。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveBackendLayout, resolveNodeExecutable } = require("../backend-paths.cjs");

const dirname = path.join(__dirname, "..");
const noExists = () => false;

test("开发仓库：后端在仓库内，预置素材指向 backend/assets/presets", () => {
  const layout = resolveBackendLayout({ isPackaged: false, dirname, env: {} });
  assert.equal(layout.mode, "workspace");
  assert.equal(layout.backendRoot, path.resolve(dirname, "..", "..", "backend"));
  assert.equal(layout.entry, path.join(layout.backendRoot, "src", "main.ts"));
  assert.equal(layout.presetAssetsDir, path.join(layout.backendRoot, "assets", "presets"));
});

test("打包产物：后端与预置素材都从 resources 读取", () => {
  const resourcesPath = path.join("C:", "Apps", "Nowadays", "resources");
  const layout = resolveBackendLayout({ isPackaged: true, resourcesPath, dirname, env: {} });
  assert.equal(layout.mode, "packaged");
  assert.equal(layout.backendRoot, path.join(resourcesPath, "backend"));
  assert.equal(layout.presetAssetsDir, path.join(resourcesPath, "preset-assets"));
  assert.equal(layout.nodeRuntime, path.join(resourcesPath, "node-runtime", "node.exe"));
});

test("显式覆盖优先于开发与打包布局，预置素材可单独指定", () => {
  const root = path.join("D:", "tmp", "isolated-backend");
  const layout = resolveBackendLayout({
    isPackaged: true,
    resourcesPath: path.join("C:", "ignored"),
    dirname,
    env: { NOWADAYS_BACKEND_ROOT: root, NOWADAYS_PRESET_ASSETS_DIR: path.join("D:", "tmp", "presets") },
  });
  assert.equal(layout.mode, "override");
  assert.equal(layout.backendRoot, root);
  assert.equal(layout.entry, path.join(root, "src", "main.ts"));
  assert.equal(layout.presetAssetsDir, path.join("D:", "tmp", "presets"));
});

test("Node 运行时按包内 → 环境变量 → PATH 的顺序回退", () => {
  const layout = { nodeRuntime: path.join("C:", "runtime", "node.exe") };
  assert.equal(resolveNodeExecutable({ layout, env: {}, exists: candidate => candidate === layout.nodeRuntime }), layout.nodeRuntime);
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: "/opt/node24/bin/node" }, exists: candidate => candidate === "/opt/node24/bin/node" }), "/opt/node24/bin/node");
  assert.equal(resolveNodeExecutable({ layout, env: {}, exists: noExists }), "node");
});
