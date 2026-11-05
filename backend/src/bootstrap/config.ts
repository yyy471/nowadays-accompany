import path from "node:path";

export const DEFAULT_PORT = 3210;
export const LOOPBACK_HOST = "127.0.0.1";

export interface BackendConfig {
  appRoot: string;
  dataRoot: string;
  appDatabasePath: string;
  port: number;
  host: typeof LOOPBACK_HOST;
}

export interface RolePaths {
  roleId: string;
  roleDir: string;
  businessDatabasePath: string;
  executionDatabasePath: string;
  workspaceDir: string;
}

export function parseBackendConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  let appRoot: string | undefined;
  let port = DEFAULT_PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app-root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("APP_ROOT_VALUE_REQUIRED");
      }
      appRoot = value;
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
    throw new Error(`UNKNOWN_ARGUMENT:${arg ?? ""}`);
  }

  const resolvedAppRoot = appRoot ?? env.NOWADAYS_APP_ROOT;
  if (!resolvedAppRoot) {
    throw new Error("APP_ROOT_REQUIRED");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`INVALID_PORT:${port}`);
  }

  const absoluteAppRoot = path.resolve(resolvedAppRoot);
  const dataRoot = path.join(absoluteAppRoot, "data");
  return {
    appRoot: absoluteAppRoot,
    dataRoot,
    appDatabasePath: path.join(dataRoot, "app.sqlite"),
    port,
    host: LOOPBACK_HOST,
  };
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
  };
}
