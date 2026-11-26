// 仅在 Windows 实测中使用 Toolhelp 枚举父子关系，并在同一次采样累加当前工作集。
import koffi from "koffi";
const kernel = koffi.load("kernel32.dll");
const snapshot = kernel.func("void * __stdcall CreateToolhelp32Snapshot(uint32_t, uint32_t)");
const first = kernel.func("bool __stdcall Process32FirstW(void *, void *)");
const next = kernel.func("bool __stdcall Process32NextW(void *, void *)");
const open = kernel.func("void * __stdcall OpenProcess(uint32_t, bool, uint32_t)");
const memory = kernel.func("bool __stdcall K32GetProcessMemoryInfo(void *, void *, uint32_t)");
const close = kernel.func("bool __stdcall CloseHandle(void *)");
export function sampleTree(root, seen) {
  const handle = snapshot(2, 0);
  const x64 = process.arch !== "ia32";
  const entry = Buffer.alloc(x64 ? 568 : 556);
  entry.writeUInt32LE(entry.length);
  const groups = new Map();
  try {
    for (let ok = first(handle, entry); ok; ok = next(handle, entry)) {
      const parent = entry.readUInt32LE(x64 ? 32 : 24);
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(entry.readUInt32LE(8));
    }
  } finally { close(handle); }
  let total = 0;
  const pids = [root];
  for (const pid of pids) {
    seen.add(pid);
    pids.push(...(groups.get(pid) ?? []));
    const proc = open(0x0410, false, pid);
    if (!proc) continue;
    try {
      const data = Buffer.alloc(x64 ? 72 : 40);
      if (memory(proc, data, data.length)) total += x64 ? Number(data.readBigUInt64LE(16)) : data.readUInt32LE(12);
    } finally { close(proc); }
  }
  return total;
}
