# 动效规范登记独立复核

2026-10-27。独立复核方记录；范围为117规范、配套文档入口、token登记与HTML归档。未将实现方118或样板创建阶段的浏览器检查计作本人本次证据。

## 1. 核验范围

- 阅读117全文与105第8/10节、110共用动效说明、根DESIGN、两级AGENTS、根README、公共UI README、开发导航与样板目录说明。
- 核对「正式主题层已实现」「精细动作设计已认可、HTML验证、正式React待接入」「Motion引擎仅建议」「光影/材质/图标/构图仍候选」四类状态，没有把规范登记声明为EXE已更新。
- 117规定了120/160/220/280ms以及400/550ms昼夜节奏、精细参数来源、逐笔落款、书签、阅读顺序、来源浮层、快速中断、草稿准入、模态焦点、减少动效与实施验收。明确正式按压1px与HTML样板2px的差异。

## 2. 本人实际执行

| 检查 | 结果 |
| --- | --- |
| `npm run ui:tokens:check` | 通过，生成CSS与原生窗口token同步 |
| 基线token逐项递归比较 | 除`meta.version`外，283个既有叶值全部不变，无删除 |
| 新增token关系 | 18个primitive.motionDetail、对应semantic引用、24个component.motion参数；生成器引用/三层检查通过 |
| 原生窗口token文件SHA256 | `B106CDBC2E240281465BD0570B4C4750B94756B31032892A3A8CB81CED98DE29`，与本批前一致 |
| 新参数消费者搜索 | 除生成CSS与说明文档外，正式renderer/main/window源码未消费新`component.motion`变量，符合「仅登记」状态 |
| 定向Vitest | 3文件13项通过：character-tokens 6项、character-theme 6项、ui-library-contract 1项 |
| 文档相对链接 | 117、DESIGN、两级AGENTS、根README、UI README、样板README共64处本地链接存在 |
| 收口相对链接 | 118、119与开发导航另174处本地链接存在 |
| 归档HTML一致性 | 精致版与初版分别与本次会话来源文件SHA256一致 |
| 动画库依赖 | package.json未新增motion依赖 |
| `git diff --check` | 通过 |

token比较基线为实现前保存的`test-results/motion-standard-tokens-before.json`；逐项比较由本人独立执行。定向命令为：

```text
npx vitest run test/character-tokens.test.ts test/character-theme.test.tsx test/ui-library-contract.test.ts --pool=forks --maxWorkers=1 --minWorkers=1
```

精致版归档SHA256：`fd49d7ce8a8e4b972a4dfdde1cb603f4befa7b9dca3552fd9ea17ec0f3e8efcc`。

初版归档SHA256：`7774cb6bd2ab25c49520e7c01625baa5338bff9f4b826d4af7448193d52c0834`。

## 3. 审查意见与边界

初审发现开发导航两处旧段落仍以当前入口语气标注105 v1.2.0，已向实现方报告。最终复核确认入口均更新为v1.3.0，v1.2.0整理证据明确保留历史属性；该项关闭。本人另已阅读118执行记录，检查结果与实施边界分别记录，没有混用两方测试项数。

本批是规范与未消费参数登记；本人未运行浏览器/Electron、全量测试或发行包检查，未验证真实业务页已呈现精细动效。样板原有12组检查属于创建阶段的实现方证据，不能计成本次独立应用验收。118执行记录由实现方另行维护。

## 4. 结论

本地文档、参数登记与归档一致性范围通过。旧token及原生窗口颜色未变化，新增参数有明确动作用途、状态和后续接入边界。光影与材质建议继续先以HTML对照选型，再到公共UI及真实Electron验证草稿、焦点与异步行为；此流程与用户本次范围一致。
