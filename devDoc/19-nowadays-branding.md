# nowadays 品牌接入与项目改名

日期：2026-10-22。

## 已改动

- 项目包名、产品名、Windows应用ID、快捷方式、窗口标题、托盘提示、错误弹窗、界面品牌及页面标题统一为 nowadays。
- 选定的 n＋琥珀日光标识重绘为可维护SVG，生成PNG/ICO；前端及安装包共用同一来源。前端资源改名避免旧图标缓存。
- 命令行入口改为 `src/bin/nowadays.ts`，npm命令、帮助文本和配置示例同步更新。旧CLI入口和旧示例保留兼容。
- 桌面桥使用 `window.nowadays` 与 `--nowadays-info`，前端保留旧桥读取兼容。动效首选项读取旧key作回退。
- 环境变量优先 `NOWADAYS_DATA_ROOT / NOWADAYS_UI_DIR / NOWADAYS_LOG_LEVEL`，兼容原 `ACCOMPANY_*`。

## 数据连续性

新安装使用 `%APPDATA%/nowadays`。检测到 `%APPDATA%/Accompany` 时，直接继续使用旧目录，包括凭据库、Electron会话和单实例锁；不复制或删除用户数据。两者都存在时优先旧目录，防止无声切换账户。已添加3项数据路径选择测试。

内部公开类型 `AccompanyError` 等旧API名称保留，避免破坏插件导入。历史开发文档、旧构建产物和工作区目录 `D:/app/nowadays/accompany` 保留原名，便于追溯与继续开发；产品及新构建采用 nowadays。

## 验收

- `npm test -- --reporter=dot`：38个测试文件、252项通过。
- `npm run typecheck`：通过。
- `npm run dist`：桌面构建及安装版、便携版封装。
- `node dist/bin/nowadays.js --help`：输出新名称与新命令。
- 隔离浏览器：窗口页签、导航、设置品牌均为 nowadays，新图标实际呈现通过；发现旧图标缓存后更换资源文件名并复验。
- 截图：[页面接入效果](../test-results/ui/branding/nowadays-app-applied.png)。未在真实QQ环境启动新版，不执行注入或消息发送。

启动前应从托盘退出旧版，避免旧进程持有同一数据目录的锁。Windows原有快捷方式若仍指向旧EXE，应使用新安装版生成快捷方式或手动改指新便携包。

交付：`release/nowadays-0.2.0-portable.exe` 与 `release/nowadays-0.2.0-setup.exe`。
