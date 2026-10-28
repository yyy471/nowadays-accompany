# 折信 N 品牌替换独立复核

2026-10-28。独立复核方：`logo_review` 子代理；实施方为主代理。本次仅复核用户采用的折信原稿接入，不把开工前已有的 Dock/动效规范变更纳入该工作包。

## 结论

本次资产、源码、token 与打包路径范围通过。初查发现 Windows 窗口图标仍使用大 PNG，未消费小尺寸母版；实施方已改为 Windows 使用多帧 `icon.ico`，复核确认修正。未发现其余阻塞项。

本结论不代表已验收系统实际选择的托盘帧、开始菜单缓存或发行安装包。实际页面截图、全量与构建证据由实施记录 [123](123-fold-logo-adoption-execution.md) 单独说明，独立复核不借用实施方的运行结果作为自己的执行记录。

## 独立执行的检查

| 检查 | 本次结果 |
| --- | --- |
| 原稿逐字节比对 | `desktop/assets/icon.svg` 与外部 `nowadays-N-fold-app-light.svg` 完全一致；`icon-small.svg` 与外部 `nowadays-N-fold-app-light-16.svg` 完全一致 |
| 透明符号比对 | light/dark 与外部原稿唯一差异为 `viewBox` 从 `0 0 1024 1024` 改为 `246 234 532 556`；路径、颜色、渐变及折痕全部保留 |
| 可见图形包围范围 | 字形主体 x262–762/y250–774；8px外沿最多到x258–766/y246–778；其余光带受左右笔画clipPath限制。新画布x246–778/y234–790完整容纳可见图形 |
| ICO二进制检查 | 应用ICO包含16/20/24/32/48/64/128/256八帧；托盘ICO包含16/20/24/32四帧；各帧DIB尺寸、偏移和数据范围有效，均有实际颜色及非空可见像素 |
| 专用小母版核验 | 解码16px帧，确认专用小母版的樱粉笔画RGB217/178/188存在；大母版对应笔画为#DDCFD0，因此不是把大母版直接缩小；解码图像目视可辨认N |
| 公共资产同步 | public中的PNG、ICO分别与desktop/assets对应产物完全一致 |
| token同步 | `npm run ui:tokens:check`通过；品牌盒34×36px走primitive → semantic → component引用链 |
| 定向Vitest | `npx vitest run test/branding.test.ts test/character-tokens.test.ts test/ui-library-contract.test.ts`：3文件、10项通过 |

机器结果见[独立资产记录](design/character-studio/fold-logo/independent-assets.json)。来源根目录为用户提供的`E:/tmp/testWorkSpace/switchboard/nowadays-logo-n/fold/`，逐字节比对在本机实际执行。

## 源码与兼容检查

- `BrandMark`由公共UI入口导出，使用现有`useUiAppearance`读取预置；nightwave选dark，其余选light。图片为空alt且aria-hidden，品牌按钮保留`Nowadays，返回主页`可访问名称。
- 正式壳与组件样板共用该组件，替换后无旧`n·` DOM/CSS继续参与品牌渲染；标记盒固定，字标改为`Nowadays`，原导航处理器与草稿准入调用未修改。
- Windows窗口使用`icon.ico`，托盘直接将`tray.ico`路径传给Electron；安装包`win.icon`指向应用ICO，自定义打包脚本将PNG、ICO及托盘ICO复制到实际资源目录。favicon改用已同步的ICO。
- `package.name`、CLI命令、`appId`、AppUserModelId、桌面桥名称、localStorage键、API参数均保留原标识。`app.setName`改展示大小写后，`app.setPath('userData', desktopUserDataPath(...))`仍显式执行；未改的branding函数继续优先历史`Accompany`目录，否则使用小写`nowadays`目录。
- 系统图标固定light酒红底版，不随页面预置修改；没有新增Core、SnowLuma、QQ、模型调用或任何业务写入。

## 复核边界

本方没有重跑全量测试或桌面构建，没有启动真实QQ/模型，没有构建或安装新的发行EXE，也未读取真实用户数据。本次运行的是独立资产检查、token校验和上述10项定向测试；系统托盘及发行图标的最终OS外观不由文件解析或源码审阅代替。
