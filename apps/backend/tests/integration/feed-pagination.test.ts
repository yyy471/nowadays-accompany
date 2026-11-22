import assert from "node:assert/strict";
import test from "node:test";
import { listen } from "../../src/bootstrap/app.js";
import { rolePaths } from "../../src/bootstrap/config.js";
import { RoleStorage } from "../../src/storage/core/role-storage.js";
import { createFixtureWithModel, ScriptedChatModel } from "../fixtures/conversation-fixture.js";

test("动态所需的安排、活动与记忆批次可逐页读取，默认顺序保持一致", async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  try {
    const storage = RoleStorage.openExisting(rolePaths(fixture.app.config.dataRoot, fixture.roleId));
    try {
      const db = storage.business.db;
      // 只测试列表读取，活动的关联记录在此隔离夹具中无需调度执行。
      db.pragma("foreign_keys = OFF");
      for (let index = 0; index < 3; index += 1) {
        const time = `2026-11-0${index + 1}T00:00:00.000Z`;
        db.prepare(`INSERT INTO autonomy_wakes
          (wake_id,role_id,kind,scheduled_at,intent,status,created_at,updated_at)
          VALUES (?,?, 'scheduled',?,?,'completed',?,?)`)
          .run(`wake-${index}`, fixture.roleId, time, `安排 ${index}`, time, time);
        db.prepare(`INSERT INTO autonomy_activities
          (activity_id,role_id,wake_id,task_id,execution_id,window_id,status,started_at,finished_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'completed',?,?,?,?)`)
          .run(`activity-${index}`, fixture.roleId, `wake-${index}`, `task-${index}`, `execution-${index}`, fixture.windowId, time, time, time, time);
        db.prepare(`INSERT INTO memory_batches
          (batch_id,role_id,status,input_from_sequence,input_to_sequence,context_budget_chars,output_reserve_chars,attempt_count,started_at,finished_at,created_at)
          VALUES (?,?,'completed',1,2,1000,100,1,?,?,?)`)
          .run(`batch-${index}`, fixture.roleId, time, time, time);
      }
    } finally { storage.close(); }
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}`;
    for (const endpoint of ["autonomy/wakes", "autonomy/activities", "memory/batches"]) {
      const read = async (query = "") => {
        const response = await fetch(`${base}/${endpoint}${query}`);
        assert.equal(response.status, 200);
        return (await response.json() as { items: unknown[] }).items;
      };
      const all = await read();
      assert.ok(all.length >= 3);
      const first = await read("?limit=1&offset=0");
      const second = await read("?limit=1&offset=1");
      assert.deepEqual([...first, ...second], all.slice(0, 2));
      assert.notDeepEqual(first, second);
      assert.equal((await fetch(`${base}/${endpoint}?offset=-1`)).status, 400);
    }
  } finally { await fixture.close(); }
});

test("分享投影只关联默认窗口，分页读取及时反映原文更新、缺失与恢复", async () => {
  const fixture = createFixtureWithModel(new ScriptedChatModel([]));
  const storage = RoleStorage.openExisting(rolePaths(fixture.app.config.dataRoot, fixture.roleId));
  try {
    const db = storage.business.db;
    db.pragma("foreign_keys = OFF");
    const time = "2026-11-01T00:00:00.000Z";
    db.prepare("INSERT INTO windows (window_id,role_id,kind,source,created_at,updated_at) VALUES (?,?,'custom','test',?,?)")
      .run("other-window", fixture.roleId, time, time);
    const insertMessage = db.prepare(`INSERT INTO messages
      (message_id,window_id,sender,content,source_platform,status,sequence,created_at,updated_at)
      VALUES (?,?,'assistant',?,'nowadays','completed',?,?,?)`);
    insertMessage.run("share-main", fixture.windowId, "原文", 101, time, time);
    insertMessage.run("share-other", "other-window", "不能展示", 1, time, time);
    const insertActivity = db.prepare(`INSERT INTO autonomy_activities
      (activity_id,role_id,wake_id,task_id,execution_id,window_id,status,shared_message_id,started_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'completed',?,?,?,?)`);
    ["share-main", "share-other", "missing"].forEach((id, index) => insertActivity.run(
      `projection-${index}`, fixture.roleId, `wake-${index}`, `task-${index}`, `exec-${index}`, fixture.windowId, id, time, time, time,
    ));
    const port = await listen(fixture.app.server, 0, "127.0.0.1");
    const url = `http://127.0.0.1:${port}/v1/roles/${fixture.roleId}/autonomy/activities`;
    const read = async (query: string) => {
      const response = await fetch(`${url}${query}`);
      assert.equal(response.status, 200);
      return (await response.json() as { items: Array<{ sharedMessageId: string; sharedMessage?: { content: string; windowId: string } | null }> }).items;
    };
    assert.ok((await read("" )).every(item => !("sharedMessage" in item)));
    const projected = [...await read("?includeSharedMessage=1&limit=2&offset=0"), ...await read("?includeSharedMessage=1&limit=2&offset=2")];
    const byId = (items: typeof projected, id: string) => items.find(item => item.sharedMessageId === id)?.sharedMessage;
    assert.equal(byId(projected, "share-main")?.content, "原文");
    assert.equal(byId(projected, "share-main")?.windowId, fixture.windowId);
    assert.equal(byId(projected, "share-other"), null);
    assert.equal(byId(projected, "missing"), null);
    db.prepare("UPDATE messages SET content = ? WHERE message_id = ?").run("更新后", "share-main");
    assert.equal(byId(await read("?includeSharedMessage=1"), "share-main")?.content, "更新后");
    db.prepare("DELETE FROM messages WHERE message_id = ?").run("share-main");
    assert.equal(byId(await read("?includeSharedMessage=1"), "share-main"), null);
    insertMessage.run("share-main", fixture.windowId, "已恢复", 101, time, time);
    assert.equal(byId(await read("?includeSharedMessage=1"), "share-main")?.content, "已恢复");
  } finally { storage.close(); await fixture.close(); }
});
