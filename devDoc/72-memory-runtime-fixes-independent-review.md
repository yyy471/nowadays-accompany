# MEM02 修复独立复验

日期：2026-10-26。依据：[70 独立复核](70-memory-runtime-independent-review.md)、[71 修复记录](71-memory-runtime-review-fixes.md)、[68 验收标准](68-memory-retrieval-runtime-acceptance.md)。

结论：**70号R1/P1与R2/P2已修复，本轮代码和自动回归复验通过，未发现新的阻塞项，MEM02可以收口。** 结论仅覆盖当前后端手工记忆检索/预览/Agent链路，不代表自动提取、摘要、管理界面或真实环境全部完成。

## 1. 原问题关闭依据

| 项目 | 核验结果 |
| --- | --- |
| R1 本轮工具guard | QqInstance构造isRoleBindingCurrent时，已传capturedMemory.guard；chat后、Provider执行准入、媒体job执行和结果处理复用原有回调，不把当前新guard替换到旧context |
| R2 OR缓存遍历 | 已耗尽和本次首次超计费两个分支均continue，剩余有界关键词可读取缓存；未知不缓存成false，最终仍无法判断才列unscannedIds |

最小生产改动保持了既有发送、角色、世界书和手动发送路径；没有新增第二套匹配器或工具准入系统。host契约注释同步表明回调覆盖本轮记忆身份。

## 2. 正式测试核验

新增test/memory-tools.test.ts的5项使用真实Core/Instance/Agent/MediaJob与FakeProviderAdapter/FakeChannel，检查了实际Provider调用数、任务/媒体与发送数：

- 删除记忆后旧chat响应不能发起生图；新轮可正常执行并投递，只有新轮一项生成任务。
- 关闭记忆后旧chat响应不能发起语音；新轮正常，媒体索引不混入旧轮结果。
- 任务已提交路径被门控、尚未调用Provider时删除记忆，executor拒绝，生成调用为0、delivery=skipped。
- Provider调用已经开始后发生变化，不要求撤销已发生调用；旧结果不进入媒体索引或投递，新轮恢复。
- 其他scope修改与当前scope幂等回执重放不误取消有效工具轮次。

test/memory-selector.test.ts新增R06b/R07b覆盖：未知key在缓存true之前、首键首次超计费、缓存false/未知混合、countSkipped与unscanned区分。原pinned、预算、扫描尾部、summary忽略及输入不变测试继续通过。

本轮核验使用上述正式回归，不运行70号以“异常调用发生”为成功条件的旧探针来宣称修复通过。各测试均为Fake调用，没有真实费用或QQ发送。

## 3. 实跑结果

| 命令 | 结果 |
| --- | --- |
| npm test | 93文件通过；833项通过、1项既有跳过，共834项 |
| npm run typecheck | 通过 |
| npm run desktop:build | 通过 |
| git diff --check | 通过 |

既有跳过仍为Windows创建链接EPERM的原目录导入分支，新增回归没有skip。原MEM01持久化、记忆预览/上下文/发送、世界书、插件/Skill及退出回归仍通过。

## 4. 边界与下一步

已开始的外部Provider调用可能已经收费，修复保证的是作废轮次不新发起工具调用、排队执行会重验、旧结果不继续投递，不能扩大成“任何时候删除记忆都能撤销费用或已发消息”。

真实QQ/付费服务、原生及视觉待验收清单继续独立跟踪。本轮未做浏览器或原生验收，也未新增记忆界面。

下一阶段可进入MEM03方案细化：先定稿自动提取触发、来源范围/水位、generation失效和删除后再提取抑制策略，再实现有界协调器和严格输出。MEM02通过不授权自动开始付费提取，autoExtract现有字段仍没有后台提取行为。

本次仅复验与文档更新，未修改生产代码、未提交Git、未打包或替换EXE。
