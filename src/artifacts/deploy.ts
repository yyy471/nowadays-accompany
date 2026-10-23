import type { ResolvedProfile } from './types.js';
import type { Logger } from '../core/logger.js';

export interface DeployTarget {
  readonly id: string;
  readonly accountId?: string;
  readonly currentProfile?: ResolvedProfile;
  validateProfile(): Promise<ResolvedProfile>;
  applyProfile(profile: ResolvedProfile): Promise<void>;
}

export interface DeploymentEntry {
  instanceId: string;
  accountId?: string;
  status: 'updated' | 'skipped' | 'failed';
  fromRevision?: string;
  toRevision?: string;
  error?: string;
}

export interface DeploymentRecord {
  id: string;
  action: 'deploy' | 'rollback' | 'reload';
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  entries: DeploymentEntry[];
  detail?: Record<string, unknown>;
}

export interface RollingDeployerOptions {
  listTargets: () => DeployTarget[];
  logger?: Logger;
  now?: () => number;
}

/**
 * 按账号顺序滚动切换。单个账号失败时保留它的旧宿主/旧 revision，
 * 继续处理后续账号；最终记录部分成功，便于重试。
 */
export class RollingDeployer {
  readonly #listTargets: RollingDeployerOptions['listTargets'];
  readonly #logger?: Logger;
  readonly #now: () => number;
  #sequence = 0;

  constructor(options: RollingDeployerOptions) {
    this.#listTargets = options.listTargets;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  async reloadAll(
    action: DeploymentRecord['action'],
    detail?: Record<string, unknown>
  ): Promise<DeploymentRecord> {
    const startedAt = this.#now();
    const entries: DeploymentEntry[] = [];
    for (const target of this.#listTargets()) {
      const accountId = target.accountId;
      if (!accountId) {
        entries.push({ instanceId: target.id, status: 'skipped', error: 'no account bound' });
        continue;
      }
      const current = target.currentProfile;
      try {
        const next = await target.validateProfile();
        if (current?.revision === next.revision) {
          entries.push({
            instanceId: target.id,
            accountId,
            status: 'skipped',
            fromRevision: current.revision,
            toRevision: next.revision
          });
          continue;
        }
        await target.applyProfile(next);
        entries.push({
          instanceId: target.id,
          accountId,
          status: 'updated',
          ...(current ? { fromRevision: current.revision } : {}),
          toRevision: next.revision
        });
        this.#logger?.info('profile rolled forward', {
          instanceId: target.id,
          accountId,
          from: current?.revision,
          to: next.revision
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 从未有过有效档案的账号没有旧 revision 可保留，按跳过处理；已有档案例失败并保留旧宿主。
        entries.push({
          instanceId: target.id,
          accountId,
          status: current ? 'failed' : 'skipped',
          error: message
        });
        this.#logger?.warn('profile rollout could not be applied', {
          instanceId: target.id,
          accountId,
          hadProfile: Boolean(current),
          message
        });
      }
    }
    const record: DeploymentRecord = {
      id: `deploy-${startedAt}-${++this.#sequence}`,
      action,
      startedAt,
      finishedAt: this.#now(),
      ok: entries.every((entry) => entry.status !== 'failed'),
      entries,
      ...(detail ? { detail } : {})
    };
    return record;
  }
}
