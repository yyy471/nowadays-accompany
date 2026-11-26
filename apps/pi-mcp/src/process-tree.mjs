// 父进程独占 Job 句柄。进程正常退出、取消及父进程意外终止都回收整个 Windows 进程树。
export async function createProcessGroup() {
  if (process.platform !== "win32") return child => () => {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const { default: koffi } = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func("void * __stdcall CreateJobObjectW(void *, void *)");
  const configure = kernel.func("bool __stdcall SetInformationJobObject(void *, int, void *, uint32_t)");
  const open = kernel.func("void * __stdcall OpenProcess(uint32_t, bool, uint32_t)");
  const assign = kernel.func("bool __stdcall AssignProcessToJobObject(void *, void *)");
  const close = kernel.func("bool __stdcall CloseHandle(void *)");
  return child => {
    const job = create(null, null);
    if (!job) throw new Error("PI_JOB_CREATE_FAILED");
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION / BasicLimitInformation.LimitFlags
    const limits = Buffer.alloc(process.arch === "ia32" ? 112 : 144);
    limits.writeUInt32LE(0x2000, 16);
    const handle = open(0x0101, false, child.pid);
    try {
      if (!configure(job, 9, limits, limits.length) || !handle || !assign(job, handle))
        throw new Error("PI_JOB_ASSIGN_FAILED");
    } catch (error) { close(job); throw error; }
    finally { if (handle) close(handle); }
    let closed = false;
    return () => { if (!closed) { closed = true; close(job); } };
  };
}
