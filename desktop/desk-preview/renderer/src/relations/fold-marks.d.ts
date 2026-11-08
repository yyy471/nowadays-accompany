export interface Box { left: number; top: number; width: number; height: number }
export interface FoldMark { index: number; lineX: number; lineY: number; lineW: number; tickX: number; tickY: number; tickH: number }
export function buildFoldMarks(leaf: Box, strip: Box | null | undefined, count?: number): FoldMark[];
