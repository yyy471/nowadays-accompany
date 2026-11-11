import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const backendRoot = path.resolve(import.meta.dirname, "..");
const mainEntry = path.join(backendRoot, "src", "main.ts");
const cliEntry = path.join(backendRoot, "src", "cli.ts");

interface BackendProcess {
  child: ChildProcess;
  port: number;
  stderr(): string;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p1-05-"));
}

function startBackend(root: string): Promise<BackendProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        mainEntry,
        "--app-root",
        root,
        "--port",
        "0",
      ],
      { cwd: backendRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`后端启动超时：${stderr}`));
    }, 15_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      let lineEnd = stdout.indexOf("\n");
      while (lineEnd >= 0) {
        const line = stdout.slice(0, lineEnd).trim();
        stdout = stdout.slice(lineEnd + 1);
        if (line.length > 0) {
          let event: { event?: string; port?: number };
          try {
            event = JSON.parse(line) as { event?: string; port?: number };
          } catch {
            continue;
          }
          if (event.event === "listening" && typeof event.port === "number") {
            if (settled) {
              continue;
            }
            settled = true;
            clearTimeout(timer);
            resolve({
              child,
              port: event.port,
              stderr: () => stderr,
            });
          }
        }
        lineEnd = stdout.indexOf("\n");
      }
    });
    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`后端提前退出（code=${String(code)}）：${stderr}`),
      );
    });
  });
}

function stopBackend(backend: BackendProcess): Promise<void> {
  if (
    backend.child.exitCode !== null ||
    backend.child.signalCode !== null
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      backend.child.kill("SIGKILL");
    }, 5_000);
    backend.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    backend.child.kill("SIGTERM");
  });
}

function runCli(baseUrl: string, args: readonly string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, "--base-url", baseUrl, ...args],
      { cwd: backendRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`CLI 执行超时：${args.join(" ")}`));
    }, 15_000);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      let json: unknown;
      if (stdout.trim().length > 0) {
        try {
          json = JSON.parse(stdout) as unknown;
        } catch {
          json = undefined;
        }
      }
      resolve({ status: code, stdout, stderr, json });
    });
  });
}

