import { createHash } from 'node:crypto';
import { messageText } from '../../../routing/message.js';
import type { ConversationRef } from '../../../routing/identity.js';
import type { MessageStore } from '../../../storage/contract.js';
import type { MemoryScope } from '../../../memory/types.js';

export const EXTRACTION_INPUT_LIMITS = {
  /** Per model call. */
  maxBatchMessages: 50,
  maxBatchChars: 24_000,
  /** Admission counting stops once this many eligible texts were observed. */
  maxAdmissionTexts: 50,
  /**
   * Upper bound for one build call. Batch construction stops at the character/count budget,
   * but admission counting may continue across non-text records up to this bound.
   */
  maxScanRecords: 10_000,
  pageRecords: 200
} as const;

export const EXTRACTION_PROMPT_VERSION = 'fact-extraction-v1';

export interface ExtractionInputMessage {
  seq: number;
  text: string;
  /** Preserved for group chats so a fact is not attributed to another member. */
  senderId?: string;
}

export interface ExtractionInputSkipped {
  outbound: number;
  otherEpoch: number;
  emptyText: number;
  overlong: number;
}

/**
 * Safe continuation of an under-threshold admission scan. The watermark has not advanced, so the
 * same batch prefix is reused while counting resumes after the last inspected record.
 */
export interface ExtractionScanResume {
  /** Exclusive lower bound for the continued scan: the last inspected seq. */
  afterSeq: number;
  messages: ExtractionInputMessage[];
  processedThroughSeq: number;
  eligibleTexts: number;
  /** Once a message does not fit, later eligible texts only count; the prefix stays fixed. */
  batchClosed: boolean;
}

export interface ExtractionInputBatch {
  messages: ExtractionInputMessage[];
  fromSeq?: number;
  throughSeq?: number;
  /**
   * Highest seq processed by this batch (not the admission count cursor unless every pending
   * record was inspected). Persist this as the extraction watermark after success.
   */
  processedThroughSeq: number;
  inspected: number;
  skipped: ExtractionInputSkipped;
  reachedTrigger: boolean;
  /**
   * Number of eligible unprocessed texts observed while scanning, capped at the requested
   * admission count. This may exceed `messages.length` when the character budget limits the batch.
   */
  eligibleTexts: number;
  /**
   * Present when fewer than `admissionTexts` eligible texts were found and a prefix was selected.
   * The caller may keep this in-process and pass it back as `resume` so a later trigger continues
   * after `afterSeq` instead of rescanning the inspected prefix.
   */
  scan?: {
    afterSeq: number;
    batchClosed: boolean;
  };
}

export interface BuildExtractionInputOptions {
  store: Pick<MessageStore, 'readRange'>;
  conversation: ConversationRef;
  scope: Pick<MemoryScope, 'contextEpoch'>;
  /** Exclusive lower bound: extraction.throughSeq. */
  afterSeq: number;
  /** Inclusive upper bound: the triggering turn's persisted inbound seq. */
  throughSeq: number;
  /** Minimum eligible texts required for admission; affects how far counting continues. */
  admissionTexts?: number;
  /** Record budget for one scan; defaults to the production bound. */
  scanLimit?: number;
  /** Continue a prior under-threshold scan without re-reading its already inspected prefix. */
  resume?: ExtractionScanResume;
}

/**
 * Reads only current-epoch inbound user text in ascending seq order. Batch construction stops at
 * the first message that does not fit the remaining count/character budget; admission counting then
 * continues across the scanned range so a few long messages can still satisfy the six-text gate.
 */
