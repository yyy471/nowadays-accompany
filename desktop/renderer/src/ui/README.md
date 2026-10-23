# nowadays UI 组件库

所有业务页面统一从 `../ui` 导入；应用根目录使用 `./ui`。`src/ui.tsx` 是稳定入口，`ui/index.ts` 为导出目录。基础控件仅允许在此目录内部创建原生DOM。

| 用途 | 组件 |
| --- | --- |
| 普通文字、密码、数字、模型名及文件输入 | Input（保留原生属性与ref） |
| 搜索与文本过滤 | SearchInput（必须传label，内置图标与搜索样式） |
| 下拉、文本域、勾选 | Select / Textarea / Checkbox |
| 标签与说明 | Field（自动关联label、控件及hint） |
| 普通操作、保存确认、取消返回 | Button / ConfirmButton / CancelButton |
| 仅图标按钮 | IconButton（必须传icon和label） |
| 导航、Dock、折叠行、步骤切换 | ControlButton（布局由对应场景定义） |
| 设置及其他弹窗 | Modal |
| 二次确认 | useConfirm，由根ConfirmProvider提供 |

确认默认主按钮，取消默认次按钮，危险动作使用 `tone:'danger'` 的确认请求及danger按钮变体。按操作语义命名按钮；不要在页面手工写 `btn-*`、`search-box` 或 `icon-btn`。ControlButton不能用来绕过Button手拼普通操作按钮。

```tsx
import { Field, Input, SearchInput, ConfirmButton, CancelButton, useConfirm } from '../ui';

const confirm = useConfirm();
const accepted = await confirm({
  title: '放弃修改？', description: '未保存内容会丢失。',
  confirmLabel: '放弃修改', cancelLabel: '继续编辑', tone: 'danger'
});
if (!accepted) return;
```

`theme.css`集中控制尺寸、圆角、边框、颜色、焦点、禁用和确认弹窗外观；页面CSS仅负责排列、宽度和场景布局。避免追加另一套外观覆盖已有控件。

Modal统一处理背景隔离、最上层Escape、Tab约束、嵌套弹窗与焦点恢复。确认初始焦点位于取消按钮，点击遮罩/关闭/Escape均作为取消。确认返回Promise，必须等待结果并保留取消分支；异步等待后应复验账号、进程等操作目标是否仍有效。

`test/ui-library-contract.test.ts`使用TypeScript语法树检查页面原生控件、系统对话框和手拼样式，阻止新增重复实现。迁移范围包括当前入口和历史页面，历史页面不会因此重新加入导航。
