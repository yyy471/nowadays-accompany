import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBackendApp } from "../../src/bootstrap/app.js";
import { parseBackendConfig } from "../../src/bootstrap/config.js";
import type { ModelEvent, ModelPort, ModelRequest } from "../../src/domain/model.js";
import { sceneImageSettingsSchema } from "../../src/domain/scene-image-settings.js";
import { FakeSceneImageGenerator } from "../../src/scene/fake-generator.js";
import { SceneImageStore } from "../../src/storage/media/scene-image-store.js";
import { createFixtureWithModel, withStorage, type Fixture } from "../fixtures/conversation-fixture.js";

class SceneDecisionModel implements ModelPort {
  decisions = 0;
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    let answer = "车门开了，海上的第一道光照在站台上。";
    if (request.system.includes("这是自动判图")) {
      this.decisions++;
      const { segments } = JSON.parse(request.messages[0]!.content);
      answer = JSON.stringify(this.decisions === 1
        ? { draw: false, reason: "这轮只重复同一个站台的描述。" }
        : { draw: true, description: "晨光照亮站台", layerMode: "background",
          startSegmentId: segments[0].segmentId, endSegmentId: segments.at(-1).segmentId });
    }
    yield {type: "text_delta", text: answer};
    yield {type: "completed", stopReason: "stop"};
  }
}

function configure(f: Fixture) {
  const service = f.app.services.imageServices.create({name:"离线替身", config:{protocol:"comfyui",baseUrl:"http://127.0.0.1:1"}});
  f.app.services.sceneImageSettings.save(f.roleId, sceneImageSettingsSchema.parse({
    serviceId: service.serviceId, modelType:"text2img", modelPath:"offline.safetensors", autoGenerateEnabled:true,
  }));
  return service;
}

async function reply(f: Fixture, windowId = f.windowId) {
  f.app.conversation.submitMessage(f.roleId,windowId,{content:"到站了吗？",submissionId:randomUUID(),sourcePlatform:"nowadays"});
  await f.app.conversation.waitForIdle(f.roleId);
  await f.app.services.sceneImages.waitForIdle(f.roleId);
  const page = f.app.services.messages.list(f.roleId,windowId,null,100);
  const last = page.items.filter(x => x.sender === "assistant").at(-1)!;
  return withStorage(f, s => new SceneImageStore(s.business.db,f.roleId).listForMessages(windowId,[last.messageId]));
}

test("正式回复才判图，模型跳过、按窗口冷却和无服务都有记录且不产生图片", async t => {
  const model = new SceneDecisionModel();
  const generator = new FakeSceneImageGenerator({background:{width:32,height:32}});
  let generations = 0;
  const f = createFixtureWithModel(model,{sceneImageGenerator:{generate(input) { generations++; return generator.generate(input); }}});
  t.after(() => f.close());
  assert.deepEqual(await reply(f), []);
  const service = configure(f);
  const [skip] = await reply(f);
  assert.equal(skip!.errorCode,"SCENE_IMAGE_AUTO_NOT_SELECTED");
  assert.match(skip!.errorSummary!,/站台/);
  const [drawn] = await reply(f);
  assert.equal(drawn!.status,"succeeded");
  assert.equal(drawn!.layerMode,"background");
  assert.ok(drawn!.result?.assetId);
  const [cool] = await reply(f);
  assert.equal(cool!.errorCode,"SCENE_IMAGE_AUTO_COOLDOWN");
  assert.equal(model.decisions,2);
  const other = f.app.services.roles.createWindow(f.roleId,{kind:"custom",source:"nowadays"});
  const [second] = await reply(f,other.windowId);
  assert.equal(second!.status,"succeeded");
  f.app.services.imageServices.update(service.serviceId,{enabled:false});
  const [unavailable] = await reply(f);
  assert.equal(unavailable!.errorCode,"SCENE_IMAGE_AUTO_NO_SERVICE");
  assert.equal(unavailable!.result,null);
  assert.equal(model.decisions,3);
  assert.equal(generations,2);
});

test("重启恢复安全队列，生成阶段的未知结果不重复出图", async t => {
  const model = new SceneDecisionModel();
  const f = createFixtureWithModel(model,{sceneImageGenerator:new FakeSceneImageGenerator({background:{width:32,height:32}})});
  t.after(() => f.close());
  configure(f);
  const [first] = await reply(f);
  const other = f.app.services.roles.createWindow(f.roleId,{kind:"custom",source:"nowadays"});
  await reply(f,other.windowId);
  await f.app.close();
  withStorage(f, s => {
    s.business.db.prepare("UPDATE scene_image_tasks SET status='queued',error_code=NULL,error_summary=NULL WHERE task_id=?").run(first!.taskId);
    s.business.db.prepare("UPDATE scene_image_tasks SET status='generating' WHERE window_id=?").run(other.windowId);
  });
  let generated = 0;
  const fake = new FakeSceneImageGenerator({background:{width:32,height:32}});
  const reopened = createBackendApp(parseBackendConfig(["--app-root",f.root,"--port","0"]),{
    modelPortFactory:()=>model, disableMemoryRuntime:true,
    sceneImageGenerator:{generate(input) { generated++; return fake.generate(input); }},
  });
  try {
    await reopened.services.sceneImages.waitForIdle(f.roleId);
    assert.equal(reopened.services.sceneImages.getTask(f.roleId,f.windowId,first!.taskId).status,"succeeded");
    const unknown = withStorage(f,s=>s.business.db.prepare(
      "SELECT error_code FROM scene_image_tasks WHERE window_id=?").pluck().get(other.windowId));
    assert.equal(unknown,"SCENE_IMAGE_GENERATION_OUTCOME_UNKNOWN");
    reopened.services.sceneImages.dispatchAutomatic(f.roleId,f.windowId);
    assert.equal(generated,1);
  } finally { await reopened.close(); }
});

