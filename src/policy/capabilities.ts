export const CAPABILITY_IDS = ['chat', 'image.understand', 'video.understand', 'image.generate', 'audio.generate'] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const CAPABILITY_LABELS: Record<CapabilityId, string> = {
  chat: '对话',
  'image.understand': '图片理解',
  'video.understand': '视频理解',
  'image.generate': '图片生成',
  'audio.generate': '语音生成'
};

export const CAPABILITY_DESCRIPTIONS: Record<CapabilityId, string> = {
  chat: '规范化上下文 → 文本或受支持的工具调用',
  'image.understand': '图片引用 + 问题 → 观察文本',
  'video.understand': '视频引用 + 问题 → 摘要或时间片',
  'image.generate': '提示词 → 一个或多个图片制品',
  'audio.generate': '文本 → 可交付语音制品'
};

const CAPABILITY_SET = new Set<string>(CAPABILITY_IDS);

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

export function assertCapabilityId(value: unknown, label = 'capability'): CapabilityId {
  if (!isCapabilityId(value)) {
    throw new Error(`${label} must be one of ${CAPABILITY_IDS.join(', ')}`);
  }
  return value;
}
