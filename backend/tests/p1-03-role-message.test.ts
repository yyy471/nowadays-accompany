import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackendApp, listen } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { RoleService } from "../src/application/role-service.js";
import { RoleInitializationError } from "../src/domain/errors.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p1-03-"));
}

async function start(root: string) {
  const config = parseBackendConfig(["--app-root", root, "--port", "0"]);
  const app = createBackendApp(config);
  const port = await listen(app.server, 0, config.host);
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

async function request(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  contentType = "application/json",
) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers:
      body === undefined
        ? {}
        : {
            "content-type": contentType,
          },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

test("role, state, windows and message dedup persist across reopen", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    let started = await start(root);
    app = started.app;
    const { baseUrl } = started;

    const created = await request(baseUrl, "POST", "/v1/roles", {
      displayName: "测试角色",
      definition: { text: "初始设定", payload: { tone: "calm" } },
    });
    assert.equal(created.status, 201);
    const roleId = created.body.roleId as string;
    const mainWindowId = created.body.defaultWindowId as string;
    assert.ok(roleId);
    assert.ok(mainWindowId);
    assert.equal(created.body.status, "ready");
    assert.equal(created.body.definitionRevision, 1);
    assert.equal(created.body.stateVersion, 1);

    const role = await request(baseUrl, "GET", `/v1/roles/${roleId}`);
    assert.equal(role.status, 200);
    assert.equal(role.body.displayName, "测试角色");
    assert.deepEqual(role.body.definition, {
      text: "初始设定",
      payload: { tone: "calm" },
    });

    const updated = await request(
      baseUrl,
      "PATCH",
      `/v1/roles/${roleId}/definition`,
      {
        definition: { text: "修订设定", payload: { tone: "warm" } },
        expectedRevision: 1,
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.definitionRevision, 2);

    const revisionConflict = await request(
      baseUrl,
      "PATCH",
      `/v1/roles/${roleId}/definition`,
      { displayName: "不应写入", expectedRevision: 1 },
    );
    assert.equal(revisionConflict.status, 409);
    assert.equal(
      (revisionConflict.body.error as { code: string }).code,
      "REVISION_CONFLICT",
    );

    const state = await request(baseUrl, "GET", `/v1/roles/${roleId}/state`);
    assert.equal(state.status, 200);
    assert.equal(state.body.stateVersion, 1);
    const stateUpdated = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/state`,
      { state: { mood: "calm" }, expectedVersion: 1 },
    );
    assert.equal(stateUpdated.status, 200);
    assert.equal(stateUpdated.body.stateVersion, 2);
    const stateConflict = await request(
      baseUrl,
      "PUT",
      `/v1/roles/${roleId}/state`,
      { state: { mood: "other" }, expectedVersion: 1 },
    );
    assert.equal(stateConflict.status, 409);
    assert.equal(
      (stateConflict.body.error as { code: string }).code,
      "STATE_VERSION_CONFLICT",
    );

    const customWindow = await request(
      baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows`,
      { kind: "custom" },
    );
    assert.equal(customWindow.status, 201);
    const customWindowId = customWindow.body.windowId as string;
    const windows = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows`,
    );
    assert.equal((windows.body.items as unknown[]).length, 2);

    const first = await request(
      baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages`,
      { content: "第一条", submissionId: "sub-1" },
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.duplicate, false);
    const firstMessage = first.body.message as {
      messageId: string;
      sequence: number;
    };
    assert.equal(firstMessage.sequence, 1);

    const duplicate = await request(
      baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages`,
      { content: "第一条", submissionId: "sub-1" },
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(
      (duplicate.body.message as { messageId: string }).messageId,
      firstMessage.messageId,
    );

    const conflict = await request(
      baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages`,
      { content: "不同内容", submissionId: "sub-1" },
    );
    assert.equal(conflict.status, 409);
    assert.equal(
      (conflict.body.error as { code: string }).code,
      "SUBMISSION_CONFLICT",
    );

    const second = await request(
      baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages`,
      { content: "第一条", submissionId: "sub-2" },
    );
    assert.equal(second.status, 201);
    assert.equal((second.body.message as { sequence: number }).sequence, 2);

    const customMessage = await request(
      baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${customWindowId}/messages`,
      { content: "另一个窗口", submissionId: "sub-3" },
    );
    assert.equal(customMessage.status, 201);

    const page = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages?limit=1`,
    );
    assert.equal(page.status, 200);
    assert.equal((page.body.items as unknown[]).length, 1);
    assert.equal(
      (page.body.items as Array<{ sequence: number }>)[0]?.sequence,
      2,
    );
    assert.equal(page.body.nextBefore, 2);
    assert.equal(page.body.nextAfter, null);
    const olderPage = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages?before=2&limit=1`,
    );
    assert.equal(olderPage.status, 200);
    assert.equal(
      (olderPage.body.items as Array<{ sequence: number }>)[0]?.sequence,
      1,
    );
    assert.equal(olderPage.body.nextBefore, null);
    const nextPage = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages?after=0&limit=1`,
    );
    assert.equal(nextPage.status, 200);
    assert.equal((nextPage.body.items as unknown[]).length, 1);
    assert.equal(nextPage.body.nextAfter, 1);
    assert.equal(nextPage.body.nextBefore, null);
    const conflicting = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages?after=0&before=2`,
    );
    assert.equal(conflicting.status, 400);
    assert.equal(
      (conflicting.body.error as { code: string }).code,
      "INVALID_QUERY",
    );

    const isolated = await request(
      baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows/${customWindowId}/messages`,
    );
    assert.equal((isolated.body.items as unknown[]).length, 1);

    await app.close();
    app = undefined;
    started = await start(root);
    app = started.app;

    const reopenedRole = await request(
      started.baseUrl,
      "GET",
      `/v1/roles/${roleId}`,
    );
    assert.equal(reopenedRole.status, 200);
    assert.equal(reopenedRole.body.displayName, "测试角色");
    const reopenedState = await request(
      started.baseUrl,
      "GET",
      `/v1/roles/${roleId}/state`,
    );
    assert.equal(reopenedState.body.stateVersion, 2);
    const reopenedMessages = await request(
      started.baseUrl,
      "GET",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages`,
    );
    assert.equal((reopenedMessages.body.items as unknown[]).length, 2);

    const missing = await request(
      started.baseUrl,
      "GET",
      `/v1/roles/${randomUUID()}`,
    );
    assert.equal(missing.status, 404);
    assert.equal(
      (missing.body.error as { code: string }).code,
      "ROLE_NOT_FOUND",
    );

    const invalidMessage = await request(
      started.baseUrl,
      "POST",
      `/v1/roles/${roleId}/windows/${mainWindowId}/messages`,
      { submissionId: "no-content" },
    );
    assert.equal(invalidMessage.status, 400);
    assert.equal(
      (invalidMessage.body.error as { code: string }).code,
      "INVALID_REQUEST",
    );
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed initialization can be retried with the same roleId", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const config = parseBackendConfig(["--app-root", root]);
    app = createBackendApp(config);
    const blockedRoot = path.join(root, "blocked-root");
    fs.writeFileSync(blockedRoot, "not a directory", "utf8");
    const service = new RoleService(app.appStore, blockedRoot);

    let failed: unknown;
    try {
      service.createRole({
        displayName: "失败角色",
        definition: { text: "初始设定" },
      });
    } catch (error) {
      failed = error;
    }
    assert.ok(failed instanceof RoleInitializationError);
    const roleId = (failed.details as { roleId: string }).roleId;
    const failedIndex = app.appStore.getRoleIndex(roleId);
    assert.equal(failedIndex?.initStatus, "failed");
    assert.ok(failedIndex?.initPayload);

    fs.rmSync(blockedRoot, { force: true });
    fs.mkdirSync(blockedRoot, { recursive: true });
    const recovered = service.initializeRole(roleId);
    assert.equal(recovered.roleId, roleId);
    assert.equal(app.appStore.getRoleIndex(roleId)?.initStatus, "ready");
    assert.equal(app.appStore.getRoleIndex(roleId)?.initPayload, null);

    const index = app.appStore.getRoleIndex(roleId);
    assert.ok(index);
    const businessPath = path.join(
      blockedRoot,
      "roles",
      roleId,
      "business.sqlite",
    );
    assert.ok(fs.existsSync(businessPath));
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET /v1/roles lists empty, ready and failed roles (UI-PREP-01)", async () => {
  const root = tempRoot();
  let app: ReturnType<typeof createBackendApp> | undefined;
  try {
    const started = await start(root);
    app = started.app;
    const { baseUrl } = started;

    const emptyList = await request(baseUrl, "GET", "/v1/roles");
    assert.equal(emptyList.status, 200);
    assert.deepEqual(emptyList.body.items, []);

    const created = await request(baseUrl, "POST", "/v1/roles", {
      displayName: "樱",
      definition: { text: "温柔安静的伴读女孩" },
    });
    assert.equal(created.status, 201);

    const readyList = await request(baseUrl, "GET", "/v1/roles");
    assert.equal(readyList.status, 200);
    const items = readyList.body.items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.roleId, created.body.roleId);
    assert.equal(items[0]?.displayName, "樱");
    assert.equal(items[0]?.status, "ready");
    assert.equal(items[0]?.defaultWindowId, created.body.defaultWindowId);
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
