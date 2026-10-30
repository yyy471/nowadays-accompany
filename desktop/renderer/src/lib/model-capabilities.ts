import type { CapabilityId } from '../types';

export type ModelCapabilityRow = { id: CapabilityId; title: string; description: string; primary?: boolean };
export type ServiceStatus = { tone: 'ok' | 'warn' | 'idle' | 'bad'; label: string; summary: string };
export type ServiceStatusMap = Partial<Record<CapabilityId, ServiceStatus>>;

export const MODEL_CAPABILITY_ROWS: ModelCapabilityRow[] = [
  { id: 'chat', title: '文本模型', description: '负责普通对话回复，也承接工具调用后的续答。', primary: true },
  { id: 'image.understand', title: '视觉模型', description: '理解图片附件；不会要求文本模型支持图像输入。', primary: true },
  { id: 'video.understand', title: '视频模型', description: '分析视频附件或短片段。', primary: true },
  { id: 'image.generate', title: '图片生成', description: '作为可授权的对话工具按需调用。' },
  { id: 'audio.generate', title: '语音生成', description: '作为可授权的对话工具按需调用。' }
];
