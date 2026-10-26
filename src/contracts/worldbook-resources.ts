import type { Worldbook } from '../worldbook/types.js';
export interface WorldbookManifest {
  id: string; kind: 'worldbook'; revision: string; name?: string; description?: string; worldbook: Worldbook;
}
export interface WorldbookResourceDetail {
  manifest: WorldbookManifest;
  fingerprint: string;
  baseRef?: { id: string; revision: string };
}
export interface WorldbookSummary {
  id: string; revision: string; name?: string; entryCount: number; enabledEntryCount: number; fingerprint: string;
}
export interface WorldbookList { items: WorldbookSummary[]; nextOffset?: number }
export interface WorldbookSaveResult extends WorldbookResourceDetail { created: boolean }
export interface WorldbookFilePreview {
  manifest: WorldbookManifest; fingerprint: string; bytes: number; warnings: string[]; sourceFormat: string;
}
