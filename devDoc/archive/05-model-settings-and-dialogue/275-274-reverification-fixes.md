# 274 补修复验问题修复记录（268 进展六）

2026-11-12。按 [271 第 6 节复验](271-model-settings-and-dialogue-independent-review.md#6-274-补修独立复验) 修复换密钥后旧请求的失败提示与测试结果仍可显示的问题。274 已关闭的候选写回场景不再改动。[271 第 7 节复验](271-model-settings-and-dialogue-independent-review.md#7-275-补修独立复验) 追加的已显示旧提示问题见 [276](276-275-reverification-fixes.md)。

## 1. 修复范围与结论

| 编号 | 复验指出的问题 | 修复结论 |
| --- | --- | --- |
| MR-03d | 列表的缓存代次校验只在成功分支执行，旧密钥的失败响应仍显示「读取失败」 | 列表成功与失败都核对供应商缓存代次，晚到的旧结果整段丢弃 |
| MR-03e | 连接测试只检查请求代际与配置键，同地址换密钥后旧测试结果仍显示 | 已保存服务的测试成功／失败同样核对缓存代次，晚到结果不写入提示 |

## 2. 统一的旧结果失效检查

- `useModelProbe` 抽出 `staleAfterRotation(target, epoch)`：仅对带 `cacheKey` 的已保存服务目标生效，比较发出时的缓存代次与当前代次。
- 列表请求在成功与失败分支都应用该检查；测试请求在成功与失败分支也应用。命中时直接丢弃本次结果，不覆盖候选、错误提示或测试提示。
- 忙碌状态仍由各自的请求代际在 `finally` 结算：丢弃结果时「正在读取…」「正在测试…」照常结束。
- 草稿探测（未保存配置、新密钥、清除密钥后的草稿）不受影响：配置键本身包含协议、地址与密钥，表单变化即失效。

## 3. 验证

| 项目 | 命令／范围 | 结果 |
| --- | --- | --- |
| 渲染端类型检查 | `desktop/desk-preview/renderer && npm run typecheck` | 通过 |
| 渲染端构建 | `npm run build` | 通过（`dist` 已重建） |
| 桌面逻辑测试 | `desktop/desk-preview && node --test tests/*.test.cjs` | 109／109 |
| 后端 | 本轮未改后端；沿用 [270](270-268-progress-dialogue-model-picker.md) 的 355 项与 21 步离线验收 | 不变 |
| Electron 复验 | 需由复核方重跑「旧列表失败晚于保存」「旧测试结果晚于保存」两个场景 | 待复验 |

## 4. 变更清单

| 文件 | 变更 |
| --- | --- |
| `desktop/.../components/model/use-model-probe.ts` | `staleAfterRotation()`；列表与测试的成功／失败分支统一核对缓存代次 |
| 文档 | 本文、`devDoc/README.md`、`AGENTS.md`、`devDoc/274`、项目工作记忆 |

## 5. 交接边界

- 本轮为实施方自验，MR-03d／MR-03e 待复核方复验；274 已通过项维持原结论。
- [271 第 3 节](271-model-settings-and-dialogue-independent-review.md#3-待验证与待实施) 仍未实施：Agent 首次穿搭与标注前置条件、生图草稿探测与草稿测试参数、MCP／Skill 探测、真实语音与生图服务、发布包预置角色初始化。
- 共享候选与缓存代次只在本次运行的内存中维护；重启后按供应商重新读取候选。
