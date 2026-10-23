import crypto from 'node:crypto';
import type { Logger } from '../core/logger.js';
import { Semaphore, withTimeout } from '../core/concurrency.js';
import { sanitizeErrorText } from '../platform/security/redaction.js';
import { JobError } from './errors.js';
import { AccountJobStore, isTerminal } from './store.js';
import type {
  JobDto,
  JobExecution,
  JobResult,
  JobSubmitInput,
  JobUpdateListener,
  MediaJob
} from './types.js';

export interface MediaJobServiceOptions {
  accountDir: (accountId: string) => string;
  accountIds?: () => Promise<string[]>;
  maxConcurrentJobs?: number;
  maxAccountConcurrentJobs?: number;
  maxPendingJobs?: number;
  maxPerAccountPending?: number;
  timeoutMs?: number;
  logger?: Logger;
  now?: () => number;
  recordId?: () => string;
  onUpdate?: JobUpdateListener;
}

interface Runtime {
  controller: AbortController;
  started: boolean;
}

interface AccountState {
  store: AccountJobStore;
  chain: Promise<void>;
}

interface Completion {
  callback: NonNullable<JobSubmitInput['onComplete']>;
}

const TERMINAL: ReadonlySet<MediaJob['state']> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);

/**
 * 有限异步媒体任务：每账号一条执行链、全局受限；任务先落盘再执行。
 * 重启后遗留非终态任务标 interrupted，不自动重发付费请求。
 */
export class MediaJobService {
  readonly #options: MediaJobServiceOptions;
  readonly #accounts = new Map<string, AccountState>();
  readonly #jobs = new Map<string, MediaJob>();
  readonly #loadedAccounts = new Set<string>();
  readonly #runtimes = new Map<string, Runtime>();
  readonly #completions = new Map<string, Completion>();
  readonly #global: Semaphore;
  readonly #now: () => number;
  readonly #logger?: Logger;
  #submitChain: Promise<void> = Promise.resolve();
  #shuttingDown = false;

  constructor(options: MediaJobServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
    this.#global = new Semaphore(Math.max(1, options.maxConcurrentJobs ?? 4));
  }

