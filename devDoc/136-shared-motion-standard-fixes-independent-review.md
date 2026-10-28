# 共享组件与动效规范修复独立复核

日期：2026-10-28。对象：132～135对131-R1～R4的修复，当前未提交工作区。

> 2026-10-28跟进：136-R1已由[137嵌套作用域减少动效下限修复](137-nested-motion-scope-fix.md)处理，Appearance继承层统一加reduced下限，`UiThemeProvider`与`UiThemeScope`共用；实现方回归通过，独立复验待做。R2～R4的关闭结论保留。

**结论：本轮暂不完全通过。131-R2、R3、R4可关闭；R1单层局部减少动效已修复，但嵌套显式full仍能解除上层reduced，保留1项P2。** 原有主页及其他业务页设计边界不变，不要求重做其他页面。

## 1. 逐项结果

| 原项 | 独立核验结果 |
| --- | --- |
| 131-R1 局部动效偏好分歧 | `useMotionPolicy`已合并当前Appearance.motion。直接局部reduced时菜单/弹窗/确认均不再播放，运行中切reduced也收束。**嵌套覆盖仍不完整，见136-R1** |
| 131-R2 设置双入场 | 旧settings-appear声明与keyframes已移除；隔离浏览器运行真实Modal加settings-dialog类，仅1个220ms WAAPI、无CSSAnimation。**关闭** |
| 131-R3 Dock配方分散 | 新增材质混色及夜间阴影颜色用途token，Dock CSS消费对应变量，原rgba颜色字面量已移出CSS，生成同步通过。保留允许的布局/绘制细节，不要求把每个几何常量机械变量化。**按原维护项范围关闭** |
| 131-R4 样板手拼旧导航 | Workbench删除本地navItems及手拼nav，复用正式PageDock与其目的地，回调只改变本地样例状态。正式组件与样板不再维护两份导航实现。全量中的样板契约回归通过。**关闭** |

R3/R4本轮以代码、生成同步及正式回归为主要证据，没有独立重跑134的截图像素对比或原生脚本，不把实现方结果算成独立执行。

## 2. 136-R1 / P2：嵌套full覆盖祖先reduced，R1尚未完全关闭

### 代码位置与原因

`desktop/renderer/src/ui/appearance.tsx:14`的UiThemeProvider，以及`:21`的UiThemeScope，仍以`motion ?? inherited.motion`合并局部偏好。显式full会覆盖继承到的reduced。

随后`useMotionPolicy`只合并全局Context和最近一层Appearance.motion；祖先的reduced已经丢失，applyScopedMotionPolicy无法恢复它。纯函数对全局reduced的保护正确，并不能代替整个作用域链的继承合并。

132第1节已明确“reduced是不可解除的下限，full不能解除任何已成立的reduced结论”，因此本项属于本次修复定义内的遗漏，不是新增的页面设计需求。

### 独立浏览器复现

在全局MotionPolicyProvider preference=full下运行真实公共组件：

```tsx
<UiThemeScope theme="xiacheng" motion="reduced">
  <UiThemeScope theme="xiacheng" motion="full">
    {/* 实际DropdownMenu、Modal，以及此处调用useConfirm的消费者 */}
  </UiThemeScope>
</UiThemeScope>
```

实际结果：

- 内层普通弹窗Portal变成data-motion=full，运行1个220ms动画，采样opacity约0.397037。
- 内层菜单运行1个动画；外层重新设置reduced后，内层仍保持full并继续运行。
- 内层发起的确认Portal也变成full，运行220ms动画，采样opacity约0.396094。

原本单层reduced的对照探针通过：弹窗/确认opacity=1且无动画，菜单动画数0。两个场景结果独立保存在本轮目录，未覆盖前次审计记录。

该复现属于公共API组合，当前主页没有在此次核验中发现同样的显式嵌套消费点；不将本项夸大为主页的全局减少动效开关失效。

### 修复要求

1. 在Appearance继承合并处统一维护reduced下限，祖先或当前局部任一reduced都不得被后代full解除；UiThemeScope和UiThemeProvider执行同一规则，不让页面各自补Provider。
2. 公共Modal/菜单继续消费同一有效策略；确认在真实调用位置捕获已经合并的局部结论，Portal上的data-motion与JS一致。
3. 保留全局full覆盖系统reduce的既定语义，不能为修嵌套将全局完整动效开关改坏。
4. 增加实际组件组合回归：外层reduced→内层full、外层reduced→中间UiThemeProvider(full)→子组件、祖先由full动态变reduced、经确认队列进入Portal。当前新增测试只覆盖“内层未指定则继承”，没有覆盖“内层显式full”。

验收：上述所有减少动效场景的实际菜单/弹窗/确认均无装饰位移/入场动画，样式与data-motion一致；祖先中途改reduced立即收束，不影响焦点、队列和模态隔离。

## 3. 本轮实际验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | **124文件、1152项通过、1项既有跳过** | `test-results/review136/full.log` |
| `npm run typecheck` | **通过** | `test-results/review136/typecheck.log` |
| `npm run desktop:build` | **通过** | `test-results/review136/build.log` |
| `npm run ui:tokens:check` | **通过** | `test-results/review136/tokens.log` |
| `git diff --check` | **通过** | 本轮命令输出 |
| 原单层公共组件探针 | reduced直达和运行中切换均通过；确认也无动画；设置只1个WAAPI | `test-results/review136/browser-probes.json`、`.log`；原单层入口备份`entry-direct.tsx` |
| 嵌套作用域补充探针 | **复现136-R1** | `test-results/review136/nested-probes.json`、`.log`、`nested-probes.mjs`、当前`entry.tsx` |

探针打包当前实际React公共组件与公共CSS，在隔离Chrome headless中执行，不导入Core，不连接QQ或模型、不使用用户Chrome资料。结果文件为测量数据，不将“探针脚本退出0”解释成所有测量均满足规范；嵌套数据已明确暴露剩余问题。

本轮未重新执行135的完整App 30/27项或原生Electron验收，其历史自验记录保留。原生草稿取消/安全退出、真实触屏、保存结果消费者、其他页面设计及完整发行包仍在各自待办范围，不与此共享修复混为完成。

本轮仅新增本复核文档、更新导航及忽略目录中的探针/日志；未修改生产代码或正式测试源码，未提交、推送或打包。
