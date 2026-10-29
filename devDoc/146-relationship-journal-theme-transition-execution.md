# 146 关系页昼夜切换执行记录

2026-10-29。实现范围为关系页主题表现策略、主题控制器的策略生命周期、关系页窄屏页签排布与定向回归。迁移主记录见[144](144-relationship-journal-migration-execution.md)，原貌迁移方案见[143](143-relationship-journal-migration-plan.md)，前序独立复核见[145](145-relationship-journal-independent-review.md)。本记录不更新145的审查结论，也不替代主记录中的最终双主题截图、全量回归与桌面构建验收。

## 实现

- `ThemePresetProvider`仍是主题预置的唯一状态所有者。`roles`路由通过`useThemeTransitionStrategy`临时注册关系页策略；注册只控制表现，不增加预置状态。没有该策略的其他页面继续使用现有天气换场。
- 关系页切换时立即提交预置，保留React关系编辑器、当前账号/会话、总览筛选和草稿。局部真实DOM做纸页暗场/晨光收束；普通关系页按右页横线伪元素实际矩形、行距和当前刻度位置配对，依次表现为横线收成短划、短划升起为调频刻度。反向切换让刻度落下并铺回纸线。总览只做材质与明暗收束，不显示线段形变。
- 线段浮层位于真实DOM之上，不依赖View Transition快照层级；被浮层替代的原生纸线和刻度在过渡时隐藏，避免双画。颜色使用关系页现有语义变量。测量来自实际`.leaf.right`伪元素和`.strip .tk`，不使用原稿全窗口固定inset。
- 策略适用失败或关系页DOM缺失时直接提交最终预置，不退回全局天气动画。控制器同时识别在途策略清理器与View Transition；偏好变化、文档隐藏、策略切换、反向选择和卸载都会收束，旧回调受generation保护，不能提交过期预置。
- 关系页局部`data-motion=reduced`、窗口缩放、纸页/strip测量节点替换、缓存矩形位置/尺寸变化或关系页卸载会提前结束在途动画。`ResizeObserver`监测页面和测量区域，DOM变动时复核纸线/频率条矩形；清理器断开观察器、移除resize监听、取消WAAPI、移除形变浮层并清除临时标记。
- 新增纯函数`layoutJournalTabs`，根据实际strip宽度、页签自然尺寸和原始索引位置计算排布。当前页与结构页优先，夹紧后needle使用同一个实际中心；可见页签不相交且不越过strip边界。空间不足时进入名册索引回退，隐藏超出可用宽度的装饰索引页签；按钮保留完整`title`和ARIA名称，会话名册保留全部会话入口。键盘切换后焦点跟随新当前页。

## 自验

定向文件：

- `desktop/renderer/src/ui/theme-transition.ts`
- `desktop/renderer/src/ui/presets.tsx`
- `desktop/renderer/src/ui/relationship-journal-transition.ts`
- `desktop/renderer/src/ui/relationship-journal-transition.css`
- `desktop/renderer/src/lib/relationship-journal-layout.ts`
- `desktop/renderer/src/pages/Relations.tsx`
- `desktop/renderer/src/ui/relationship-journal-integration.css`
- `test/relationship-journal-theme-transition.test.tsx`
- `test/relationship-journal-layout.test.tsx`

检查结果：

1. `npm run typecheck`通过。
2. 定向回归：几何观察器新增前，`npm test -- --maxWorkers=4 --minWorkers=1 test/relationship-journal-theme-transition.test.tsx test/relationship-journal-layout.test.tsx test/relationship-journal.test.tsx test/relationship-journal-controller.test.tsx test/character-theme.test.tsx test/ui-motion-contract.test.tsx`为6个文件、55项通过。新增矩形变化收束后，再运行`npm test -- --maxWorkers=4 --minWorkers=1 test/relationship-journal-theme-transition.test.tsx`，1个文件、11项通过。覆盖原天气默认行为、策略接管/反向清理、策略切换时中止天气快照、局部减少动效、窗口/页面/测量区域变化、两方向纸线/刻度几何、总览材质模式、页签越界/碰撞/needle/current和名册回退，以及关系页控制器、双主题和公共动效契约。
3. 沙箱内Vitest首次启动在`node_modules/vitest/dist/spy.js`的`realpathSync.native`遇到EPERM，尚未收集测试；将`TEMP`/`TMP`指向仓库内`test-results/relationship-journal/tmp`并限制worker后，在授权执行环境重跑通过。该首次启动错误不是测试断言失败。

生产Electron中的最终过渡帧、1024×640窄屏截图、完整测试集和桌面构建结果由144记录汇总；本执行记录不把纯函数/组件回归或预览当作原生最终验收。尚需独立复核记录确认策略清理和密集页签行为。
