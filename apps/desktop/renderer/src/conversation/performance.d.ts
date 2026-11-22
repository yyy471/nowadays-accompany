import type { PerfRow } from './history.js';

export type SceneLayerMode = 'background' | 'full_scene';
export type SceneStatus = 'generating' | 'succeeded' | 'failed';

export interface PerfScene {
  id: string;
  messageId: string;
  mode: SceneLayerMode;
  start: number;
  end: number;
  startSegmentId: string;
  endSegmentId: string;
  status: SceneStatus;
  source: 'manual' | 'auto';
  /** 真实后端任务的原始状态；演示引擎不填。 */
  taskStatus?: string;
  errorCode?: string | null;
  errorSummary?: string | null;
  assetId?: string | null;
  assetUrl?: string | null;
}

export type PerformanceEventReason = 'initial' | 'send' | 'ready' | 'failed' | 'segment' | 'scene';

export interface PerformanceEvent {
  reason: PerformanceEventReason;
  id?: number;
  row?: PerfRow;
}

export interface PerformanceSnapshot {
  messages: PerfRow[];
  activeId: string | null;
  canAdvance: boolean;
  current: PerfRow | null;
  error: string;
  scenes: PerfScene[];
  availableRounds: Set<string>;
  /** 当前回复后续已就绪、等待推进的句段（真实接入层提供，演示引擎为空）。 */
  upcoming?: PerfRow[];
  /** 已发送但尚无任何可展示句段。 */
  awaiting?: boolean;
}

export interface PerformanceEngine {
  snapshot(): PerformanceSnapshot;
  send(value: string): boolean;
  advance(): boolean;
  requestScene(messageId: string, mode?: SceneLayerMode, source?: 'manual' | 'auto'): boolean;
  autoScene: boolean;
  dispose(): void;
}

export class ConversationPerformance implements PerformanceEngine {
  autoScene: boolean;
  constructor(options: {
    scenario?: string | null;
    onChange?: (snapshot: PerformanceSnapshot, event: PerformanceEvent) => void;
    clock?: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'>;
  });
  snapshot(): PerformanceSnapshot;
  send(value: string): boolean;
  advance(): boolean;
  requestScene(messageId: string, mode?: SceneLayerMode, source?: 'manual' | 'auto'): boolean;
  dispose(): void;
}
