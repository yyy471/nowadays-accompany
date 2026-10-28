# 嵌套动效作用域修复独立复验

日期：2026-10-28。对象：137号修复，原问题为136-R1（131-R1的嵌套继承遗漏）。当前工作区，未提交。

**结论：136-R1关闭，本轮修复独立复验通过，未发现新增阻塞问题。** 结合136已关闭的131-R2～R4，131号共享规范审计列出的四项问题在本地代码/自动化范围内均已收口。此结论不等于126全部实际环境验收完成，也不代表其他业务页面完成设计迁移。

## 1. 代码核验

`ui/appearance.tsx`将继承合并收口为同一个`mergeMotion`：祖先或当前任一reduced都返回reduced，否则才使用当前显式值或继承值。UiThemeScope与UiThemeProvider均消费该函数。

当前有效策略合并仍由useMotionPolicy处理，全局full覆盖系统reduce的语义没有改变；UiAppearanceProvider继续承载确认请求捕获的合并外观，没有为修嵌套引入第二套队列规则。后代full不再覆盖祖先的局部reduced。

## 2. 独立浏览器复验

本轮在独立目录复制原136嵌套探针，重新打包当前真实React公共组件和CSS执行；没有把137实现方日志作为独立结果。另补中间UiThemeProvider显式full组合，并加入结果断言。

| 场景 | 实际结果 |
| --- | --- |
| 全局full → 外层scope reduced → 内层scope full | 弹窗与菜单有效motion均reduced，运行动画0；弹窗opacity=1 |
| 上述内层发起确认，进入Portal | motion=reduced，运行动画0，opacity=1 |
| 祖先改full，无reduced下限 | 内层菜单motion=full，运行动画1，正常反馈保留 |
| 已运行菜单中祖先改reduced | motion=reduced，运行动画0，opacity=1 |
| 外层scope reduced → 中间UiThemeProvider full → 内层scope full | 同样保持reduced，普通弹窗、菜单和确认Portal均无入场动画 |
| 设置弹窗单一入场回归 | 仅1个220ms WAAPI，无旧settings-appear CSSAnimation |

证据：`test-results/review138/nested-probes.json`、`nested-probes.log`、`provider-probes.json`、`provider-probes.log`。脚本为同目录`nested-probes.mjs`、`provider-probes.mjs`；`entry-scope.tsx`保存原scope组合，当前`entry.tsx`保存中间Provider组合。

两个探针使用隔离Chrome headless及临时浏览器资料，不启动Core/QQ/模型。带断言的Provider组合通过；原嵌套组合测量值也逐项核对。此次没有单独重跑两条排队请求的组合或原生窗口连续交互，不将单次确认Portal结果扩大为所有队列场景的新证据。

## 3. 本轮独立门控

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | **124文件、1155项通过、1项既有跳过** | `test-results/review138/full.log` |
| `npm run typecheck` | **通过** | `test-results/review138/typecheck.log` |
| `npm run desktop:build` | **通过** | `test-results/review138/build.log` |
| `npm run ui:tokens:check` | **通过** | `test-results/review138/tokens.log` |
| `git diff --check` | **通过** | 本轮命令输出 |
| 原嵌套及中间Provider真实组件探针 | **通过** | 上述独立浏览器证据 |

正式回归新增显式嵌套full的继承、有效策略和无下限full保留测试，覆盖了136指出的测试缺口。全量中的原组件、导航/草稿/退出回归保持通过。

## 4. 保留边界与后续

- 本轮没有独立重跑137自验的开发App 30/30、生产dist 27/27或Electron脚本，不引用其数字作为本轮新增验证。
- 原生窗口草稿取消/安全退出组合、真实触屏、真实业务保存消费者等，仍按126～130已披露的状态补证；不能将四项共享修复收口改写为这些事项已完成。
- 其他页面保持旧布局/外观兼容，不因本轮公共层收口重新设计。抽屉、真实QQ/模型和完整发行包仍按各自范围推进。

可以结束131号审计修复循环，按126剩余证据项或后续页面设计安排下一工作包；本轮没有新增共享重构要求。

本轮仅新增本复验记录、更新导航及忽略目录中的探针/日志，未修改生产代码或正式测试源码，未提交、推送或打包；桌面构建输出按验证命令更新。
