import { spawn } from "node:child_process";

process.once("message", ({ command, args, cwd, env }) => {
  let child;
  try {
    // Windows 可能补入父环境；此启动器仅使用一次，清除目标未授权的环境变量。
    const allowed = new Set(Object.keys(env).map(key => key.toUpperCase()));
    for (const key of Object.keys(process.env)) {
      if (!allowed.has(key.toUpperCase())) delete process.env[key];
    }
    child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    process.send({ type: "error", message: error.message });
    return;
  }
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  let failed = false;
  child.once("error", (error) => {
    failed = true;
    process.send({ type: "error", message: error.message });
  });
  child.once("close", async (code, signal) => {
    if (failed) return;
    // 等待转发写入宿主管道，再通知宿主关闭 Job；子孙持管道时仍由宿主超时回收。
    await Promise.all([
      new Promise((resolve) => process.stdout.write("", resolve)),
      new Promise((resolve) => process.stderr.write("", resolve)),
    ]);
    process.send({ type: "closed", code, signal });
  });
});
process.send({ type: "ready" });
