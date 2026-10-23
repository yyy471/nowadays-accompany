import type { ConversationRef } from '../routing/identity.js';
import type { CapabilityId } from '../policy/capabilities.js';
import type { CancelMode } from '../providers/types.js';
import type { MediaRef } from '../media/types.js';

export type JobState = 'queued' | 'running' | 'waiting_remote' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export const JOB_STATES: JobState[] = [
  'queued',
  'running',
  'waiting_remote',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted'
];

export interface JobFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JobResult {
  text?: string;
  media?: MediaRef[];
  observation?: unknown;
}

export interface MediaJob {
  id: string;
  accountId: string;
  conversation: ConversationRef;
  capability: CapabilityId;
  originMessageId?: string;
  turnId: string;
  sessionEpoch: number;
  providerId?: string;
  modelId?: string;
  state: JobState;
  actionId?: string;
  cancelMode: CancelMode;
  cancelRequested: boolean;
  remoteCancelled: boolean;
  delivery: 'pending' | 'sent' | 'failed' | 'skipped';
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: JobFailure;
  result?: JobResult;
  note?: string;
}

export interface JobDto extends Omit<MediaJob, 'conversation'> {
  conversation: ConversationRef;
}

export interface JobExecutionContext {
  jobId: string;
  signal: AbortSignal;
  setWaitingRemote(): Promise<void>;
  setProvider(providerId: string, modelId: string): Promise<void>;
  markRemoteCancelled(): void;
}

export type JobExecution = (context: JobExecutionContext) => Promise<JobResult>;

export interface JobSubmitInput {
  accountId: string;
  conversation: ConversationRef;
  capability: CapabilityId;
  turnId: string;
  sessionEpoch: number;
  cancelMode: CancelMode;
  executor: JobExecution;
  signal?: AbortSignal;
  actionId?: string;
  originMessageId?: string;
  providerId?: string;
  modelId?: string;
  onComplete?: (job: MediaJob) => void | Promise<void>;
}

export type JobUpdateListener = (job: MediaJob) => void;
