import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBackendApp } from "../src/bootstrap/app.js";
import { parseBackendConfig } from "../src/bootstrap/config.js";
import { XIA_CHENG_BUILTIN_KEY } from "../src/application/role/preset-assistant.js";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nowadays-p21-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

/**
 * 包 3 §3.2：打包产物把预置素材放在应用资源目录，由桌面壳显式传给后端；
 * 这里用隔离的 resources 布局验证后端能按该路径初始化夏澄的官方介绍与预置服饰差分。
 */
test("包3：按隔离构建产物的预置素材目录初始化夏澄外观并保持重启幂等", async () => {
  const root = tempRoot();
  try {
    const resources = path.join(root, "resources");
    const presetAssetsDir = path.join(resources, "preset-assets");
    fs.mkdirSync(presetAssetsDir, { recursive: true });
    // 模拟 electron-builder extraResources 的拷贝结果：只有素材，不含源码路径。
    fs.cpSync(path.resolve("assets", "presets"), presetAssetsDir, { recursive: true });

    const config = parseBackendConfig([
      "--app-root",
      path.join(root, "app"),
      "--preset-assets-dir",
      presetAssetsDir,
      "--port",
      "0",
    ]);
    assert.equal(config.presetAssetsDir, path.resolve(presetAssetsDir));

    const first = createBackendApp(config, { disableMemoryRuntime: true });
    const builtin = first.appStore.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
    assert.ok(builtin, "隔离布局下仍应创建内置夏澄");
    const outfits = first.services.appearance.list(builtin.roleId).items;
    assert.equal(outfits.length, 2, "两套预置服饰都应被识别");
    assert.ok(outfits.every((item) => item.isPreset));
    assert.ok(outfits.every((item) => item.presetKey !== null));

    const daily = outfits.find((item) => item.presetKey === "default");
    assert.ok(daily, "应存在 default 预置服饰");
    assert.ok(daily.home, "预置服饰应带主页立绘");
    assert.ok(daily.sprites.length > 0, "预置服饰应带对话差分");
    const homeFile = first.services.appearance.readAsset(builtin.roleId, daily.home.assetId);
    assert.ok(homeFile.data.length > 0);
    assert.match(homeFile.mediaType, /^image\//);

    // 初始化后默认穿着预置服饰，避免进入对话卡在「正在换装」。
    const state = first.services.roles.getState(builtin.roleId).state;
    assert.equal(state.outfitId, daily.outfitId);

    const roleView = first.services.roles.getRole(builtin.roleId);
    assert.equal(roleView.isBuiltin, true);
    assert.ok(roleView.bio.length > 20, "官方介绍应随隔离布局写入");

    const idsBefore = outfits.map((item) => item.outfitId).sort();
    await first.close();

    // 重启：沿用同一预置身份，不重复导入、不更换 outfitId。
    const second = createBackendApp(config, { disableMemoryRuntime: true });
    try {
      const after = second.services.appearance.list(builtin.roleId).items;
      assert.deepEqual(after.map((item) => item.outfitId).sort(), idsBefore);
      assert.equal(second.services.roles.getState(builtin.roleId).state.outfitId, daily.outfitId);
    } finally {
      await second.close();
    }
  } finally {
    cleanupDir(root);
  }
});
