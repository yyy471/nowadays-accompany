# 158独立复验证据

2026-10-30。当前工作树；Vite真实App、Chromium headless、1440×900、内存HTTP业务夹具；昼夜分别检查影响读取/确认取消，其他场景以白昼为主。未调用真实QQ/模型或读写正常业务配置。

- `browser-review.json`：本次重跑原六组场景，均通过。
- `browser-delete-review.json`：本次重跑157八组修复场景，均通过。
- `extra-fixed.json`：本次另写七组交错，包含影响读取/确认等待、取消/失败、刷新持锁与失败释放、不同服务独立；均通过。
- `ids.json`：普通id、constructor、toString实际页面对照；后两者误锁。`errors:[]`表示探针运行正常，不能当作产品通过。
- `id-core.json`：真实Core接受三个id；空协调器对同名继承属性误判。隔离临时目录已清理。
- `delete-pending-converted.png`、`clear-key-pending.png`：修复后的实际页面；步骤/时序以JSON为准。
- `cancel-nightwave.png`：晚风主题确认取消后草稿保留，保存恢复可用。
- `legal-id-*.png`：三个id的误锁对照，页面未启动其他编辑或写入；页面可能滚至高级管理位置。
- `typecheck.log`、`build.log`、`tokens.log`：本次独立通过日志。
- `tests.log`：首轮全量存在1项插件组合等待超时；`failed-file-rerun.log`单文件20项通过；`tests-rerun.log`最终全量132文件1244项通过/1跳过。原失败保留，不等同稳定复现的前端缺陷。
- `source-snapshot.json`：本次源码与相关测试SHA-256。

临时探针在仓库`test-results/model-config-final-recheck/`；端口冲突及模态背景定位问题已经校正，产品结论采用校正后运行。详见[158复验记录](../../../../158-model-config-delete-fixes-independent-recheck.md)。
