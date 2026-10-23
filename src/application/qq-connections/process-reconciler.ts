import { AccompanyError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { SnowLumaProcess } from '../../injection/snowluma/manager.js';
import { SerialExecutor } from '../../platform/async/serial-executor.js';

export interface ProcessMapping {
  slotId: string;
  accountId: string;
  missing: number;
  mappedEpoch: number;
}

export interface ProcessReconcilerHost {
  listProcesses(options: { probeIdentity: boolean }): Promise<SnowLumaProcess[]>;
  /** 按槽位类型执行失联清理；实现方不得回调本收敛器。 */
  cleanupSlot(slotId: string): Promise<void>;
}

export interface ProcessReconcilerOptions {
  host: ProcessReconcilerHost;
  logger: Logger;
  /** 连续多少个成功快照缺少该进程后才清理，避免一次抖动误删。 */
  missingThreshold?: number;
  maxPending?: number;
}

/**
 * PID 与账号槽位的映射收敛器。
 *
 * 扫描本身单飞；每次成功快照在串行域内比较映射代际并执行失联清理，
 * 失败请求不会写入快照，也不会触发清理。
 * 映射代际：本轮扫描开始后新建立的映射不会被旧快照否定。
 */
export class ProcessReconciler {
  readonly #options: ProcessReconcilerOptions;
  readonly #logger: Logger;
  readonly #missingThreshold: number;
  readonly #lock: SerialExecutor;
  readonly #mappings = new Map<number, ProcessMapping>();
  #epoch = 0;
  #scan: Promise<SnowLumaProcess[]> | undefined;
  #snapshot: SnowLumaProcess[] = [];
  #closed = false;

  constructor(options: ProcessReconcilerOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#missingThreshold = options.missingThreshold ?? 2;
    this.#lock = new SerialExecutor({ maxPending: options.maxPending ?? 64 });
  }

  mappingCount(): number {
    return this.#mappings.size;
  }

  hasMappings(): boolean {
    return this.#mappings.size > 0;
  }

  slotForProcess(pid: number): string | undefined {
    return this.#mappings.get(pid)?.slotId;
  }

  mappingFor(pid: number): ProcessMapping | undefined {
    const mapping = this.#mappings.get(pid);
    return mapping ? { ...mapping } : undefined;
  }

  mappings(): Array<[number, ProcessMapping]> {
    return [...this.#mappings].map(([pid, mapping]) => [pid, { ...mapping }]);
  }

  /** 最近一次成功扫描的原始列表；网络失败不会把它清空。 */
  snapshot(): SnowLumaProcess[] {
    return this.#snapshot;
  }

  /** 注入操作确认身份后登记映射；同步执行，避免与收敛交错到半个状态。 */
  track(pid: number, slotId: string, accountId: string): void {
    this.#epoch += 1;
    this.#mappings.set(pid, { slotId, accountId, missing: 0, mappedEpoch: this.#epoch });
  }

  forgetProcess(pid: number): void {
    this.#mappings.delete(pid);
  }

  forgetSlot(slotId: string): void {
    for (const [pid, mapping] of this.#mappings) {
      if (mapping.slotId === slotId) this.#mappings.delete(pid);
    }
  }

  /**
   * 与收敛共用的串行域。任务内不得调用 refresh()，
   * 否则会等待自己而阻塞；槽位清理可在本域内直接执行。
   */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new AccompanyError('core_stopped', 'qq connection reconciler has stopped'));
    }
    return this.#lock.run(task);
  }

  /** 显式刷新/轮询入口；并发请求共享同一次扫描。 */
  refresh(options: { probeIdentity?: boolean } = {}): Promise<SnowLumaProcess[]> {
    if (this.#closed) {
      return Promise.reject(new AccompanyError('core_stopped', 'qq connection reconciler has stopped'));
    }
    if (this.#scan) return this.#scan;
    const scanEpoch = this.#epoch;
    let scan: Promise<SnowLumaProcess[]>;
    scan = this.#options.host
      .listProcesses({ probeIdentity: options.probeIdentity ?? true })
      .then(async (processes) => {
        await this.#lock.run(() => this.#reconcile(processes, scanEpoch));
        return processes;
      })
      .finally(() => {
        if (this.#scan === scan) this.#scan = undefined;
      });
    this.#scan = scan;
    return scan;
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    await this.#scan?.catch(() => {});
    await this.#lock.close().catch(() => {});
  }

  async #reconcile(processes: SnowLumaProcess[], scanEpoch: number): Promise<void> {
    if (this.#closed) return;
    for (const [pid, mapping] of this.#mappings) {
      // 本轮扫描开始后才建立的连接不能被旧快照否定。
      if (mapping.mappedEpoch > scanEpoch) continue;
      const process = processes.find((item) => item.pid === pid);
      const changed = Boolean(process?.uin && process.uin !== mapping.accountId);
      const disconnected = Boolean(process && !process.injected && !process.connected);
      mapping.missing = process && !changed && !disconnected ? 0 : mapping.missing + 1;
      if (!changed && mapping.missing < this.#missingThreshold) continue;
      await this.#options.host.cleanupSlot(mapping.slotId);
      const current = this.#mappings.get(pid);
      if (current && current.mappedEpoch === mapping.mappedEpoch) this.#mappings.delete(pid);
      this.#logger.info('qq process mapping cleaned', {
        pid,
        slotId: mapping.slotId,
        accountId: mapping.accountId,
        reason: changed ? 'account_changed' : process ? 'disconnected' : 'process_missing'
      });
    }
    this.#snapshot = processes;
  }
}
