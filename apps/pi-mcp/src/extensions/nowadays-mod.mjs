export const toolScopeContract = '主角色可先用 app_roles_list 查询普通角色的 roleId，再在工具注册中声明 scope: "selected_roles", roleIds: ["<roleId>"]。名单内普通角色与主角色可用，空名单仅主角色可用，主角色验收使用自己的 roleId。';
export const uiActionContract = "api.ui.onAction(name, handler) 登记本扩展的精确动作，handler(payload) 返回 JSON。ui[].coplay 可声明最多 4 个 {action,label}（label 最长 32 字）；用户点击宿主按钮时 handler(null) 可返回 {data,summary?}，子页接收 {type:'ext:coplay-result',action,ok,data?,error?} 刷新画面。只有宿主点击且有非空 summary 才邀请选中的角色回应。微页内 ext:action 和定时器只更新游戏，绝不唤醒角色；注销函数与 ctx.effect 生命周期绑定。沙箱 HTML 向 parent.postMessage({type:'ext:action',id,action,payload},'*') 发一次请求。id 为 1–64 位字母、数字、点、横线或下划线，action 同字符集且以字母开头，payload 为至多 16 KiB 的 UTF-8 JSON，无参数传 null。子页只接收 event.source === parent 的消息。按 id 匹配 {type:'host:action-result',id,ok:true,data} 或 {type:'host:action-result',id,ok:false,error}（error 为英文错误码），有副作用的动作勿自动重试。发送 ext:ready 请求 host:theme，将 tokens 中的 --nd-semantic-* 写入 document.documentElement.style。";

const counterExample = `最小计数器：manifest.json 写 {"version":"v1","entry":"entry.mjs","ui":[{"slot":"page","file":"ui/count.html"}]}。
entry.mjs:
export default (_, api) => {
  api.ui.onAction('increment', async () => {
    const count = (await api.kv.get('count') ?? 0) + 1;
    await api.kv.set('count', count);
    return count;
  });
}
ui/count.html:
<button id="counter">+1</button><output></output><script>
const button = document.querySelector('button'), output = document.querySelector('output');
let pending;
button.onclick = () => {
  button.disabled = true;
  pending = String(performance.now());
  parent.postMessage({type:'ext:action', id:pending, action:'increment', payload:null}, '*');
};
onmessage = e => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m?.type === 'host:theme') {
    for (const [k,v] of Object.entries(m.tokens)) if (k.startsWith('--nd-semantic-')) document.documentElement.style.setProperty(k,v);
    button.style.color = 'var(--nd-semantic-color-text)';
  }
  if (m?.type === 'host:action-result' && m.id === pending) {
    output.textContent = m.ok ? m.data : m.error;
    pending = undefined;
    button.disabled = false;
  }
};
parent.postMessage({type:'ext:ready'}, '*');
</script>`;

export default function nowadaysMod(pi) {
  pi.on("before_agent_start", event => ({
    systemPrompt: [event.systemPrompt, "Nowadays Mod 工程规范：仅在当前 extensions-work 草稿目录开发与运行本地测试。manifest.json 含 version、entry、ui。Cordis 入口 export default async (ctx, api) => {}，使用 api.tools.register({name,description,inputSchema,scope}, fn)，scope 可选 admin_only、all_roles 或 selected_roles。UI 使用 page/widget/overlay 的 ui/ HTML 和 asset 静态文件槽位。先运行测试，读取失败输出、局部修改并复测。向委派角色报告结果，由主角色决定热发布。", toolScopeContract, uiActionContract, counterExample].join("\n"),
  }));
}
