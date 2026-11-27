import { fork, spawn, type ForkOptions } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// 父进程独占 Job 句柄。关闭最后一个句柄会回收 Job 内所有进程。
function attachWindowsJob(pid: number): () => void {
  const koffi: typeof import("koffi").default = require("koffi");
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func("void * __stdcall CreateJobObjectW(void *, void *)");
  const configure = kernel.func("bool __stdcall SetInformationJobObject(void *, int, void *, uint32_t)");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, bool, uint32_t)");
  const assign = kernel.func("bool __stdcall AssignProcessToJobObject(void *, void *)");
  const close = kernel.func("bool __stdcall CloseHandle(void *)");
  const job = create(null, null);
  if (!job) throw new Error("PROCESS_JOB_CREATE_FAILED");
  const limits = Buffer.alloc(process.arch === "ia32" ? 112 : 144);
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags
  limits.writeUInt32LE(0x2000, 16);
  const handle = open(0x0101, false, pid);
  try {
    if (!configure(job, 9, limits, limits.length) || !handle || !assign(job, handle)) {
      throw new Error("PROCESS_JOB_ASSIGN_FAILED");
    }
  } catch (error) {
    close(job);
    throw error;
  } finally {
    if (handle) close(handle);
  }
  let closed = false;
  return () => { if (!closed) { closed = true; close(job); } };
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type LaunchMessage =
  | { type: "ready" }
  | { type: "closed"; code: Exit["code"]; signal: Exit["signal"] }
  | { type: "error"; message: string };

interface ProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  timeoutSignal: NodeJS.Signals;
  unrefTimer?: boolean;
  onOutput(stream: "stdout" | "stderr", chunk: Buffer): void;
  onError(error: Error): void;
  onClose(exit: Exit & { timedOut: boolean }): void;
}

export function runScopedProcess(options: ProcessOptions): void {
  const { command, args, cwd, env, timeoutSignal, onOutput } = options;
  const windows = process.platform === "win32";
  let timedOut = false;
  let settled = false;
  let targetExit: Exit | undefined;
  let closeJob: (() => void) | undefined;
  const launcherOptions: ForkOptions & { windowsHide: boolean } = {
    execArgv: [],
    env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  };
  const child = windows
    ? fork(fileURLToPath(new URL("./process-launcher.mjs", import.meta.url)), [], launcherOptions)
    : spawn(command, args, { cwd, env, shell: false, windowsHide: true });
  const stop = (): void => {
    if (closeJob) closeJob();
    else child.kill(timeoutSignal);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeoutMs);
  if (options.unrefTimer) timer.unref();
  const fail = (error: Error): void => {
    if (settled || timedOut) return;
    settled = true;
    clearTimeout(timer);
    if (windows) stop();
    options.onError(error);
  };
  child.once("error", fail);
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    closeJob?.();
    if (settled) return;
    if (windows && !timedOut && !targetExit) {
      fail(new Error("PROCESS_LAUNCHER_EXITED"));
      return;
    }
    settled = true;
    const exit = windows && timedOut
      ? { code: null, signal: timeoutSignal }
      : targetExit ?? { code, signal };
    options.onClose({ ...exit, timedOut });
  });
  child.stdout?.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => onOutput("stderr", chunk));
  if (!windows) return;
  child.on("message", (message: LaunchMessage) => {
    if (settled || timedOut) return;
    switch (message.type) {
      case "ready":
        try {
          if (closeJob || child.pid === undefined) throw new Error("PROCESS_LAUNCHER_NOT_READY");
          // Launcher 绑定 Job 之前不接触目标命令，消除后代抢先派生的竞态。
          closeJob = attachWindowsJob(child.pid);
          child.send({ command, args, cwd, env }, (error) => { if (error) fail(error); });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
        break;
      case "closed":
        targetExit = { code: message.code, signal: message.signal };
        clearTimeout(timer);
        stop();
        break;
      case "error":
        fail(new Error(message.message));
        break;
    }
  });
}
