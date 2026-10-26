# 阶段C：模型服务管理执行记录

日期：2026-10-23。实施范围限renderer模型服务页、账号模型服务选择文案、独立服务管理组件与领域辅助函数；未提交、未打包，未改README。现有阶段A/B未提交改动保留。

## 1. 实施依据与界面

已读取34号阶段C约束、35号草稿规则及36号最新第7节。使用UI/UX Pro Max技能；技能目录中的scripts为路径占位文件，实际搜索脚本从`C:/Users/24349/.skill-hub/ui-ux-pro-max-skill/src/ui-ux-pro-max/scripts/search.py`执行。执行design-system及ux搜索，采用渐进展开、字段标签、明确破坏性确认与操作结果；继续复用现有暖色样式与公共UI，没有引入新的配色或字体。

- 保留文本、视觉、视频固定入口及图片/语音扩展入口，后方增加默认折叠的“全部服务”。
- 显示服务id、Base URL、模型与密钥已保存状态；不展示凭据ref，不增加本地/云端选择。
- 简化入口和账号模型配置下拉均显示“服务id · 模型 · 地址”，同地址服务可区分。
- 已有服务编辑支持地址、适配器、模型名、密钥。模型能力、输入类型、工具标志、复杂参数、limits、timeouts、retry、mediaTransports和options保留；改模型名时同步对应settingsModels标记，并提示检查账号模型选择。
- 保存后提供“去账号模型配置”，仅调用壳回调，由壳统一处理导航保护。首载读取失败提供重试。

## 2. 数据与草稿边界

`providerEditPayload`从冻结的服务基线构造严格ProviderConfig字段，不将DTO派生capabilities/credential对象发送给PUT；凭据引用仅内部用于同origin保存，界面不回显。配置了密钥且换origin时必须重新输入，换origin不继承旧credentialRef。

管理编辑器独立以`settings:provider-manager`登记dirty/busy及hashRevision；切换/重新读取编辑对象经requestTransition。轮询不覆盖dirty草稿；干净时同步服务新基线，dirty时遇到外部更新则保留草稿并禁止覆盖，重新读取须确认放弃。服务从列表消失时仍展示保留的草稿及放弃入口。

保存失败保留草稿；请求和确认期间冻结管理编辑输入与动作，busy登记覆盖预览、等待确认及写请求。确认绑定AbortSignal，卸载中止确认；DELETE前再次检查生命周期，防止离开后继续删除。管理操作不清理固定能力行的草稿，原能力行刷新保护继续保留。

清除密钥和删除服务为独立操作。清密钥只调用`DELETE /providers/:id/credential`，保留编辑中的新密钥等草稿。删除先调用只读`GET /providers/:id/impact`，成功后确认框展示账号数量和列表，确认后只调用一次DELETE；取消、预览失败、服务不存在或卸载均不写。删除完成显示实际removed及affectedAccounts结果；不把预览数据当成最终删除结果。

## 3. 验证

- `test/provider-management.test.ts`：6项，覆盖真实ProviderDto经真实后端parseProvider、复杂字段保留与复制隔离、模型名标记同步、origin换址规则、确认前只有GET、取消及生命周期失效零写、预览失败不删、实际删除结果。
- `test/provider-manager.test.tsx`：5项，运行实际组件回调/hook，覆盖dirty登记、在途冻结、失败保留、轮询不覆盖dirty基线、共享transition取消、stale阻止覆盖及重新读取、卸载后不DELETE、清密钥取消零写及保留新密钥草稿。
- 最终定向：2文件、11项通过。`npm run typecheck`与`git diff --check`通过。
- 最初两次sandbox定向执行因Vitest依赖`spy.js` realpath出现Windows EPERM，未采集到测试；获自动批准后在sandbox外运行定向测试通过。未将EPERM报告为业务测试失败或根因已修复。

以上为自动化领域/组件验证；未运行真实模型、QQ、付费请求或Electron实机交互，不宣称视觉、键盘或缩放验收完成。桌面构建和全量验收交由父代理统一执行。

## 4. 地址变更后的来源推断补充

父代理验收发现通用编辑沿用原location可能使地址更换后的云端媒体策略使用过期来源类型。编辑payload新增顶层`inferLocationFromUrl: true`，请求服务端复用现有`inferProviderLocation`重新推断；前端不复制地址识别逻辑，也不增加本地/云端选择。未带标志的旧API调用维持原语义。辅助函数测试新增标志断言，后端支持由父代理实现。