test("停用服务在维护窗口期间仍按无服务跳过，启用服务遇维护失败不卡死后续自动调度", { timeout: 20_000 }, async () => {
  const model = new SceneDecisionModel();
  let generations = 0;
  const fake = new FakeSceneImageGenerator({ background: { width: 32, height: 32 } });
  const f = createFixtureWithModel(model, {
    sceneImageGenerator: {
      generate(input) {
        generations++;
        return fake.generate(input);
      },
    },
  });
  let releaseHold: (() => void) | undefined;
  let pendingMaint: Promise<unknown> | undefined;
  try {
    const service = f.app.services.imageServices.create({
      name: "维护测试生图",
      config: { protocol: "comfyui", baseUrl: "http://127.0.0.1:1" },
    });
    f.app.services.sceneImageSettings.save(f.roleId, sceneImageSettingsSchema.parse({
      serviceId: service.serviceId,
      modelType: "text2img",
      modelPath: "offline.safetensors",
      autoGenerateEnabled: true,
      autoCooldownMinutes: 0,
    }));

    // 先停用服务落库一条快照无服务的自动任务，再在维护窗口内重新派发，应按无服务跳过而不抢占维护锁。
    f.app.services.imageServices.update(service.serviceId, { enabled: false });
    const [disabledTask] = await reply(f);
    assert.equal(disabledTask!.errorCode, "SCENE_IMAGE_AUTO_NO_SERVICE");
    withStorage(f, s => {
      s.business.db.prepare(
        "UPDATE scene_image_tasks SET status='queued', error_code=NULL, error_summary=NULL WHERE task_id=?",
      ).run(disabledTask!.taskId);
    });
    releaseHold = f.app.services.mediaMaintenance.claim("image", service.serviceId, randomUUID());
    pendingMaint = f.app.services.mediaMaintenance.update("image", service.serviceId, true, () => true);
    await new Promise(resolve => setTimeout(resolve, 50));
    f.app.services.sceneImages.dispatchAutomatic(f.roleId, f.windowId);
    await f.app.services.sceneImages.waitForIdle(f.roleId);
    const afterDisabledMaint = f.app.services.sceneImages.getTask(f.roleId, f.windowId, disabledTask!.taskId);
    assert.equal(afterDisabledMaint.status, "skipped");
    assert.equal(afterDisabledMaint.errorCode, "SCENE_IMAGE_AUTO_NO_SERVICE");
    releaseHold();
    releaseHold = undefined;
    await pendingMaint;
    pendingMaint = undefined;

    // 启用服务后在维护期间重派快照带服务的自动任务：按 MEDIA_SERVICE_MAINTENANCE 结算且不卡死窗口，维护结束后恢复正常出图。
    f.app.services.imageServices.update(service.serviceId, { enabled: true });
    f.app.services.activity.resume(f.roleId);
    model.decisions = 1;
    const [enabledTask] = await reply(f);
    assert.equal(enabledTask!.status, "succeeded");
    withStorage(f, s => {
      s.business.db.prepare(
        "UPDATE scene_image_tasks SET status='queued', plan_json=NULL, error_code=NULL, error_summary=NULL WHERE task_id=?",
      ).run(enabledTask!.taskId);
    });
    releaseHold = f.app.services.mediaMaintenance.claim("image", service.serviceId, randomUUID());
    pendingMaint = f.app.services.mediaMaintenance.update("image", service.serviceId, true, () => true);
    await new Promise(resolve => setTimeout(resolve, 50));
    f.app.services.sceneImages.dispatchAutomatic(f.roleId, f.windowId);
    await f.app.services.sceneImages.waitForIdle(f.roleId);
    const blockedByMaint = f.app.services.sceneImages.getTask(f.roleId, f.windowId, enabledTask!.taskId);
    assert.equal(blockedByMaint.status, "failed");
    assert.equal(blockedByMaint.errorCode, "MEDIA_SERVICE_MAINTENANCE");
    releaseHold();
    releaseHold = undefined;
    await pendingMaint;
    pendingMaint = undefined;

    f.app.services.activity.resume(f.roleId);
    const [recovered] = await reply(f);
    assert.equal(recovered!.status, "succeeded");
    assert.equal(generations, 2);
  } finally {
    releaseHold?.();
    await pendingMaint?.catch(() => undefined);
    await f.close();
  }
});
