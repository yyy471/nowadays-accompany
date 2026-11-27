import { spawn } from "node:child_process";

process.once("message", ({ command, args, cwd, env }) => {
  let child;
  try {
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
