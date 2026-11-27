"use strict";
/**
 * 桌面壳启动托管后端时的目录解析（DL-153 / 310 §3.2）。
 * 开发仓库与打包产物布局不同，这里统一给出后端入口、预置素材与 Node 运行时位置，
 * 避免把源码相对路径写死在启动逻辑里，也便于离线单测。
 */
const { join, resolve } = require("node:path");

/**
 * @param {{ isPackaged?: boolean, resourcesPath?: string, dirname: string, env?: Record<string, string | undefined> }} input
 * @returns {{ mode: "workspace" | "packaged" | "override", isPackaged: boolean, backendRoot: string, entry: string, nodeArgs: string[], presetAssetsDir: string, piMcpRoot: string, nodeRuntime: string | null }}
 */
function resolveBackendLayout(input) {
  const env = input.env || {};
  const isPackaged = input.isPackaged === true;
  const resourcesPath = input.resourcesPath || join(input.dirname, "..");
  const runtimeDir = isPackaged ? join(resourcesPath, "node-runtime") : resolve(input.dirname, "..", "..", "..", ".tools", "node-v24");
  const nodeRuntime = join(runtimeDir, "node.exe");
  const piMcpRoot = resolve(env.NOWADAYS_PI_MCP_ROOT || (isPackaged ? join(resourcesPath, "pi-mcp") : resolve(input.dirname, "..", "..", "pi-mcp")));

  // 显式覆盖优先：联调与隔离构建产物用 NOWADAYS_BACKEND_ROOT 指到指定目录。
  const compiled = env.NOWADAYS_BACKEND_ROOT ? env.NOWADAYS_BACKEND_RUNTIME === "compiled" : isPackaged;
  const entryParts = compiled ? ["dist", "main.js"] : ["src", "main.ts"];
  const nodeArgs = compiled ? [] : ["--import", "tsx"];
  if (env.NOWADAYS_BACKEND_ROOT) {
    const backendRoot = resolve(env.NOWADAYS_BACKEND_ROOT);
    return {
      mode: "override",
      piMcpRoot,
      isPackaged,
      backendRoot,
      entry: join(backendRoot, ...entryParts),
      nodeArgs,
      presetAssetsDir: resolve(env.NOWADAYS_PRESET_ASSETS_DIR || join(backendRoot, "assets", "presets")),
      nodeRuntime
    };
  }

  const backendRoot = isPackaged ? join(resourcesPath, "backend") : resolve(input.dirname, "..", "..", "backend");
  // 打包产物把预置素材单独放 resources/preset-assets，其余场景用仓库内的 backend/assets/presets。
  const presetAssetsDir = resolve(env.NOWADAYS_PRESET_ASSETS_DIR || (isPackaged ? join(resourcesPath, "preset-assets") : join(backendRoot, "assets", "presets")));
  return {
    mode: isPackaged ? "packaged" : "workspace",
    piMcpRoot,
    isPackaged,
    backendRoot,
    entry: join(backendRoot, ...entryParts),
    nodeArgs,
    presetAssetsDir,
    nodeRuntime
  };
}

/**
 * 选择运行后端的 Node 24 可执行文件。
 * 打包态：包内运行时 → 环境变量 → PATH；开发态：环境变量 → 仓库运行时 → PATH。
 * @param {{ layout: { nodeRuntime: string | null, isPackaged?: boolean, mode?: string }, env?: Record<string, string | undefined>, exists: (path: string) => boolean }} input
 */
function resolveNodeExecutable(input) {
  const env = input.env || {};
  const isPackaged = input.layout.isPackaged ?? input.layout.mode !== "workspace";
  const candidates = (isPackaged
    ? [input.layout.nodeRuntime || "", env.NOWADAYS_NODE_PATH || ""]
    : [env.NOWADAYS_NODE_PATH || "", input.layout.nodeRuntime || ""])
    .filter(Boolean);
  for (const candidate of candidates) {
    if (input.exists(candidate)) return candidate;
  }
  return "node";
}

module.exports = { resolveBackendLayout, resolveNodeExecutable };
