import { InvalidSpecError } from './errors.js';

export interface Limits {
  maxInstances: number;
  maxIngressQueue: number;
  maxConversationQueue: number;
  maxMessageBytes: number;
  maxSseClients: number;
  maxConcurrentActions: number;
  sendRatePerSecond: number;
  sendBurst: number;
  startConcurrency: number;
  restartConcurrency: number;
  healthCheckIntervalMs: number;
  unhealthyThreshold: number;
  shutdownTimeoutMs: number;
  drainTimeoutMs: number;
  hostDrainTimeoutMs: number;
  hostTimeoutMs: number;
  pluginTimeoutMs: number;
  maxHostHistory: number;
  /** 对话 turn 的全局/账号并发上限；同会话仍由会话链串行。 */
  maxChatConcurrency: number;
  maxAccountChatConcurrency: number;
  maxChatPending: number;
  /** 媒体任务与对话队列分开，避免视频等待占满文字对话资源。 */
  maxMediaConcurrentJobs: number;
  maxAccountMediaConcurrentJobs: number;
  maxMediaJobPending: number;
  maxPerAccountMediaJobPending: number;
  mediaJobTimeoutMs: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  mediaDownloadTimeoutMs: number;
  mediaRetentionDays: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxInstances: 32,
  maxIngressQueue: 1_000,
  maxConversationQueue: 100,
  maxMessageBytes: 256 * 1024,
  maxSseClients: 32,
  maxConcurrentActions: 8,
  sendRatePerSecond: 10,
  sendBurst: 20,
  startConcurrency: 4,
  restartConcurrency: 2,
  healthCheckIntervalMs: 5_000,
  unhealthyThreshold: 2,
  shutdownTimeoutMs: 10_000,
  drainTimeoutMs: 5_000,
  hostDrainTimeoutMs: 30_000,
  hostTimeoutMs: 120_000,
  pluginTimeoutMs: 30_000,
  maxHostHistory: 50,
  maxChatConcurrency: 4,
  maxAccountChatConcurrency: 2,
  maxChatPending: 64,
  maxMediaConcurrentJobs: 4,
  maxAccountMediaConcurrentJobs: 1,
  maxMediaJobPending: 64,
  maxPerAccountMediaJobPending: 8,
  mediaJobTimeoutMs: 300_000,
  maxImageBytes: 8 * 1024 * 1024,
  maxVideoBytes: 32 * 1024 * 1024,
  mediaDownloadTimeoutMs: 15_000,
  mediaRetentionDays: 7
};

export function normalizeLimits(patch: Partial<Limits> | undefined): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS, ...(patch ?? {}) };
  for (const [key, value] of Object.entries(limits) as Array<[keyof Limits, number]>) {
    if (!Number.isFinite(value) || value < 0 || (key !== 'healthCheckIntervalMs' && value === 0)) {

      throw new InvalidSpecError(`limit ${key} must be a positive number (got ${String(value)})`);
    }
    if (!Number.isInteger(value)) throw new InvalidSpecError(`limit ${key} must be an integer (got ${String(value)})`);
  }
  return limits;
}
