"use strict";

const { app, BrowserWindow, shell } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { until } = require("./live-desktop.cjs");

const opened = [];
shell.openPath = async target => { opened.push(target); return ""; };
require("../../electron/main.cjs");

async function run() {
  await app.whenReady();
  const window = await until(() => BrowserWindow.getAllWindows()[0], "诊断封面窗口");
  const ev = script => window.webContents.executeJavaScript(script);
  const wait = (script, label) => until(() => ev(script), label);
  const mode = process.env.DIAGNOSTIC_MODE;
  await wait("document.querySelector('.boot-gate')?.dataset.phase === 'failed'", "显示启动失败");
  const diagnosis = await ev("document.querySelector('.boot-gate [role=status]').textContent");
  const expected = {
    lock: /本机数据目录正在使用.*INSTALLATION_BUSY/,
    missing: /缺少.*(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)/,
    "health-crash": /code=43.*最后一行错误：DIAGNOSTIC_CRASH_DURING_HEALTH/
  };
  assert.match(diagnosis, expected[mode]);
  assert.equal(await ev("document.activeElement.className"), "boot-retry");
  assert.equal(await ev("document.querySelector('.boot-open-logs').hidden"), false);
  assert.equal(await ev("window.nowadaysDesk.openBackendLogs.length"), 0);
  await ev("document.querySelector('.boot-open-logs').click()");
  await until(() => opened.length === 1, "经受信 IPC 打开日志目录");
  const logs = path.join(app.getPath("userData"), "logs");
  const latest = path.join(logs, "backend-latest.log");
  assert.deepEqual(opened, [logs]);
  const content = fs.readFileSync(latest, "utf8");
  if (mode === "lock") {
    assert.match(content, /\[stderr\] INSTALLATION_BUSY/);
    console.log("DIAGNOSTIC_LOCK_OBSERVED");
    await until(() => fs.existsSync(path.join(process.env.NOWADAYS_APP_ROOT, "released")), "占锁进程已释放");
    await ev("document.querySelector('.boot-retry').click()");
    await wait("!!document.querySelector('#root > *') && !document.querySelector('.boot-gate')", "重试后业务页面挂载");
    assert.equal(fs.readFileSync(latest + ".1", "utf8"), content);
    assert.match(fs.readFileSync(latest, "utf8"), /\[stdout\] \{"event":"listening"/);
  } else if (mode === "missing") {
    assert.match(content, /\[stderr\].*(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND)/);
    assert.match(content, /\[stderr\].*node:internal/);
  } else {
    assert.match(content, /\[stdout\] \{"event":"listening"/);
    assert.match(content, /\[stderr\] DIAGNOSTIC_CRASH_DURING_HEALTH\n/);
  }
  console.log("DIAGNOSTIC_VERIFIED");
  app.quit();
}

run().catch(error => { console.error(error); app.exit(1); });
