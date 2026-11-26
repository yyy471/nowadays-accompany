"use strict";

// 桌面壳的后端与预置素材布局（310 §3.2）。运行：在 apps/desktop 下执行 `npm test`。
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveBackendLayout, resolveNodeExecutable } = require("../../electron/backend-paths.cjs");

const dirname = path.resolve(__dirname, "../../electron");
const noExists = () => false;

test("开发仓库：后端在仓库内，预置素材指向 backend/assets/presets", () => {
  const layout = resolveBackendLayout({ isPackaged: false, dirname, env: {} });
  assert.equal(layout.mode, "workspace");
  assert.equal(layout.piMcpRoot, path.resolve(dirname, "..", "..", "pi-mcp"));
  assert.equal(layout.backendRoot, path.resolve(dirname, "..", "..", "backend"));
  assert.equal(layout.entry, path.join(layout.backendRoot, "src", "main.ts"));
  assert.equal(layout.presetAssetsDir, path.join(layout.backendRoot, "assets", "presets"));
  assert.equal(layout.nodeRuntime, path.resolve(dirname, "..", "..", "..", ".tools", "node-v24", "node.exe"));
});

test("打包产物：后端与预置素材都从 resources 读取", () => {
  const resourcesPath = path.join("C:", "Apps", "Nowadays", "resources");
  const layout = resolveBackendLayout({ isPackaged: true, resourcesPath, dirname, env: {} });
  assert.equal(layout.mode, "packaged");
  assert.equal(layout.piMcpRoot, path.join(resourcesPath, "pi-mcp"));
  assert.equal(layout.backendRoot, path.join(resourcesPath, "backend"));
  assert.equal(layout.presetAssetsDir, path.join(resourcesPath, "preset-assets"));
  assert.equal(layout.nodeRuntime, path.join(resourcesPath, "node-runtime", "node.exe"));
});

test("Pi 子包自带源码与独立运行依赖，显式根目录覆盖两种布局", () => {
  const resources = require("../../package.json").build.extraResources;
  assert.ok(resources.some(item => item.to === "node-runtime" && item.filter.includes("node.exe")));
  const pi = resources.find(item => item.to === "pi-mcp");
  assert.equal(pi.from, "../pi-mcp");
  for (const included of ["src/**/*", "package.json"]) assert.ok(pi.filter.includes(included));
  // electron-builder 会跳过 FileSet 根目录下名为 node_modules 的子目录。
  for (const app of ["backend", "pi-mcp"]) {
    assert.ok(resources.some(item => item.from === `../${app}/node_modules` && item.to === `${app}/node_modules`));
  }
  const root = path.resolve(dirname, "custom pi");
  for (const isPackaged of [false, true]) {
    const layout = resolveBackendLayout({ dirname, isPackaged, env: { NOWADAYS_PI_MCP_ROOT: root } });
    assert.equal(layout.piMcpRoot, root);
  }
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

test("打包 Node 运行时按包内 → 环境变量 → PATH 的顺序回退", () => {
  const layout = resolveBackendLayout({ isPackaged: true, resourcesPath: path.join("C:", "resources"), dirname, env: {} });
  const envNode = path.join("D:", "node24", "node.exe");
  const bothExist = candidate => candidate === layout.nodeRuntime || candidate === envNode;
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: bothExist }), layout.nodeRuntime);
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: candidate => candidate === envNode }), envNode);
  assert.equal(resolveNodeExecutable({ layout, env: {}, exists: candidate => candidate === layout.nodeRuntime }), layout.nodeRuntime);
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: noExists }), "node");
});

test("开发 Node 运行时按环境变量 → 仓库工具目录 → PATH 的顺序回退", () => {
  const layout = resolveBackendLayout({ isPackaged: false, dirname, env: {} });
  const envNode = path.join("D:", "node24", "node.exe");
  const bothExist = candidate => candidate === layout.nodeRuntime || candidate === envNode;
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: bothExist }), envNode);
  assert.equal(resolveNodeExecutable({ layout, env: {}, exists: candidate => candidate === layout.nodeRuntime }), layout.nodeRuntime);
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: candidate => candidate === layout.nodeRuntime }), layout.nodeRuntime);
  assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: noExists }), "node");
});

test("显式覆盖布局保留开发与打包各自的 Node 优先级", () => {
  const envNode = path.join("D:", "node24", "node.exe");
  for (const isPackaged of [false, true]) {
    const layout = resolveBackendLayout({
      isPackaged,
      resourcesPath: path.join("C:", "resources"),
      dirname,
      env: { NOWADAYS_BACKEND_ROOT: path.join("D:", "backend") },
    });
    const bothExist = candidate => candidate === layout.nodeRuntime || candidate === envNode;
    const expected = isPackaged ? layout.nodeRuntime : envNode;
    assert.equal(resolveNodeExecutable({ layout, env: { NOWADAYS_NODE_PATH: envNode }, exists: bothExist }), expected);
  }
});
