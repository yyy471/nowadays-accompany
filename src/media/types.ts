import type { ConversationRef } from '../routing/identity.js';

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export interface MediaSource {
  conversation: ConversationRef;
  messageId?: string;
  jobId?: string;
  direction?: 'in' | 'out';
}

export interface MediaRef {
  mediaId: string;
  accountId: string;
  kind: MediaKind;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  retention: 'temporary' | 'account';
  source: MediaSource;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface MediaData {
  ref: MediaRef;
  data: Buffer;
}

export interface IngestInput {
  accountId: string;
  kind: MediaKind;
  mimeType: string;
  data: Buffer;
  source: MediaSource;
  retentionDays?: number;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface MediaCleanupResult {
  deleted: string[];
  skippedInUse: string[];
  failed: Array<{ mediaId: string; error: string }>;
}
