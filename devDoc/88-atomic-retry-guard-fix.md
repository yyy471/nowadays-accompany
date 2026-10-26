# 88 原子写重试授权复核修复

## 变更

- 原子写在每次实际 `rename` 前复核同一个 `beforeCommit`；退避期间授权撤销会立即拒绝，不再尝试后续 `rename`。拒绝沿用 `write_guard_changed`，并由现有失败清理路径删除临时文件。
- `EPERM`、`EACCES`、`EBUSY` 的有界重试限定为 Windows，共 4 次尝试；非共享类错误仍原样抛出。测试显式模拟 Windows 冲突，并覆盖非 Windows 权限错误不误重试。
- 回归还断言撤权后旧目标内容保留、临时文件清理、同路径后续写恢复；无 guard 的 Windows 共享冲突重试成功与达到上限仍有覆盖。

## 验证

- `npx vitest run test/atomic-write.test.ts`：9 项通过。首次沙箱运行在 Vitest 模块 realpath 处遇到 EPERM，按任务授权提升后重跑通过。
- `npm run typecheck`：通过。
