export default function nowadaysMod(pi) {
  pi.on("before_agent_start", event => ({
    systemPrompt: event.systemPrompt + "\nNowadays Mod 工程规范：仅在当前 extensions-work 草稿目录开发与运行本地测试。manifest.json 含 version、entry、ui。Cordis 入口 export default async (ctx, api) => {}，使用 api.tools.register({name,description,inputSchema,scope}, fn)，scope 为 admin_only 或 all_roles。UI 使用 page/widget/overlay 的 ui/ HTML 和 asset 静态文件槽位。先运行测试，读取失败输出、局部修改并复测。向委派角色报告结果，由主角色决定热发布。",
  }));
}
