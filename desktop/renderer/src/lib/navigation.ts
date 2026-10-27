import type { IconName } from '../ui';

export interface PageDef { id: string; label: string; icon: IconName; title: string; subtitle: string }
export const PAGES: PageDef[] = [
  { id: 'home', label: '主页', icon: 'user', title: '主页', subtitle: '把日常，写成喜欢的样子' },
  { id: 'overview', label: '总览', icon: 'overview', title: '总览', subtitle: '查看运行摘要；连接操作在“实例与监听”完成' },
  { id: 'instances', label: '实例与监听', icon: 'slots', title: '实例与监听', subtitle: '检测 QQ 状态；由你明确点击注入与监听' },
  { id: 'roles', label: '资料与角色', icon: 'accounts', title: '资料与角色', subtitle: '按账号维护展示资料，并为私聊或群聊绑定角色卡' },
  { id: 'plugins', label: '插件与Skill', icon: 'package', title: '插件与Skill', subtitle: '按账号管理插件、工具授权与 Skill 的生效范围' },
  { id: 'model-config', label: '模型配置', icon: 'shield', title: '模型配置', subtitle: '按账号配置五类模型服务与能力' },
  { id: 'diagnostics', label: '事件诊断', icon: 'activity', title: '事件诊断', subtitle: '检查本次运行的实例与通道事件' },
  { id: 'artifacts', label: '资源库', icon: 'artifacts', title: '资源库', subtitle: '管理角色卡、插件与公用 Skill 资源、版本和部署' }
];
export const ALL_PAGES = [...PAGES.slice(0,7), { id: 'settings', label: '应用设置', icon: 'settings' as const, title: '应用设置', subtitle: '' }, PAGES[7]!];
