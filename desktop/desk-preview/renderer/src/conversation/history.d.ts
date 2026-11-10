/** 与历史检索纯逻辑对应的类型声明。 */
export interface PerfRow {
  id: number;
  messageId: string;
  segmentId: string;
  ordinal: number;
  role: 'user' | 'assistant';
  text: string;
  action: string;
  actionVisible: boolean;
  sprite: string | null;
  outfitId?: string | null;
  status: 'completed' | 'interrupted' | 'failed';
  createdAt: number;
}

export interface DaySummary {
  key: string;
  count: number;
  ids: number[];
  rounds: Set<string>;
}

export interface SnippetCard {
  targetId: number;
  key: string;
  lines: Array<PerfRow & { main: boolean }>;
}

export function dayKey(value: number | string | Date): string;
export function keyToDate(key: string): Date;
export function dateLabel(key: string): string;
export function termsFor(query: string): string[];
export function textFor(row: PerfRow): string;
export function rangesFor(text: string, query: string): Array<[number, number]>;
export function snippet(text: string, query: string, max?: number): string;
export function findHits(rows: PerfRow[], query: string): PerfRow[];
export function buildDays(rows: PerfRow[]): DaySummary[];
export function calendarDays(first: string, last: string): string[];
export function dotTier(count: number): 1 | 2 | 3;
export function daySnippets(rows: PerfRow[], key: string, query: string): SnippetCard[];
