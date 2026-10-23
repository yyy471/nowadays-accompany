import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import { writeFileAtomic } from '../storage/atomic-write.js';
import { JobError } from './errors.js';
import type { MediaJob } from './types.js';

interface JobIndex {
  version: 1;
  jobs: Record<string, MediaJob>;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

/** 账号私有任务记录；写入串行、原子替换。启动时把遗留的非终态任务标为 interrupted。 */
export class AccountJobStore {
  readonly #root: string;
  readonly #accountId: string;
  readonly #logger?: Logger;
  readonly #now: () => number;
  readonly #maxJobs: number;
  #index: JobIndex | undefined;
  #init: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: { root: string; accountId: string; logger?: Logger; now?: () => number; maxJobs?: number }) {
    this.#root = path.resolve(options.root);
    this.#accountId = options.accountId;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#maxJobs = Math.max(20, options.maxJobs ?? 500);
  }

  async list(): Promise<MediaJob[]> {
    await this.#ready();
    return Object.values(this.#index!.jobs)
      .filter((job) => job.accountId === this.#accountId)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .map((job) => structuredClone(job));
  }

  async get(jobId: string): Promise<MediaJob | undefined> {
    if (!JOB_ID.test(jobId)) return undefined;
    await this.#ready();
    const job = this.#index!.jobs[jobId];
    return job && job.accountId === this.#accountId ? structuredClone(job) : undefined;
  }

  async findByAction(actionId: string): Promise<MediaJob | undefined> {
    await this.#ready();
    const job = Object.values(this.#index!.jobs).find(
      (entry) => entry.accountId === this.#accountId && entry.actionId === actionId
    );
    return job ? structuredClone(job) : undefined;
  }

  async put(job: MediaJob): Promise<MediaJob> {
    if (job.accountId !== this.#accountId) {
      throw new JobError('job_account_mismatch', `job store for ${this.#accountId} refused ${job.accountId}`);
    }
    await this.#ready();
    this.#index!.jobs[job.id] = structuredClone(job);
    this.#prune();
    await this.#persist();
    return structuredClone(job);
  }

  async update(jobId: string, patch: Partial<MediaJob>): Promise<MediaJob> {
    await this.#ready();
    const current = this.#index!.jobs[jobId];
    if (!current || current.accountId !== this.#accountId) {
      throw new JobError('job_not_found', `job ${jobId} not found`);
    }
    if (isTerminal(current.state) && patch.state && !isTerminal(patch.state)) {
      throw new JobError('job_state_invalid', `job ${jobId} is already ${current.state}`);
    }
    const next: MediaJob = {
      ...current,
      ...structuredClone(patch),
      id: current.id,
      accountId: current.accountId,
      createdAt: current.createdAt,
      updatedAt: this.#now()
    };
    this.#index!.jobs[jobId] = next;
    await this.#persist();
    return structuredClone(next);
  }

  async dispose(): Promise<void> {
    await this.#writeChain.catch(() => {});
  }

  async #ready(): Promise<void> {
    if (!this.#init) this.#init = this.#load();
    await this.#init;
  }

  async #load(): Promise<void> {
    let changed = false;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(this.#root, 'jobs.json'), 'utf8')) as Partial<JobIndex>;
      const jobs: Record<string, MediaJob> = {};
      for (const [jobId, job] of Object.entries(raw.jobs ?? {})) {
        if (!JOB_ID.test(jobId) || !job || job.accountId !== this.#accountId) continue;
        if (!isTerminal(job.state)) {
          jobs[jobId] = {
            ...job,
            state: 'interrupted',
            updatedAt: this.#now(),
            finishedAt: this.#now(),
            note: 'process restarted while the media task was not terminal; it was not resubmitted automatically',
            delivery: job.delivery === 'sent' ? 'sent' : 'skipped'
          };
          changed = true;
        } else if (job.state === 'succeeded' && job.delivery === 'pending') {
          jobs[jobId] = {
            ...job,
            delivery: 'skipped',
            note: job.note ?? 'result completed before restart and was not sent automatically'
          };
          changed = true;
        } else {
          jobs[jobId] = job;
        }
      }
      this.#index = { version: 1, jobs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.#index = { version: 1, jobs: {} };
        return;
      }
      throw new JobError('job_store_corrupt', `job store is unreadable: ${this.#root}`);
    }
    if (changed) await this.#persist();
  }

  #prune(): void {
    const index = this.#index!;
    const terminal = Object.values(index.jobs)
      .filter((job) => isTerminal(job.state))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    const excess = Object.keys(index.jobs).length - this.#maxJobs;
    if (excess <= 0) return;
    for (let indexEntry = 0; indexEntry < Math.min(excess, terminal.length); indexEntry += 1) {
      const job = terminal[indexEntry];
      if (job) delete index.jobs[job.id];
    }
  }

  async #persist(): Promise<void> {
    const index = this.#index;
    if (!index) return;
    const payload = `${JSON.stringify(
      {
        version: 1,
        jobs: Object.fromEntries(Object.entries(index.jobs).sort(([left], [right]) => left.localeCompare(right)))
      },
      null,
      2
    )}\n`;
    const task = this.#writeChain
      .catch(() => {})
      .then(() => writeFileAtomic(path.join(this.#root, 'jobs.json'), payload));
    this.#writeChain = task.then(
      () => undefined,
      () => undefined
    );
    try {
      await task;
    } catch (error) {
      this.#logger?.error('job store persist failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      throw new JobError('job_persist_failed', 'failed to persist job record');
    }
  }
}

export function isTerminal(state: MediaJob['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'interrupted';
}
