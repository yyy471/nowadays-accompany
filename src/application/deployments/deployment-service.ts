import type { DeploymentRecord, RollingDeployer } from '../../artifacts/deploy.js';
import type { LocalArtifactStore } from '../../artifacts/local.js';
import { artifactRefKey, type ArtifactKind } from '../../artifacts/types.js';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';

export interface DeploymentHost {
  stopped(): boolean;
  /** 每次部署完成后更新指标；记录本身由本服务保存。 */
  recorded(record: DeploymentRecord): void;
}

export interface DeploymentServiceOptions {
  artifacts: LocalArtifactStore;
  deployer: RollingDeployer;
  host: DeploymentHost;
}

/** 制品部署与回滚用例；串行执行，失败记录不吞掉。 */
export class DeploymentService {
  readonly #options: DeploymentServiceOptions;
  readonly #records: DeploymentRecord[] = [];
  #chain: Promise<void> = Promise.resolve();

  constructor(options: DeploymentServiceOptions) {
    this.#options = options;
  }

  deployArtifact(kind: ArtifactKind, id: string, revision: string): Promise<DeploymentRecord> {
    if (kind === 'worldbook') {
      return Promise.reject(new InvalidSpecError('worldbook资源不参与部署、catalog跟随或worker重载；请在会话中固定选择版本。'));
    }
    if (this.#options.host.stopped()) {
      return Promise.reject(new AccompanyError('core_stopped', 'core has been stopped'));
    }
    return this.#run(async () => {
      const catalog = await this.#options.artifacts.readCatalog(this.#options.artifacts.publicRoot);
      const from = catalog[artifactRefKey(kind, id)];
      const { current } = await this.#options.artifacts.setPublicRevision(kind, id, revision);
      const record = await this.#options.deployer.reloadAll('deploy', {
        kind,
        id,
        ...(from ? { from } : {}),
        to: current
      });
      this.#record(record);
      return record;
    });
  }

  rollbackArtifacts(): Promise<DeploymentRecord> {
    if (this.#options.host.stopped()) {
      return Promise.reject(new AccompanyError('core_stopped', 'core has been stopped'));
    }
    return this.#run(async () => {
      const { restored, replaced } = await this.#options.artifacts.rollbackPublic();
      const record = await this.#options.deployer.reloadAll('rollback', { restored, replaced });
      this.#record(record);
      return record;
    });
  }

  deployments(): DeploymentRecord[] {
    return [...this.#records];
  }

  async drain(): Promise<void> {
    await this.#chain;
  }

  #record(record: DeploymentRecord): void {
    this.#records.push(record);
    if (this.#records.length > 20) this.#records.shift();
    this.#options.host.recorded(record);
  }

  #run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#chain.catch(() => {}).then(task);
    this.#chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
