"use strict";
/**
 * 桌面壳启动托管后端时的目录解析（DL-153 / 310 §3.2）。
 * 开发仓库与打包产物布局不同，这里统一给出后端入口、预置素材与 Node 运行时位置，
 * 避免把源码相对路径写死在启动逻辑里，也便于离线单测。
 */
const { join, resolve } = require("node:path");

/**
 * @param {{ isPackaged?: boolean, resourcesPath?: string, dirname: string, env?: Record<string, string | undefined> }} input
 * @returns {{ mode: "workspace" | "packaged" | "override", backendRoot: string, entry: string, presetAssetsDir: string, nodeRuntime: string | null }}
 */
function resolveBackendLayout(input) {
  const env = input.env || {};
  const isPackaged = input.isPackaged === true;
  const resourcesPath = input.resourcesPath || join(input.dirname, "..");
  const runtimeDir = isPackaged ? join(resourcesPath, "node-runtime") : resolve(input.dirname, "..", "..", "prototypes", "p0", ".runtime", "node-v24.22.2-win-x64");
  const nodeRuntime = join(runtimeDir, "node.exe");

  // 显式覆盖优先：联调与隔离构建产物用 NOWADAYS_BACKEND_ROOT 指到指定目录。
  if (env.NOWADAYS_BACKEND_ROOT) {
    const backendRoot = resolve(env.NOWADAYS_BACKEND_ROOT);
    return {
      mode: "override",
      backendRoot,
      entry: join(backendRoot, "src", "main.ts"),
      presetAssetsDir: resolve(env.NOWADAYS_PRESET_ASSETS_DIR || join(backendRoot, "assets", "presets")),
      nodeRuntime
    };
  }

  const backendRoot = isPackaged ? join(resourcesPath, "backend") : resolve(input.dirname, "..", "..", "backend");
  // 打包产物把预置素材单独放 resources/preset-assets，其余场景用仓库内的 backend/assets/presets。
  const presetAssetsDir = resolve(env.NOWADAYS_PRESET_ASSETS_DIR || (isPackaged ? join(resourcesPath, "preset-assets") : join(backendRoot, "assets", "presets")));
  return {
    mode: isPackaged ? "packaged" : "workspace",
    backendRoot,
    entry: join(backendRoot, "src", "main.ts"),
    presetAssetsDir,
    nodeRuntime
  };
}

/**
 * 选择运行后端的 Node 24 可执行文件：包内运行时 → 环境变量 → 仓库运行时 → PATH 上的 node。
 * @param {{ layout: { nodeRuntime: string | null }, env?: Record<string, string | undefined>, exists: (path: string) => boolean }} input
 */
function resolveNodeExecutable(input) {
  const env = input.env || {};
  const candidates = [
    input.layout.nodeRuntime || "",
    env.NOWADAYS_NODE_PATH || ""
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (input.exists(candidate)) return candidate;
  }
  return "node";
}

module.exports = { resolveBackendLayout, resolveNodeExecutable };
