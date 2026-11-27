import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PORT = 3210;
export const LOOPBACK_HOST = "127.0.0.1";

const DEFAULT_PRESET_ASSETS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/presets",
);

export interface BackendConfig {
  appRoot: string;
  dataRoot: string;
  appDatabasePath: string;
  presetAssetsDir: string;
  port: number;
  host: typeof LOOPBACK_HOST;
  watchStdin: boolean;
  hostToken?: string;
  masterKey?: string;
  allowedOrigins?: string[];
  allowUnauthenticated?: boolean;
  warnFallbackMasterKey?: boolean;
}

export interface RolePaths {
  roleId: string;
  roleDir: string;
  businessDatabasePath: string;
  executionDatabasePath: string;
  workspaceDir: string;
  appearanceDir: string;
  voiceDir: string;
  sceneImageDir: string;
}

export function parseBackendConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  let appRoot: string | undefined;
  let presetAssetsDir: string | undefined;
  let port = DEFAULT_PORT;
  let watchStdin = false;
  let hostToken: string | undefined;
  let allowUnauthenticated = false;
  const cliOrigins: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--watch-stdin") {
      watchStdin = true;
      continue;
    }
    if (arg === "--allow-unauthenticated") {
      allowUnauthenticated = true;
      continue;
    }
    if (arg === "--app-root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("APP_ROOT_VALUE_REQUIRED");
      }
      appRoot = value;
      index += 1;
      continue;
    }
    if (arg === "--preset-assets-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("PRESET_ASSETS_DIR_VALUE_REQUIRED");
      }
      presetAssetsDir = value;
      index += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("PORT_VALUE_REQUIRED");
      }
      port = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--host-token") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("HOST_TOKEN_VALUE_REQUIRED");
      }
      hostToken = value;
      index += 1;
      continue;
    }
    if (arg === "--allow-origin") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("ALLOW_ORIGIN_VALUE_REQUIRED");
      }
      const normalized = normalizeOrigin(value);
      if (normalized.length > 0) cliOrigins.push(normalized);
      index += 1;
      continue;
    }
    throw new Error(`UNKNOWN_ARGUMENT:${arg ?? ""}`);
  }

  const resolvedAppRoot = appRoot ?? env.NOWADAYS_APP_ROOT;
  if (!resolvedAppRoot) {
    throw new Error("APP_ROOT_REQUIRED");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`INVALID_PORT:${port}`);
  }

  const envOrigins = (env.NOWADAYS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(normalizeOrigin)
    .filter((value) => value.length > 0);
  const allowedOrigins = [...new Set([...cliOrigins, ...envOrigins])];
  const resolvedHostToken = hostToken ?? env.NOWADAYS_HOST_TOKEN;
  const masterKey = env.NOWADAYS_MASTER_KEY?.trim();

  const absoluteAppRoot = path.resolve(resolvedAppRoot);
  const dataRoot = path.join(absoluteAppRoot, "data");
  const resolvedPresetAssetsDir = path.resolve(
    presetAssetsDir ?? env.NOWADAYS_PRESET_ASSETS_DIR ?? DEFAULT_PRESET_ASSETS_DIR,
  );
  return {
    appRoot: absoluteAppRoot,
    dataRoot,
    appDatabasePath: path.join(dataRoot, "app.sqlite"),
    presetAssetsDir: resolvedPresetAssetsDir,
    port,
    host: LOOPBACK_HOST,
    watchStdin,
    allowUnauthenticated,
    ...(resolvedHostToken !== undefined && resolvedHostToken !== ""
      ? { hostToken: resolvedHostToken }
      : {}),
    ...(masterKey !== undefined && masterKey !== "" ? { masterKey } : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  };
}

/** 统一来源写法：去空白并去掉末尾斜杠，便于与请求头精确比较。 */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function rolePaths(dataRoot: string, roleId: string): RolePaths {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roleId)) {
    throw new Error(`INVALID_ROLE_ID:${roleId}`);
  }
  const roleDir = path.join(dataRoot, "roles", roleId);
  return {
    roleId,
    roleDir,
    businessDatabasePath: path.join(roleDir, "business.sqlite"),
    executionDatabasePath: path.join(roleDir, "execution.sqlite"),
    workspaceDir: path.join(roleDir, "workspace"),
    appearanceDir: path.join(roleDir, "appearance"),
    voiceDir: path.join(roleDir, "voice"),
    sceneImageDir: path.join(roleDir, "scene-images"),
  };
}
