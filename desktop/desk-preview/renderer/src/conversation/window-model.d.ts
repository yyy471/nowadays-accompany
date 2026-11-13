import type { MessageView, SceneTaskView, SegmentView } from './api-types';
import type { PerfRow } from './history.js';
import type { PerfScene } from './performance.js';

export interface RowIdRegistry {
  id(anchor: string): number;
}

export function createRowIdRegistry(): RowIdRegistry;
export function messageStatusOf(terminal: string | null): 'completed' | 'interrupted';
export function rowsForMessage(message: MessageView, segments: SegmentView[], idFor: (anchor: string) => number): PerfRow[];
export function mergeSegments(existing: SegmentView[], incoming: SegmentView[]): SegmentView[];
export function reconcileFinalSegments(existing: SegmentView[], incoming: SegmentView[], shown: number): { segments: SegmentView[]; shown: number };
export function newerSceneTask(previous: SceneTaskView | undefined, incoming: SceneTaskView): SceneTaskView;
export function applySegmentAnnotations(
  segments: SegmentView[],
  items: Array<{ segmentId: string; outfitId?: string | null; homeAssetId?: string | null; spriteAssetId?: string | null }>,
  now?: string
): SegmentView[];
export function sceneView(task: SceneTaskView, segmentsByMessage: Map<string, SegmentView[]>, roleId: string): PerfScene;
export function groupSegments(segments: SegmentView[]): Map<string, SegmentView[]>;
export function isSubmissionConfirmed(
  record: { submissionId: string } | null | undefined,
  messages: readonly MessageView[]
): boolean;
export function shouldClearRecoveredDraft(
  record: { value: string; edited: boolean } | null | undefined,
  confirmedContent: string
): boolean;
export function parseTime(value: string | number): number;
export function lastRowOf(rows: PerfRow[]): PerfRow | null;
export function spriteForRow(rows: PerfRow[], current: PerfRow | null): string | null;
export function sceneAssetUrl(roleId: string, assetId: string): string;