  async submit(input: JobSubmitInput): Promise<{ job: JobDto; duplicate: boolean }> {
    if (this.#shuttingDown) throw new JobError('job_shutting_down', 'media job service is shutting down');
    if (input.conversation.accountId !== input.accountId) {
      throw new JobError('job_account_mismatch', 'conversation does not belong to this account');
    }
    // 去重、容量检查、落盘与内存注册必须处于同一临界区，否则并发提交会各建一个任务。
    return this.#runSubmit(() => this.#submitExclusive(input));
  }

  async #submitExclusive(input: JobSubmitInput): Promise<{ job: JobDto; duplicate: boolean }> {
    if (this.#shuttingDown) throw new JobError('job_shutting_down', 'media job service is shutting down');
    await this.#ensureAccount(input.accountId);
    if (input.actionId) {
      const existing = [...this.#jobs.values()].find(
        (job) => job.accountId === input.accountId && job.actionId === input.actionId
      );
      if (existing) return { job: toDto(existing), duplicate: true };
    }
    const accountJobs = [...this.#jobs.values()].filter(
      (job) => job.accountId === input.accountId && !TERMINAL.has(job.state)
    );
    const maxPerAccount = Math.max(1, this.#options.maxPerAccountPending ?? 8);
    if (accountJobs.length >= maxPerAccount) {
      throw new JobError('job_backpressure', `media queue for account ${input.accountId} is full`);
    }
    const allPending = [...this.#jobs.values()].filter((job) => !TERMINAL.has(job.state));
    if (allPending.length >= Math.max(1, this.#options.maxPendingJobs ?? 64)) {
      throw new JobError('job_backpressure', 'global media job queue is full');
    }

    const now = this.#now();
    const recordId = (this.#options.recordId ?? crypto.randomUUID)();
    const id = `job-${recordId}`.replace(/[^A-Za-z0-9._-]/g, '-');
    if (this.#jobs.has(id)) throw new JobError('job_duplicate_id', `job id ${id} already exists`);
    const job: MediaJob = {
      id,
      accountId: input.accountId,
      conversation: structuredClone(input.conversation),
      capability: input.capability,
      turnId: input.turnId,
      sessionEpoch: input.sessionEpoch,
      state: 'queued',
      cancelMode: input.cancelMode,
      cancelRequested: false,
      remoteCancelled: false,
      delivery: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(input.originMessageId ? { originMessageId: input.originMessageId } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.actionId ? { actionId: input.actionId } : {})
    };
    await this.#account(input.accountId).store.put(job);
    this.#jobs.set(job.id, job);
    if (input.onComplete) this.#completions.set(job.id, { callback: input.onComplete });
    this.#emit(job);
    this.#schedule(input.accountId, job.id, input.executor, input.signal);
    return { job: toDto(job), duplicate: false };
  }

  #runSubmit<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#submitChain.catch(() => {}).then(task);
    this.#submitChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async get(accountId: string, jobId: string): Promise<JobDto | undefined> {
    await this.#ensureAccount(accountId);
    const job = this.#jobs.get(jobId);
    if (!job || job.accountId !== accountId) return undefined;
    return toDto(job);
  }

  async list(accountId: string): Promise<JobDto[]> {
    await this.#ensureAccount(accountId);
    return [...this.#jobs.values()]
      .filter((job) => job.accountId === accountId)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .map(toDto);
  }

  async listAll(accountIds?: string[]): Promise<JobDto[]> {
    const accounts = new Set(accountIds ?? []);
    for (const accountId of await this.#options.accountIds?.() ?? []) accounts.add(accountId);
    for (const accountId of this.#accounts.keys()) accounts.add(accountId);
    const result: JobDto[] = [];
    for (const accountId of accounts) result.push(...(await this.list(accountId)));
    return result.sort((left, right) => right.createdAt - left.createdAt);
  }

  async cancel(accountId: string, jobId: string): Promise<JobDto> {
    await this.#ensureAccount(accountId);
    const current = this.#jobs.get(jobId);
    if (!current || current.accountId !== accountId) {
      throw new JobError('job_not_found', `job ${jobId} not found for account ${accountId}`);
    }
    if (TERMINAL.has(current.state)) return toDto(current);
    const runtime = this.#runtimes.get(jobId);
    if (!runtime || current.state === 'queued') {
      const updated = await this.#persist(jobId, {
        state: 'cancelled',
        cancelRequested: true,
        finishedAt: this.#now(),
        note: 'cancelled before execution',
        delivery: 'skipped'
      });
      this.#completions.delete(jobId);
      return toDto(updated);
    }
    const updated = await this.#persist(jobId, {
      cancelRequested: true,
      note: 'local cancellation requested; remote state may be unknown'
    });
    runtime.controller.abort(new JobError('job_cancelled', 'media job cancelled'));
    return toDto(updated);
  }

  async markDelivery(
    accountId: string,
    jobId: string,
    delivery: MediaJob['delivery'],
    note?: string
  ): Promise<JobDto> {
    await this.#ensureAccount(accountId);
    const current = this.#jobs.get(jobId);
    if (!current || current.accountId !== accountId) {
      throw new JobError('job_not_found', `job ${jobId} not found for account ${accountId}`);
    }
    const updated = await this.#persist(jobId, {
      delivery,
      ...(note ? { note } : {})
    });
    return toDto(updated);
  }

  async inUseMedia(accountId: string): Promise<Set<string>> {
    await this.#ensureAccount(accountId);
    const inUse = new Set<string>();
    for (const job of this.#jobs.values()) {
      if (job.accountId !== accountId) continue;
      if (TERMINAL.has(job.state) && !(job.state === 'succeeded' && job.delivery === 'pending')) continue;
      for (const media of job.result?.media ?? []) inUse.add(media.mediaId);
    }
    return inUse;
  }

  async dispose(): Promise<void> {
    this.#shuttingDown = true;
    await this.#submitChain.catch(() => {});
    for (const runtime of this.#runtimes.values()) {
      runtime.controller.abort(new JobError('job_interrupted', 'media job interrupted by shutdown'));
    }
    await withTimeout(
      Promise.allSettled([...this.#accounts.values()].map((entry) => entry.chain)),
      Math.min(this.#options.timeoutMs ?? 300_000, 10_000),
      'media job shutdown timed out'
    ).catch(() => {});
    for (const job of [...this.#jobs.values()]) {
      if (!TERMINAL.has(job.state)) {
        await this.#persist(job.id, {
          state: 'interrupted',
          finishedAt: this.#now(),
          delivery: job.delivery === 'sent' ? 'sent' : 'skipped',
          note: 'media job interrupted by shutdown; not resubmitted automatically'
        }).catch(() => {});
      }
    }
    await Promise.allSettled([...this.#accounts.values()].map((entry) => entry.store.dispose()));
    this.#runtimes.clear();
    this.#completions.clear();
    this.#jobs.clear();
    this.#accounts.clear();
    this.#loadedAccounts.clear();
  }

  #schedule(accountId: string, jobId: string, executor: JobExecution, signal?: AbortSignal): void {
    const account = this.#account(accountId);
    const run = account.chain
      .catch(() => {})
      .then(() => this.#run(accountId, jobId, executor, signal))
      .catch((error: unknown) => {
        this.#logger?.error('media job runner failed', {
          jobId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    account.chain = run.then(
      () => undefined,
      () => undefined
    );
  }

  async #run(accountId: string, jobId: string, executor: JobExecution, sessionSignal?: AbortSignal): Promise<void> {
    const current = this.#jobs.get(jobId);
    if (!current || current.accountId !== accountId || TERMINAL.has(current.state)) {
      this.#completions.delete(jobId);
      return;
    }
    if (sessionSignal?.aborted || this.#shuttingDown) {
      await this.#terminal(jobId, 'interrupted', {
        note: this.#shuttingDown ? 'media job interrupted by shutdown' : 'session ended before the job started',
        error: { code: 'job_interrupted', message: 'media job did not start', retryable: false }
      });
      return;
    }
    const release = await this.#global.acquire();
    if (this.#shuttingDown) {
      release();
      return;
    }
    const runtime: Runtime = { controller: new AbortController(), started: false };
    this.#runtimes.set(jobId, runtime);
    let timedOut = false;
    const timeoutMs = Math.max(1_000, this.#options.timeoutMs ?? 300_000);
    const timer = setTimeout(() => {
      timedOut = true;
      runtime.controller.abort(new JobError('job_timeout', `media job timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onSessionAbort = (): void => {
      runtime.controller.abort(
        sessionSignal?.reason instanceof Error
          ? sessionSignal.reason
          : new JobError('session_ended', 'session ended while media job was running')
      );
    };
    sessionSignal?.addEventListener('abort', onSessionAbort, { once: true });
    if (sessionSignal?.aborted) onSessionAbort();
    try {
      if (runtime.controller.signal.aborted) {
        await this.#terminalFromAbort(jobId, runtime.controller.signal, timedOut, sessionSignal);
        return;
      }
      const latest = this.#jobs.get(jobId);
      if (!latest || TERMINAL.has(latest.state)) return;
      runtime.started = true;
      await this.#persist(jobId, { state: 'running', startedAt: this.#now() });
      const job = this.#jobs.get(jobId)!;
      let remoteCancelled = false;
      const context = {
        jobId,
        signal: runtime.controller.signal,
        setWaitingRemote: async (): Promise<void> => {
          const state = this.#jobs.get(jobId)?.state;
          if (state !== 'running') return;
          await this.#persist(jobId, { state: 'waiting_remote' });
        },
        setProvider: async (providerId: string, modelId: string): Promise<void> => {
          const state = this.#jobs.get(jobId);
          if (!state || TERMINAL.has(state.state)) return;
          if (state.providerId === providerId && state.modelId === modelId) return;
          await this.#persist(jobId, { providerId, modelId });
        },
        markRemoteCancelled: (): void => {
          remoteCancelled = true;
        }
      };
      const execution = executor(context);
      void execution.catch(() => {});
      const aborted = new Promise<never>((_, reject) => {
        if (runtime.controller.signal.aborted) {
          reject(runtime.controller.signal.reason);
          return;
        }
        runtime.controller.signal.addEventListener(
          'abort',
          () => reject(runtime.controller.signal.reason),
          { once: true }
        );
      });
      let result: JobResult;
      try {
        result = (await Promise.race([execution, aborted])) as JobResult;
      } catch (error) {
        await this.#terminalFromAbort(jobId, runtime.controller.signal, timedOut, sessionSignal, error, remoteCancelled);
        return;
      }
      if (runtime.controller.signal.aborted) {
        await this.#terminalFromAbort(jobId, runtime.controller.signal, timedOut, sessionSignal, undefined, remoteCancelled);
        return;
      }
      const updated = await this.#persist(jobId, {
        state: 'succeeded',
        finishedAt: this.#now(),
        result: normalizeResult(result),
        remoteCancelled,
        delivery: 'pending'
      });
      const completion = this.#completions.get(jobId);
      if (completion) {
        this.#completions.delete(jobId);
        try {
          await completion.callback(updated);
        } catch (error) {
          this.#logger?.warn('job completion callback failed', {
            jobId,
            message: sanitizeErrorText(error instanceof Error ? error.message : String(error))
          });
        }
      }
      this.#logger?.info('media job succeeded', {
        jobId,
        accountId,
        capability: job.capability,
        providerId: job.providerId
      });
    } catch (error) {
      await this.#terminalFromAbort(jobId, runtime.controller.signal, timedOut, sessionSignal, error);
    } finally {
      clearTimeout(timer);
      sessionSignal?.removeEventListener('abort', onSessionAbort);
      this.#runtimes.delete(jobId);
      release();
    }
  }

  async #terminalFromAbort(
    jobId: string,
    signal: AbortSignal,
    timedOut: boolean,
    sessionSignal?: AbortSignal,
    error?: unknown,
    remoteCancelled = false
  ): Promise<void> {
    const job = this.#jobs.get(jobId);
    if (!job || TERMINAL.has(job.state)) return;
    if (timedOut) {
      await this.#terminal(jobId, 'failed', {
        error: { code: 'job_timeout', message: 'media job timed out', retryable: false },
        finishedAt: this.#now()
      });
      return;
    }
    if (job.cancelRequested) {
      await this.#terminal(jobId, 'cancelled', {
        finishedAt: this.#now(),
        remoteCancelled,
        delivery: 'skipped',
        error: { code: 'job_cancelled', message: 'media job cancelled locally; remote state may be unknown', retryable: false },
        note: 'local cancellation only; remote cancellation is not claimed'
      });
      return;
    }
    if (this.#shuttingDown || sessionSignal?.aborted || signal.aborted) {
      await this.#terminal(jobId, 'interrupted', {
        finishedAt: this.#now(),
        delivery: 'skipped',
        error: { code: 'job_interrupted', message: 'media job interrupted; remote state may be unknown', retryable: false },
        note: 'session or process ended before completion; not resubmitted automatically'
      });
      return;
    }
    const failure = normalizeFailure(error);
    await this.#terminal(jobId, 'failed', {
      finishedAt: this.#now(),
      error: failure,
      delivery: 'skipped'
    });
  }

  async #terminal(
    jobId: string,
    state: MediaJob['state'],
    patch: Partial<MediaJob>
  ): Promise<void> {
    const updated = await this.#persist(jobId, { ...patch, state });
    this.#completions.delete(jobId);
    this.#logger?.info('media job terminal', {
      jobId,
      accountId: updated.accountId,
      state,
      capability: updated.capability,
      code: updated.error?.code
    });
  }

  async #persist(jobId: string, patch: Partial<MediaJob>): Promise<MediaJob> {
    const current = this.#jobs.get(jobId);
    if (!current) throw new JobError('job_not_found', `job ${jobId} not found`);
    if (TERMINAL.has(current.state) && patch.state && !TERMINAL.has(patch.state)) {
      throw new JobError('job_state_invalid', `job ${jobId} is already ${current.state}`);
    }
    const updated = await this.#account(current.accountId).store.update(jobId, patch);
    this.#jobs.set(jobId, updated);
    this.#emit(updated);
    return updated;
  }

  #emit(job: MediaJob): void {
    this.#options.onUpdate?.(structuredClone(job));
  }

  #account(accountId: string): AccountState {
    const existing = this.#accounts.get(accountId);
    if (existing) return existing;
    const store = new AccountJobStore({
      root: this.#options.accountDir(accountId),
      accountId,
      ...(this.#logger ? { logger: this.#logger } : {}),
      now: this.#now
    });
    const state: AccountState = { store, chain: Promise.resolve() };
    this.#accounts.set(accountId, state);
    return state;
  }

  async #ensureAccount(accountId: string): Promise<void> {
    if (this.#loadedAccounts.has(accountId)) return;
    const store = this.#account(accountId).store;
    const jobs = await store.list();
    for (const job of jobs) {
      if (job.accountId === accountId) this.#jobs.set(job.id, job);
    }
    this.#loadedAccounts.add(accountId);
  }
}

function toDto(job: MediaJob): JobDto {
  return structuredClone(job);
}

function normalizeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof JobError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const candidate = error as { code?: unknown; message?: unknown; retryable?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'job_failed',
      message: sanitizeErrorText(typeof candidate.message === 'string' ? candidate.message : 'media job failed'),
      retryable: candidate.retryable === true
    };
  }
  return {
    code: 'job_failed',
    message: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
    retryable: false
  };
}

function normalizeResult(result: JobResult): JobResult {
  return {
    ...(result.text ? { text: result.text } : {}),
    ...(result.media?.length ? { media: structuredClone(result.media) } : {}),
    ...(result.observation !== undefined ? { observation: structuredClone(result.observation) } : {})
  };
}

export { isTerminal };
