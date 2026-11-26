export interface McpDraft {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  description: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseMcpImport(raw: string): McpDraft[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error('请粘贴完整的 MCP JSON 配置。'); }
  if (!record(data)) throw new Error('需要包含 mcpServers 或 command 的配置对象。');
  const servers = 'mcpServers' in data ? data.mcpServers : { [String(data.name ?? '本地工具')]: data };
  if (!record(servers) || !Object.keys(servers).length) throw new Error('配置中没有找到 MCP 服务。');
  return Object.entries(servers).map(([name, config]) => {
    if (!record(config)) throw new Error(`${name} 的服务配置无效。`);
    if ('url' in config || (config.type && config.type !== 'stdio')) throw new Error(`${name} 使用远程连接，当前支持本地 stdio 服务。`);
    const unsupported = Object.keys(config).filter(key => !['type','name','description','command','args','env'].includes(key));
    if (unsupported.length) throw new Error(`${name} 含暂不支持的字段：${unsupported.join('、')}。`);
    if (typeof config.command !== 'string' || !config.command.trim()) throw new Error(`${name} 缺少启动命令 command。`);
    const args = config.args === undefined ? [] : config.args;
    const env = config.env === undefined ? {} : config.env;
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error(`${name} 的 args 应是字符串数组。`);
    if (!record(env) || !Object.values(env).every(value => typeof value === 'string')) throw new Error(`${name} 的 env 应是键值均为文本的对象。`);
    return { name, command: config.command.trim(), args, env: env as Record<string,string>, description: typeof config.description === 'string' ? config.description : '' };
  });
}

export function personalArgument(value: string) {
  return /(?:[A-Za-z]:[\\/]|^[/~]|<[^>]+>|\$\{[^}]+\}|your[_-]|path[/\\]to[/\\])/i.test(value);
}
