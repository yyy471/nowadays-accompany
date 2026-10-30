# 160独立复验证据

2026-10-30。当前工作树源码；Windows、Node 20.19.4、Vite真实App、Chromium headless、1440×900、白昼、内存HTTP夹具；无真实模型/QQ或正常业务配置改动。

- `browser-id-review.json`：五种服务id完整简易保存/高级保存/清密钥/删除 + constructor来源变化，共六组通过。
- `coordinator-recheck.json`：七种id的空闲、自有键、意图先到先持有、在途独占、错误owner不能释放、释放移交、不同服务独立与再次准入，均通过。
- `browser-review.json`：本次重跑原六组故障场景，均通过。
- `browser-delete-review.json`：本次重跑八组删除与恢复场景，均通过。
- `prototype-id-source-change.png`：constructor来源采用与保存后的实际页面。
- `legal-id-constructor.png`、`legal-id-toString.png`：完整操作链结束、删除服务后的实际页面；初始可用及请求记录以JSON为准。
- `delete-pending-converted.png`、`shared-provider-after.png`：删除后转换保存、并发协调保存后的实际页面；时序以对应JSON为准。
- `typecheck.log`、`tests.log`、`build.log`、`tokens.log`：本次独立门控日志。全量首轮132文件1248项通过/1项既有跳过。
- `source-snapshot.json`：本次源码与相关测试SHA-256。

脚本在仓库`test-results/model-config-id-independent/`。真实Core合法id的既有证据见158，本轮未重复Core重放；不将内存HTTP夹具的保存成功当作真实模型/凭据库可用。结论与范围见[160复验记录](../../../../160-model-config-prototype-id-independent-recheck.md)。
