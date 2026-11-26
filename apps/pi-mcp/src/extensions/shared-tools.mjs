const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };

export default async function sharedTools(pi, job) {
  if (!job?.sharedTools) return;
  const base = new URL("../tool-proxy/", job.baseUrl + "/");
  async function post(route, payload, signal) {
    const response = await fetch(new URL(route, base), { method: "POST", redirect: "error", signal,
      headers: { authorization: "Bearer " + job.lease, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.code ?? "PI_TOOL_PROXY_FAILED");
    return data;
  }
  function register(name, description, parameters, route, payload) {
    pi.registerTool({ name, label: name, description, parameters,
      async execute(_callId, args, signal) {
        const data = await post(route, payload(args), signal);
        const text = JSON.stringify(data);
        if (data.status === "unknown" || data.status === "failed") throw new Error(text);
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
  if (job.skills.length) {
    pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\n可用 Skill（按 id 读取）：\n" + JSON.stringify(job.skills) }));
    register("skill_read", "按 id 读取 SKILL.md 或包内相对路径文件。", object({ id: string, path: string }, ["id"]), "skill/read", args => args);
    register("skill_run", "按 id 在工程工作区执行随包 JS 脚本。", object({ id: string, path: string, args: { type: "array", items: string } }, ["id", "path"]), "skill/run", args => args);
  }
  const { tools } = await post("list", {});
  for (const tool of tools) register(tool.name, tool.description, tool.inputSchema, "call", args => ({ name: tool.name, arguments: args }));
}
