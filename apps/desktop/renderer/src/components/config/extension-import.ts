import { ApiError } from '../../api';

export interface McpDraft {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  description: string;
}

export const COMMAND_MCP_RISK = '高风险：以当前用户权限执行本机命令，可访问工作空间外的文件';

export function isCommandMcp(config: Record<string, unknown>): boolean {
  const command = typeof config.command === 'string' ? config.command.replace(/^['"]|['"]$/g, '') : '';
  const args = Array.isArray(config.args) && config.args.every(arg => typeof arg === 'string') ? config.args as string[] : [];
  const leaf = command.split(/[\\/]/).at(-1)?.toLowerCase();
  if (/^npm(?:\.cmd|\.exe)?$/.test(leaf ?? '')) {
    const run = args.findIndex(arg => arg === 'run' || arg === 'run-script');
    const script = args[run + 1];
    if (run >= 0 && script === 'mcp:local:command') return true;
    if (run >= 0 && script === 'mcp:local' && args[run + 2] === '--' && args[run + 3] === '--mode' && args[run + 4] === 'command') return true;
  }
  const script = [command, ...args].some(arg => /(?:^|[\\/])src[\\/]mcp[\\/]local-server\.(?:js|ts)$/i.test(arg.replace(/^['"]|['"]$/g, '')) || /^\.?[\\/]?local-server\.(?:js|ts)$/i.test(arg.replace(/^['"]|['"]$/g, '')));
  return script && args.some((arg, i) => arg === '--mode' && args[i + 1] === 'command');
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

export function mcpSummary(server: string, command: string, args: string[], env: Record<string,string> | null) {
  const leaf = command.trim().replace(/^["']|["']$/g, '').split(/[\\/]/).at(-1) ?? '';
  const safeName = /^[\p{L}\p{N}_.+-]+(?: [\p{L}\p{N}_.+-]+)*$/u.test(leaf) ? leaf : '本地命令';
  const missing = Object.entries(env ?? {}).filter(([, value]) => !value.trim() || /<[^>]+>|\$\{[^}]+\}|your[_-]/i.test(value)).map(([key]) => key);
  return [server, safeName, `${args.length} 个参数`, ...(missing.length ? ['待补 ' + missing.join('、')] : [])].join(' · ');
}

export function skillIssue(reason: unknown) {
  if (!(reason instanceof ApiError)) return;
  if (reason.status === 400 && reason.code === 'SKILL_DIRECTORY_EMPTY') return { role: 'status' as const, text: '这个目录里还没有 Skill，可以换个目录再识别。' };
  if (reason.status === 400 && reason.code === 'SKILL_DIRECTORY_UNREADABLE') return { role: 'alert' as const, text: '目录无法读取，请检查路径与读取权限后再识别。' };
  if (reason.status === 409 && reason.code === 'SKILL_DIRECTORY_CHANGED') return { role: 'alert' as const, text: '目录内容已变更，请重新识别并选择技能。' };
}
