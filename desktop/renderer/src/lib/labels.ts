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