export async function buildExtractionInput(options: BuildExtractionInputOptions): Promise<ExtractionInputBatch> {
  const { store, conversation, scope, resume } = options;
  const triggerSeq = Math.max(options.afterSeq, options.throughSeq);
  const admissionTexts = Math.min(
    EXTRACTION_INPUT_LIMITS.maxAdmissionTexts,
    Math.max(1, Math.floor(options.admissionTexts ?? 6))
  );
  const scanLimit = Math.min(
    EXTRACTION_INPUT_LIMITS.maxScanRecords,
    Math.max(1, Math.floor(options.scanLimit ?? EXTRACTION_INPUT_LIMITS.maxScanRecords))
  );
  const skipped: ExtractionInputSkipped = { outbound: 0, otherEpoch: 0, emptyText: 0, overlong: 0 };
  const messages: ExtractionInputMessage[] = resume ? [...resume.messages] : [];
  let cursor = Math.max(0, options.afterSeq, resume?.afterSeq ?? 0);
  let processedThrough = Math.max(options.afterSeq, resume?.processedThroughSeq ?? Math.max(0, options.afterSeq));
  let inspected = 0;
  let chars = messages.reduce((sum, message) => sum + message.text.length, 0);
  let eligibleTexts = resume?.eligibleTexts ?? 0;
  let batchClosed = resume?.batchClosed ?? false;
  if (messages.length >= EXTRACTION_INPUT_LIMITS.maxBatchMessages || chars > EXTRACTION_INPUT_LIMITS.maxBatchChars) {
    batchClosed = true;
  }

  while (inspected < scanLimit && cursor < triggerSeq) {
    const page = await store.readRange(conversation, {
      afterSeq: cursor,
      throughSeq: triggerSeq,
      limit: Math.min(EXTRACTION_INPUT_LIMITS.pageRecords, scanLimit - inspected)
    });
    if (page.records.length === 0) {
      const next = page.exhausted ? triggerSeq : Math.max(cursor, page.scannedThroughSeq);
      // A store that reports no records and no forward progress must not trap the scan.
      if (next <= cursor) break;
      cursor = next;
      if (!batchClosed) processedThrough = cursor;
      break;
    }

    for (const record of page.records) {
      const seq = record.seq;
      if (seq === undefined || seq <= cursor) continue;
      cursor = seq;
      inspected += 1;
      if (record.direction !== 'in') {
        skipped.outbound += 1;
        if (!batchClosed) processedThrough = seq;
        continue;
      }
      if (record.contextEpoch !== scope.contextEpoch) {
        skipped.otherEpoch += 1;
        if (!batchClosed) processedThrough = seq;
        continue;
      }
      const text = messageText(record.segments).trim();
      if (!text) {
        skipped.emptyText += 1;
        if (!batchClosed) processedThrough = seq;
        continue;
      }
      if (text.length > EXTRACTION_INPUT_LIMITS.maxBatchChars) {
        // A single message can never fit a batch; skip it permanently instead of stalling forever.
        skipped.overlong += 1;
        if (!batchClosed) processedThrough = seq;
        continue;
      }

      if (eligibleTexts < admissionTexts) eligibleTexts += 1;
      if (!batchClosed) {
        if (messages.length >= EXTRACTION_INPUT_LIMITS.maxBatchMessages
          || chars + text.length > EXTRACTION_INPUT_LIMITS.maxBatchChars) {
          batchClosed = true;
        } else {
          messages.push({
            seq,
            text,
            ...(record.senderId ? { senderId: record.senderId } : {})
          });
          chars += text.length;
          processedThrough = seq;
          if (messages.length >= EXTRACTION_INPUT_LIMITS.maxBatchMessages) batchClosed = true;
        }
      }
      if (batchClosed && eligibleTexts >= admissionTexts) break;
    }

    if (batchClosed && eligibleTexts >= admissionTexts) break;
    // Exhaustion must win over the record bound: there is nothing left to resume.
    if (page.exhausted) {
      cursor = triggerSeq;
      if (!batchClosed) processedThrough = cursor;
      break;
    }
    if (inspected >= scanLimit) break;
  }

  // Under the admission threshold, keep a safe continuation point even when the trigger was
  // reached: a later trigger must inspect new records only, not re-walk the same prefix.
  const scan = eligibleTexts < admissionTexts && messages.length > 0
    ? { afterSeq: cursor, batchClosed }
    : undefined;
  return {
    messages,
    ...(messages.length > 0
      ? { fromSeq: messages[0]!.seq, throughSeq: messages[messages.length - 1]!.seq }
      : {}),
    processedThroughSeq: Math.max(options.afterSeq, processedThrough),
    inspected,
    skipped,
    reachedTrigger: cursor >= triggerSeq,
    eligibleTexts,
    ...(scan ? { scan } : {})
  };
}

export interface ExtractionSourceIdentity {
  scopeToken: string;
  /** Activation boundary; changing it must change the source identity. */
  activationBoundary: number;
  generation: number;
  /** Authorized provider/model plus output-parsing identity. */
  modelIdentity: string;
  promptVersion?: string;
}

/**
 * Deterministic identity for one model call's actual evidence. It never stores plaintext;
 * duplicate completion notifications in the same generation/model reproduce the same key.
 */
export function extractionSourceKey(batch: ExtractionInputBatch, identity: ExtractionSourceIdentity): string {
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  return digest(JSON.stringify([
    'memory-extraction-source-v1',
    identity.scopeToken,
    identity.activationBoundary,
    identity.generation,
    identity.promptVersion ?? EXTRACTION_PROMPT_VERSION,
    identity.modelIdentity,
    batch.processedThroughSeq,
    batch.messages.map(message => [message.seq, message.senderId ?? null, digest(message.text)])
  ]));
}
