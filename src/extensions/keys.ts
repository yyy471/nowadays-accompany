import type { PluginSource } from './contracts.js';

/** 无 Node 依赖的插件身份拼接，供服务端和渲染层生效预览共同使用。 */
export function pluginKey(source: PluginSource, pluginId: string): string {
  return `${source}/plugin/${pluginId}`;
}
