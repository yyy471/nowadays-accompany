import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 仅用于隔离验收进程：每次递归删除前核对绝对路径和实际父目录。
if (!process.env.P1_REVIEW_TMP_ROOT) throw new Error("ACCEPTANCE_TMP_ROOT_REQUIRED");
const root = fs.realpathSync(process.env.P1_REVIEW_TMP_ROOT);
const original = fs.rmSync;
fs.rmSync = function (target, options) {
  if (options?.recursive) {
    const absolute = path.resolve(target instanceof URL ? fileURLToPath(target) : String(target));
    const within = (value) => {
      const relative = path.relative(root, value);
      return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!within(absolute)) throw new Error("ACCEPTANCE_DELETE_OUTSIDE_TMP");
    let parent = absolute;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const real = fs.realpathSync(parent);
    if (real !== root && !within(real)) throw new Error("ACCEPTANCE_DELETE_OUTSIDE_TMP");
  }
  return original.call(fs, target, options);
};
