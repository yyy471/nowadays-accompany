/** 桌面对话页使用的后端读取契约（与 backend/src/domain、storage 的返回形状一致）。 */

export interface WindowView {
  windowId: string;
  roleId: string;
  kind: 'main' | 'custom';
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageView {
  messageId: string;
  windowId: string;
  sender: 'user' | 'assistant';
  content: string;
  sourcePlatform: string;
  status: string;
  sequence: number;
  submissionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentView {
  segmentId: string;
  messageId: string;
  windowId: string;
  ordinal: number;
  kind: 'speech' | 'narration';
  text: string;
  startOffset: number;
  endOffset: number;
  outfitId: string | null;
  spriteAssetId: string | null;
  annotatedAt: string | null;
  createdAt: string;
}

export type SceneTaskStatus = 'queued' | 'planning' | 'generating' | 'succeeded' | 'skipped' | 'failed';
export type SceneLayerMode = 'background' | 'full_scene';

export interface ScenePlanView {
  description: string;
  layerMode: SceneLayerMode;
  startSegmentId: string;
  endSegmentId: string;
}

export interface SceneResultView {
  assetId: string;
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
  createdAt: string;
}

export interface SceneTaskView {
  taskId: string;
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
  trigger: 'manual' | 'auto';
  layerMode: SceneLayerMode;
  startSegmentId: string;
  endSegmentId: string;
  status: SceneTaskStatus;
  attempt: number;
  plan: ScenePlanView | null;
  errorCode: string | null;
  errorSummary: string | null;
  result: SceneResultView | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessagePageView {
  items: MessageView[];
  nextAfter: number | null;
  nextBefore: number | null;
  segments: SegmentView[];
  activeReply: { messageId: string; executionId: string; text: string } | null;
  cursor: number;
  sceneImages?: SceneTaskView[];
}

export interface MessageDetailView {
  message: MessageView;
  segments: SegmentView[];
  sceneImages?: SceneTaskView[];
}

export interface SubmitMessageView {
  message: MessageView;
  duplicate: boolean;
}

export interface WindowsResponse { items: WindowView[]; }

export interface VoiceConfigView {
  engine: string;
  protocol: string;
  baseUrl: string;
  voiceSource: Record<string, unknown>;
  reference: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  language: string;
  speed: number;
  emoAlpha: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceResponse { voice: VoiceConfigView | null; }

/** SSE 事件：payload 字段平铺在顶层。 */
export interface StreamEventView {
  streamEventId: number;
  type: string;
  [key: string]: unknown;
}
