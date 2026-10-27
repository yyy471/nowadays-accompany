# 晚风坐姿人物正式接入

2026-10-27。用户指出夜间人物未生效，确认之前v2只用于候选预览。本批正式采用坐姿v2，解决生产组件仍引用白天人物的问题。

## 改动

- 将已选图复制到生产素材 [character-night.png](../desktop/renderer/src/assets/themes/xiacheng/character-night.png)，与设计目录v2的SHA256均为`4287ECB8E0B5F20821CFD824E5A358D974831324EF75FC49909BD0ECC7E541AB`。
- `HomeScene.tsx`按nightwave加载夜间坐姿图，daylight仍加载原站姿图；同步使用符合实际姿态的alt。
- 移除`preset-appearance.css`对夜间人物的brightness/saturate滤镜，保留图片本身已绘制的冷暖光照。
- 已核对桌面/窄屏比例，无需新增页面或改业务逻辑；不改变账号、自动回复或角色绑定。

## 实际验证

- `npm run typecheck`、`npm run desktop:build`通过。
- 正式dist包含`character-night-B6r49Gji.png`；生产包实测晚风→白昼→晚风及刷新，均加载各自已构建图片，naturalWidth=1024、filter=none，无pageerror。使用Vite preview提供实际dist＋隔离内存接口，无图片替换或拦截。
- [生产包截图](design/character-studio/home-presets/nightwave-production.png)及[生产包核验记录](design/character-studio/home-presets/production-character-review.json)。
- 当前主页脚本11组通过、两主题22组窗口布局通过；实际主屏150%和独立进程125%检查通过，首页无上下滚动。新增检查覆盖真实人物地址、加载成功、取消压暗、往返切换及刷新。
- [当前界面报告](design/character-studio/home-presets/review.json)。

此前111与候选目录的截图保留为历史过程；当前采用状态以112为准。根DESIGN、105、110、开发导航和候选目录状态已同步。

本批更新源码与完整桌面构建，没有重打包/覆盖既有release EXE。通过`npm run desktop:start`启动当前开发版，或刷新隔离预览并选择「晚风电台」即可看到新图；已经安装的旧EXE仍需后续重新打包。未启动真实Core、QQ或模型。

本记录为实现方自验和实际生产包/原生界面检查，不记作另一个独立复核方；没有将既往全量单测数字重复计成本次结果。
