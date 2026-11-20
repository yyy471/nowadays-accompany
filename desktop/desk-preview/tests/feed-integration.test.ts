import assert from "node:assert/strict";
import test from "node:test";
import { listen } from "../../../backend/src/bootstrap/app.js";
import { createFixtureWithModel, ScriptedChatModel } from "../../../backend/tests/p2-05-fixture.js";
import { loadFeed, loadUpcoming, messageKey } from "../renderer/src/feed/data";
import type { RoleListItem } from "../renderer/src/types";

test("动态读取真实自主分享的主对话消息，安排可独立读取", { timeout: 20_000 }, async () => {
  const model = new ScriptedChatModel([
    [
      { type: "tool_call", callId: "share-1", name: "autonomy_share", arguments: { content: "测试分享的真实消息。" } },
      { type: "completed", stopReason: "tool_calls" },
    ],
    [
      { type: "text_delta", text: "整理完成。" },
      { type: "completed", stopReason: "stop" },
    ],
  ]);
  const fixture = createFixtureWithModel(model);
  const originalFetch = globalThis.fetch;
  try {
    fixture.app.services.autonomy.scheduleWake(fixture.roleId, {
      wakeAt: new Date(Date.now() + 400).toISOString(), intent: "整理资料",
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !fixture.app.services.autonomy.listActivities(fixture.roleId).some(item => item.status === "completed")) {
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const activity = fixture.app.services.autonomy.listActivities(fixture.roleId)[0];
    assert.ok(activity?.sharedMessageId);
    assert.notEqual(activity.windowId, fixture.windowId);
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const roles = ((await (await originalFetch(`${base}/v1/roles`)).json()) as { items: RoleListItem[] }).items
      .filter(role => role.roleId === fixture.roleId);
    globalThis.fetch = (input, init) => originalFetch(new URL(String(input), base), init);
    const feed = await loadFeed(roles, new AbortController().signal);
    assert.equal(feed.messages[messageKey(fixture.roleId, activity.sharedMessageId)]?.content, "测试分享的真实消息。");
    assert.equal(feed.messages[messageKey(fixture.roleId, activity.sharedMessageId)]?.windowId, fixture.windowId);
    assert.ok(feed.wakes.some(wake => wake.wakeId === activity.wakeId));

    globalThis.fetch = (input, init) => String(input).includes('/memory/batches')
      ? Promise.resolve(new Response(JSON.stringify({ error: { message: '记忆读取失败' } }), { status: 503 }))
      : originalFetch(new URL(String(input), base), init);
    await assert.rejects(loadFeed(roles, new AbortController().signal), /记忆读取失败/);
    const upcoming = await loadUpcoming(roles, new AbortController().signal);
    assert.ok(upcoming.wakes.some(wake => wake.wakeId === activity.wakeId));
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.close();
  }
});

test("不同角色使用相同消息编号时，分享内容仍按角色隔离", async () => {
  const originalFetch = globalThis.fetch;
  const roles: RoleListItem[] = ["a", "b"].map(roleId => ({
    roleId, displayName: roleId, status: "ready", initError: null, defaultWindowId: `window-${roleId}`,
  }));
  globalThis.fetch = async input => {
    const url = new URL(String(input), "http://test.local");
    const roleId = /^\/v1\/roles\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
    let body: unknown = { items: [] };
    if (url.pathname.endsWith('/state')) body = { state: {}, stateVersion: 1, updatedAt: '' };
    if (url.pathname.endsWith('/autonomy/activities')) body = { items: [{
      activityId: 'same-activity', roleId, wakeId: 'same-wake', taskId: 'same-task', windowId: 'autonomy',
      status: 'completed', summary: null, sharedMessageId: 'same-message', startedAt: '2026-11-01T00:00:00Z', finishedAt: null,
      sharedMessage: { messageId: 'same-message', windowId: `window-${roleId}`, content: `角色 ${roleId} 的分享`, createdAt: '2026-11-01T00:00:00Z' },
    }] };
    if (url.pathname.endsWith('/messages/same-message')) body = { message: {
      messageId: 'same-message', windowId: `window-${roleId}`, content: `角色 ${roleId} 的分享`, createdAt: '2026-11-01T00:00:00Z',
    }, segments: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const feed = await loadFeed(roles, new AbortController().signal);
    assert.equal(feed.messages[messageKey('a', 'same-message')]?.content, '角色 a 的分享');
    assert.equal(feed.messages[messageKey('b', 'same-message')]?.content, '角色 b 的分享');
  } finally { globalThis.fetch = originalFetch; }
});

test("分享随活动分页更新，缺失不阻断其他动态且轮询无需逐条请求", async () => {
  const originalFetch = globalThis.fetch;
  const roles = ["a", "b"].map(roleId => ({
    roleId, displayName: roleId, status: "ready", initError: null, defaultWindowId: `window-${roleId}`,
  })) as RoleListItem[];
  let revision = 0;
  let fail = false;
  let messageRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const url = new URL(String(input), "http://test.local");
    const roleId = /^\/v1\/roles\/([^/]+)/.exec(url.pathname)?.[1] ?? "";
    if (url.pathname.includes('/messages/')) messageRequests++;
    if (fail && url.pathname.endsWith('/memory/batches')) return new Response('{}', { status: 503 });
    let body: unknown = { items: [] };
    if (url.pathname.endsWith('/state')) body = { state: {} };
    if (url.pathname.endsWith('/autonomy/wakes')) body = { items: [{ wakeId: `wake-${roleId}`, roleId }] };
    if (url.pathname.endsWith('/autonomy/activities')) {
      assert.equal(url.searchParams.get('includeSharedMessage'), '1');
      const all = Array.from({ length: roleId === 'a' ? 250 : 1 }, (_, index) => {
        const id = `message-${index}`;
        return { activityId: `activity-${index}`, roleId, sharedMessageId: id,
          sharedMessage: index === 0 && roleId === 'a' && revision === 0 ? null : {
            messageId: id, windowId: `window-${roleId}`, content: `${roleId}-${index}-${revision}`, createdAt: '2026-11-01T00:00:00Z',
          } };
      });
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      body = { items: all.slice(offset, offset + limit) };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const first = await loadFeed(roles, new AbortController().signal);
    assert.equal(first.messages[messageKey('a', 'message-0')], undefined);
    assert.equal(first.messages[messageKey('b', 'message-0')]?.content, 'b-0-0');
    assert.equal(first.activities.length, 251);
    assert.equal(first.wakes.length, 2);
    revision = 1;
    const updated = await loadFeed(roles, new AbortController().signal);
    assert.equal(updated.messages[messageKey('a', 'message-0')]?.content, 'a-0-1');
    assert.equal(updated.messages[messageKey('a', 'message-249')]?.content, 'a-249-1');
    assert.equal(messageRequests, 0);
    fail = true;
    await assert.rejects(loadFeed(roles, new AbortController().signal));
    fail = false;
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(loadFeed(roles, aborted.signal), { name: 'AbortError' });
    revision = 2;
    const recovered = await loadFeed(roles, new AbortController().signal);
    assert.equal(recovered.messages[messageKey('a', 'message-0')]?.content, 'a-0-2');
    assert.equal(messageRequests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
