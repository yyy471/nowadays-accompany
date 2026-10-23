# 模型设置简化与应用设置弹窗

日期：2026-10-22。状态：代码、自动化测试与隔离页面验收通过。本文覆盖旧13～17号文档中复杂模型服务表单和全页设置入口的交互要求。

## 本轮需求与设计

- 设置首屏固定三个入口：文本模型、视觉模型、视频模型；未配置也展示对应行。
- 生图、语音生成等作为扩展模型额外添加，仍可供账号分别选择。既有服务、旧模型、账号绑定与参数不因表单简化被删除。
- 基本配置为Base URL、API Key、模型名，可获取模型列表也可手动输入；不展示本地/云端、凭据引用、provider id等内部字段。工具调用能力、协议等必要扩展项折叠。
- 获取列表只证明列表可读，不证明所选模型可执行。验证针对未保存草稿发送最小真实能力请求，文字/视觉/视频分别调用；失败不给成功状态。验证不保存草稿、Key或账号数据，不发QQ、不生成任务历史。
- Key继续由后台凭据库保护。相同服务地址编辑时可留空保留；改到不同origin不会转发旧Key，需要重新输入。模型名支持`vendor/model:latest`等常见形式。
- 应用设置入口固定到全局左下角，打开二级弹窗并保留底层页面；设置内区分模型服务、外观、SnowLuma及运行信息。关闭、Escape、焦点约束/恢复、未保存修改保护需验收。

## 后端契约

`POST /providers/simple`：`{providerId?, capability, baseUrl, modelId, secret?, adapterId?, supportsTools?, parameters?}`。自动分配新服务ID及凭据引用，保留旧服务其他模型和高级参数，返回`{ok, provider}`。通过`provider.options.settingsModels[capability]`记住固定行选择，只清理同能力的其他默认标记，不改变账号策略。

`POST /providers/models`：`{providerId?, baseUrl, secret?}`，返回`{ok, models:string[]}`。从指定服务读取models，10秒超时、1MiB响应上限；不支持时可手填，不自动按模型名称猜能力。

`POST /providers/validate`：与simple相同，另带`confirmCost:true`，返回`{ok, result}`。仅使用草稿和本次/同源已存Key，不持久化。错误与短结果文本精确遮盖Key。验证按钮附近说明会真实调用服务及可能产生少量费用。

视频默认兼容支持`video_url`的多模态Chat Completions服务，旧`video-polling-v1`协议保留为高级选项；不宣称任意视频服务互相兼容。HTTP/HTTPS地址由用户提供，后台保留自动网络分类用于既有媒体上传授权，不增加本地/云端选择步骤。

## 参考依据

参考[Dify官方模型提供商文档源码](https://github.com/langgenius/dify-docs/blob/main/en/cloud/use-dify/workspace/model-providers.mdx)的“配置凭据、选择模型、自定义模型”分步形式；本项目固定行和弹窗结构按用户要求确定。

兼容视频负载依据[Alibaba Cloud多模态接口文档](https://www.alibabacloud.com/help/en/model-studio/qwen-omni)及[NVIDIA NIM视频输入文档](https://docs.api.nvidia.com/nim/reference/qwen-qwen3-5-122b-a10b-infer)中`video_url`及base64 Data URI格式。仅做协议支持，不据此保证某供应商所有模型支持视频。

## 验收记录

旧基线36文件、238项测试通过。新增`test/model-setup.test.ts`使用真实回环HTTP模拟服务，11项通过，包含简化保存、列表获取、三类真实协议验证、不落盘、旧模型/Key/账号绑定保留、默认选择切换、不同origin不转发Key、手填退路、错误脱敏、共享服务并发保存、共享凭据更新隔离与内部地址分类。20:06全量回归37文件、249项通过。最终`npm run typecheck`及`npm run desktop:build`通过。

浏览器在临时数据目录和回环HTTP模拟服务中完成以下验收：

- 从资料与角色页左下角打开设置，底层页面保持，关闭后焦点回到设置入口。
- 三个固定模型入口初始收起；复用同一服务分别验证文本、图片、视频请求并保存，重新打开后仍保持三个不同模型选择。
- 获取列表返回4个候选，成功后可见数量提示；模型名也允许手动输入。
- 保存后Key清空且显示已保存提示，配置JSON未包含测试Key明文。原账号策略不因配置全局模型而自动授权。
- 修改草稿显示“待保存”；切换外观分区后草稿保留；关闭确认选择取消保留草稿，确认放弃后恢复已保存模型。
- 弹窗使背景不可操作，Escape关闭、Tab/Shift+Tab循环和焦点恢复通过；1024×720下弹窗留在视口内且无页面横向溢出。
- 生图、语音生成收在“添加扩展模型”下，默认列表保持三项。

本轮返修两项并复验：模型列表成功后没有可见反馈；未保存模型误显示“已配置”。

实际页面截图：[固定列表](../test-results/ui/model-settings-review/settings-list.png)、[展开编辑](../test-results/ui/model-settings-review/settings-editor.png)。截图中的模型、账号及URL都是隔离验收数据。

边界：未调用真实云端付费服务，未执行QQ注入或发送消息；视频接口仍取决于供应商对所选协议的支持。EXE已构建但未启动真实用户环境进行注入验收。

## 新版便携包

产物：`release/Accompany-0.2.0-settings-portable.exe`。原同名常规便携包仍由正在运行的旧版占用，因此保留旧文件，使用`--config.portable.artifactName=Accompany-0.2.0-settings-portable.exe`对本轮最终构建独立封装，electron-builder返回成功。安装版setup文件没有在本轮更新。

启动前从托盘退出正在运行的旧版，再双击上述新版；直接打开新文件会受单实例机制影响。默认`npm run desktop:pack`仍使用原常规名称，今后重新打包时应先退出该文件正在运行的程序。