function ok(result: CliResult): Record<string, unknown> {
  assert.equal(result.status, 0, `CLI 失败：${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.equal(typeof result.json, "object");
  return result.json as Record<string, unknown>;
}

/**
 * 配置写入的 CLI 作用域：后端统一要求先由活动接口确认停止，写完再恢复。
 * 用 CLI 自身的 activity 命令完成，既覆盖新命令，也不绕过路由守卫。
 */
async function runConfigCli(
  baseUrl: string,
  roleId: string,
  args: readonly string[],
): Promise<CliResult> {
  const stopped = ok(
    await runCli(baseUrl, ["activity", "stop", "--role", roleId]),
  );
  assert.equal((stopped.activity as { state: string }).state, "stopped");
  try {
    return await runCli(baseUrl, args);
  } finally {
    const resumed = ok(
      await runCli(baseUrl, ["activity", "resume", "--role", roleId]),
    );
    assert.equal((resumed.activity as { state: string }).state, "active");
  }
}

function cliError(result: CliResult): string {
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  const body = JSON.parse(result.stderr.trim()) as {
    error?: { code?: string };
  };
  return body.error?.code ?? "";
}

function countRoleDirs(root: string): number {
  const rolesDir = path.join(root, "data", "roles");
  return fs.existsSync(rolesDir)
    ? fs.readdirSync(rolesDir, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      ).length
    : 0;
}

test("independent CLI completes the P1 flow through the backend process", async () => {
  const root = tempRoot();
  let backend: BackendProcess | undefined;
  try {
    backend = await startBackend(root);
    let baseUrl = `http://127.0.0.1:${backend.port}`;

    const health = ok(await runCli(baseUrl, ["health"]));
    assert.equal(health.status, "ok");

    const created = ok(
      await runCli(baseUrl, [
        "role",
        "create",
        "--name",
        "CLI 角色",
        "--definition",
        "初始设定",
        "--payload",
        '{"tone":"calm"}',
        "--state",
        '{"mood":"ok"}',
      ]),
    );
    const roleId = created.roleId as string;
    const mainWindowId = created.defaultWindowId as string;
    assert.ok(roleId);
    assert.ok(mainWindowId);

    const activity = ok(
      await runCli(baseUrl, ["activity", "get", "--role", roleId]),
    );
    assert.equal((activity.activity as { state: string }).state, "active");
    const activities = ok(await runCli(baseUrl, ["activity", "list"]));
    assert.equal((activities.items as unknown[]).length, 1);

    const fetched = ok(
      await runCli(baseUrl, ["role", "get", "--role", roleId]),
    );
    assert.equal(fetched.displayName, "CLI 角色");
    assert.deepEqual(fetched.definition, {
      text: "初始设定",
      payload: { tone: "calm" },
    });

    const state = ok(
      await runCli(baseUrl, ["state", "get", "--role", roleId]),
    );
    assert.equal(state.stateVersion, 1);
    const stateUpdated = ok(
      await runCli(baseUrl, [
        "state",
        "put",
        "--role",
        roleId,
        "--state",
        '{"mood":"calm"}',
        "--expected-version",
        "1",
      ]),
    );
    assert.equal(stateUpdated.stateVersion, 2);

    const updated = ok(
      await runConfigCli(baseUrl, roleId, [
        "role",
        "update",
        "--role",
        roleId,
        "--definition",
        "修订设定",
        "--payload",
        '{"tone":"warm"}',
        "--expected-revision",
        "1",
      ]),
    );
    assert.equal(updated.definitionRevision, 2);

    const customWindow = ok(
      await runCli(baseUrl, [
        "window",
        "create",
        "--role",
        roleId,
        "--kind",
        "custom",
      ]),
    );
    assert.equal(customWindow.kind, "custom");
    const windows = ok(
      await runCli(baseUrl, ["window", "list", "--role", roleId]),
    );
    assert.equal((windows.items as unknown[]).length, 2);

    const sent = ok(
      await runCli(baseUrl, [
        "message",
        "send",
        "--role",
        roleId,
        "--window",
        mainWindowId,
        "--content",
        "你好",
        "--submission-id",
        "sub-1",
      ]),
    );
    assert.equal(sent.duplicate, false);
    const resent = ok(
      await runCli(baseUrl, [
        "message",
        "send",
        "--role",
        roleId,
        "--window",
        mainWindowId,
        "--content",
        "你好",
        "--submission-id",
        "sub-1",
      ]),
    );
    assert.equal(resent.duplicate, true);
    const messages = ok(
      await runCli(baseUrl, [
        "message",
        "list",
        "--role",
        roleId,
        "--window",
        mainWindowId,
      ]),
    );
    assert.equal((messages.items as unknown[]).length, 1);

    const resourceFile = path.join(root, "model-resource.json");
    fs.writeFileSync(
      resourceFile,
      JSON.stringify({
        name: "CLI 模型",
        config: {
          protocol: "openai-chat",
          baseUrl: "http://127.0.0.1:9999/v1",
          credentialRef: "env:NOWADAYS_TEST_KEY",
        },
      }),
      "utf8",
    );
    const resource = ok(
      await runCli(baseUrl, [
        "resource",
        "create",
        "--kind",
        "model",
        "--json",
        `@${resourceFile}`,
      ]),
    );
    const resourceId = resource.resourceId as string;
    const resources = ok(
      await runCli(baseUrl, ["resource", "list", "--kind", "model"]),
    );
    assert.equal((resources.items as unknown[]).length, 1);
    const resourceFetched = ok(
      await runCli(baseUrl, ["resource", "get", "--id", resourceId]),
    );
    assert.equal(resourceFetched.name, "CLI 模型");
    const resourceUpdated = ok(
      await runConfigCli(baseUrl, roleId, [
        "resource",
        "update",
        "--id",
        resourceId,
        "--json",
        '{"enabled":false}',
      ]),
    );
    assert.equal(resourceUpdated.enabled, false);

    const bindings = ok(
      await runConfigCli(baseUrl, roleId, [
        "binding",
        "put",
        "--role",
        roleId,
        "--json",
        JSON.stringify({
          bindings: [
            {
              capability: "chat_model",
              resourceId,
              modelName: "model-a",
            },
          ],
        }),
      ]),
    );
    assert.equal((bindings.items as unknown[]).length, 1);
    const bindingsRead = ok(
      await runCli(baseUrl, ["binding", "get", "--role", roleId]),
    );
    assert.equal((bindingsRead.items as unknown[]).length, 1);

    const initialized = ok(
      await runCli(baseUrl, ["role", "initialize", "--role", roleId]),
    );
    assert.equal(initialized.status, "ready");

    await stopBackend(backend);
    backend = undefined;

    backend = await startBackend(root);
    baseUrl = `http://127.0.0.1:${backend.port}`;

    const reopenedRole = ok(
      await runCli(baseUrl, ["role", "get", "--role", roleId]),
    );
    assert.equal(reopenedRole.definitionRevision, 2);
    assert.deepEqual(reopenedRole.definition, {
      text: "修订设定",
      payload: { tone: "warm" },
    });
    const reopenedState = ok(
      await runCli(baseUrl, ["state", "get", "--role", roleId]),
    );
    assert.equal(reopenedState.stateVersion, 2);
    const reopenedBindings = ok(
      await runCli(baseUrl, ["binding", "get", "--role", roleId]),
    );
    assert.equal((reopenedBindings.items as unknown[]).length, 1);
    const reopenedMessages = ok(
      await runCli(baseUrl, [
        "message",
        "list",
        "--role",
        roleId,
        "--window",
        mainWindowId,
      ]),
    );
    assert.equal((reopenedMessages.items as unknown[]).length, 1);
    const reopenedResource = ok(
      await runCli(baseUrl, ["resource", "get", "--id", resourceId]),
    );
    assert.equal(reopenedResource.enabled, false);

    const missing = await runCli(baseUrl, [
      "role",
      "get",
      "--role",
      randomUUID(),
    ]);
    assert.equal(cliError(missing), "ROLE_NOT_FOUND");

    await stopBackend(backend);
    backend = undefined;

    const rolesBefore = countRoleDirs(root);
    const offline = await runCli(baseUrl, [
      "role",
      "create",
      "--name",
      "离线角色",
      "--definition",
      "不应写入",
    ]);
    assert.equal(cliError(offline), "BACKEND_UNREACHABLE");
    assert.equal(countRoleDirs(root), rolesBefore);
  } finally {
    if (backend) {
      await stopBackend(backend);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
