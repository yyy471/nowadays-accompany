import type { CapabilityId, VisionMode } from '../types.js';

export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  chat: '文字对话',
  'image.understand': '图片理解',
  'video.understand': '视频理解',
  'image.generate': '图片生成',
  'audio.generate': '语音生成'
};

export const VISION_MODE_LABELS: Record<VisionMode, string> = {
  external: '外部识图',
  direct: '直接视觉'
};

export const CANCEL_MODE_LABELS: Record<string, string> = {
  remote: '远端取消',
  localOnly: '仅本地停止',
  none: '不可取消'
};

export const DEPLOYMENT_ACTION_LABELS: Record<string, string> = {
  deploy: '部署',
  rollback: '回滚'
};

export function capabilityLabel(value: string): string {
  return CAPABILITY_LABELS[value as CapabilityId] ?? value;
}

export function visionModeLabel(value: string | undefined): string {
  return value ? VISION_MODE_LABELS[value as VisionMode] ?? value : '外部识图';
}

export function cancelModeLabel(value: string): string {
  return CANCEL_MODE_LABELS[value] ?? value;
}

export function deploymentActionLabel(value: string): string {
  return DEPLOYMENT_ACTION_LABELS[value] ?? value;
}

export const EXTENSION_ISSUE_LABELS: Record<string, string> = {
  plugin_switch_off: '插件运行开关关闭',
  switch_off: '会话开关关闭',
  unauthorized: '工具未授权',
  handler_not_ready: '插件未就绪',
  capability_unavailable: '模型能力不可用',
  requires_unavailable: '所需能力不可用',
  skill_tool_unavailable: '引用工具不可用',
  kind_scope: '仅限指定会话类型',
  peer_scope: '仅限指定对象'
};

export function extensionIssueLabel(code: string, detail?: string): string {
  const label = EXTENSION_ISSUE_LABELS[code] ?? code;
  return detail ? `${label}（${detail}）` : label;
}

export const SKILL_SELECTION_REASON_LABELS: Record<string, string> = {
  name_too_long: '名称超长',
  instructions_too_long: '说明超长',
  too_many_tools: '引用工具过多',
  skill_limit: '超出单次注入数量',
  instructions_budget: '超出说明总预算'
};

export function skillSelectionReasonLabel(value: string): string {
  return SKILL_SELECTION_REASON_LABELS[value] ?? value;
}
