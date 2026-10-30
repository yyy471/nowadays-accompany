# 模型配置原型同名服务ID修复记录

2026-10-30。修复对象：[158独立复验](158-model-config-delete-fixes-independent-recheck.md)的R1（P2）；前序为[156](156-model-config-fixes-independent-recheck.md)、[157](157-model-config-delete-and-recovery-fixes.md)。本记录为实现方修复与自验，不代替独立复验；158原结论保留。

## 1. 结论

合法服务ID与Object原型属性同名（如`constructor`、`toString`）时，不再被共享写入协调器误判为被另一编辑面占用。空闲服务的简易保存、高级编辑、清除密钥与删除均可执行；意图锁、在途写入和释放仍按正常规则生效。未新增ID限制或后端契约。

## 2. 根因与修复

位置：[service-write-coordinator.ts](../desktop/renderer/src/lib/service-write-coordinator.ts)第23～81行，消费处为[Models.tsx](../desktop/renderer/src/pages/Models.tsx)第432～433、522～523行和[ProviderManager.tsx](../desktop/renderer/src/components/ProviderManager.tsx)第46～49行。

原快照初始`{}`与`Object.fromEntries`结果都是带Object原型的普通对象。以providerId直接索引时，未设置的`constructor`/`toString`会读到继承函数；函数为truthy且不等于`models`/`advanced`，于是空闲服务被判为他人占用。

修复采用双层保障：

- `ownRecord`生成无原型字典，用于初始快照、`#buildLocks()`和`writes`导出；键只可能是协调器写入的自有键。
- `begin()`及两个编辑面的所有占用读取改用`Object.hasOwn`，即使快照来源变化也不会把原型属性当作锁或写入。

同批核对其他按provider id索引的普通对象：[Models.tsx](../desktop/renderer/src/pages/Models.tsx)第114～163行的`previousProviderById`原为`Record<string,string>`，对原型同名id会读到继承函数，导致来源变化无法标记。改为`Map<string,string>`后，`constructor`等服务在目录变化时仍能正确显示“使用最新服务信息”。

未修改`ServiceWriteGuard`对外形状，调用方仍读取`locks`/`writes`；无原型字典可被正常展开和比较，不引入持久化或序列化变化。

## 3. 行为与回归

| 场景 | 结果 |
| --- | --- |
| 空闲`constructor`/`toString` | 快照无自有锁/写入，`begin`成功；简易保存、删除、清密钥按钮可用且无占用提示 |
| 意图锁 | 同名服务被登记后另一侧不能`begin`；释放后恢复 |
| 在途写入 | 同服务第二个写入被拒绝；`end`后可再次占用 |
| 释放 | 写入结束后快照不再含自有键，读取为`undefined` |
| 两个编辑面 | 普通id与两个原型同名id均完成简易保存、高级保存、清密钥、删除 |
| 来源变化 | `constructor`服务变更后出现“使用最新服务信息”；采用后保存仍带原providerId |

新增自动化：

- `test/service-write-coordinator.test.ts`：+2项，覆盖空闲自有键、意图锁与在途写入释放。
- `test/models-page.test.tsx`：+1项，`constructor`服务空闲可提交、锁/写入时禁用、释放后恢复。
- `test/provider-manager.test.tsx`：+1项，`toString`服务删除/清密钥按钮与影响读取不受原型属性影响。

真实React探针`test-results/model-config-id-fixes/browser-id-review.mjs`对`ordinary-service`、`constructor`、`toString`分别执行简易保存、高级脏草稿与在途写入、清密钥、删除，并另测`constructor`来源变化与采用；4组、0错误。截图在`test-results/model-config-id-fixes/shots/`。

## 4. 验证与证据

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 132文件、1248项通过、1项既有跳过 |
| `npm run desktop:build` | 通过 |
| `npm run ui:tokens:check` / `git diff --check` | 通过 |
| 定向3文件 | 36项通过：协调器6、服务纸页18、高级管理12 |
| 原型同名ID真实React专项 | 4组、0错误 |
| 154原R1～R3专项 | 6组、0错误 |
| 157 F1/F2专项 | 8组、0错误 |
| 开发版／生产dist既有探针 | 各13/13通过 |
| 隔离Electron 100%／125% | 各3/3通过，无横向溢出 |

浏览器均为隔离Vite与内存HTTP夹具；未连接真实QQ/模型/SnowLuma，未读取或修改正常业务配置；预览服务已停止。158真实Core对三个id的持久化证据保留原身份，本轮未重复Core重放。

## 5. 边界与后续

- 本记录不关闭158，仍需独立复验该P2；也不代表151真实服务、原生草稿/退出、屏幕阅读器或发行EXE通过。
- 未禁止或改写这些合法id，未修改后端配置格式。
- 其他按字符串键索引的实现未在本轮全面审计；本批只处理模型配置协调器及同页来源跟踪，避免扩大范围。
- 未提交、推送、打包或替换EXE。
