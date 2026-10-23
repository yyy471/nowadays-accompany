import crypto from 'node:crypto';
import path from 'node:path';
import { AccompanyError, InvalidSpecError } from '../../core/errors.js';
import type { Logger } from '../../core/logger.js';
import type { InstanceSpec, InstanceStatus } from '../../instances/spec.js';
import {
  ManualInjectionService,
  type InjectionOperationDto,
  type ManualInjectionResumeCandidate,
  type ManualInjectionResumeResult
} from '../../injection/manual.js';
import type { SnowLumaManager, SnowLumaProcess } from '../../injection/snowluma/manager.js';
import type { AccountDirectory } from '../../profiles/account-directory.js';
import { assertIdentifier } from '../../routing/identity.js';
import type { ListeningStore } from '../../storage/listening-store.js';
import type { AccountPresentation } from '../accounts/account-presentation.js';
import { ProcessReconciler } from './process-reconciler.js';

/** Core 提供的槽位能力；实现只操作 Supervisor/租约，不回调本服务。 */
export interface QqSlotPort {
  specs(): InstanceSpec[];
  spec(id: string): InstanceSpec | undefined;
  status(id: string): InstanceStatus | undefined;
  add(spec: InstanceSpec): void;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** 释放该槽位的 runtime 租约。 */
  releaseRuntime(id: string): Promise<void>;
  saveSlots(specs: InstanceSpec[]): Promise<void>;
  syncCount(): void;
  accountOwner(accountId: string): string | undefined;
  isStopped(): boolean;
  runtimeDir(): string | undefined;
}

export interface QqConnectionServiceOptions {
  manager: SnowLumaManager;
  host: QqSlotPort;
  listening: ListeningStore;
  directory: AccountDirectory;
  presentation: AccountPresentation;
  logger: Logger;
  manualStartOnly: boolean;
  pollIntervalMs?: number;
  now?: () => number;
  loginTimeoutMs?: number;
  loginPollMs?: number;
}

/**
 * QQ 进程接入用例：显式注入/监听、进程列表、恢复上次监听与动态槽位。
 *
 * 锁顺序：ManualInjectionService 的每进程操作链（M）→ ProcessReconciler 串行域（R）→ Supervisor。
 * R 内只执行槽位停止/移除/保存，不调用注入操作、不等待 M；Core 门面单向委托本服务，
 * 服务通过 QqSlotPort 使用底层能力，不回调 Core 的公开方法。
 */
export class QqConnectionService {
  readonly #options: QqConnectionServiceOptions;
  readonly #logger: Logger;
  readonly #manual: ManualInjectionService;
  readonly #reconciler: ProcessReconciler;
  readonly #dynamicSlots = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: QqConnectionServiceOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#reconciler = new ProcessReconciler({
      logger: options.logger.child('processes'),
      host: {
        listProcesses: (scanOptions) => this.#options.manager.listProcesses(scanOptions),
        cleanupSlot: (slotId) => this.#cleanupSlot(slotId)
      }
    });
    this.#manual = new ManualInjectionService({
      manager: options.manager,
      logger: options.logger.child('manual-injection'),
      host: {
        slot: (id) => this.#options.host.spec(id),
        resumeCandidates: () => {
          const runtimeDir = this.#options.host.runtimeDir();
          if (!runtimeDir) return [];
          const resolved = path.resolve(runtimeDir);
          return this.#options.host.specs().filter((spec) =>
            spec.backend === 'snowluma' && spec.runtimeDir !== undefined && path.resolve(spec.runtimeDir) === resolved
          );
        },
        instanceStatus: (id) => this.#options.host.status(id),
        accountOwner: (accountId) => this.#options.host.accountOwner(accountId),
        startSlot: (id) => this.#options.host.start(id),
        stopSlot: (id) => this.stopInstance(id),
        rebindSlot: (id, accountId) => this.#rebindSlotAccount(id, accountId),
        resolveSlotForAccount: (accountId, pid) => this.#ensureDynamicSlot(accountId, pid),
        trackProcess: (pid, slotId, accountId) => { this.#reconciler.track(pid, slotId, accountId); },
        slotForProcess: (pid) => this.#reconciler.slotForProcess(pid),
        rememberListening: (slotId, accountId) => this.#rememberListening(slotId, accountId),
        forgetListening: (slotId) => this.#forgetListening(slotId)
      },
      ...(options.now ? { now: options.now } : {}),
      ...(options.loginTimeoutMs !== undefined ? { loginTimeoutMs: options.loginTimeoutMs } : {}),
      ...(options.loginPollMs !== undefined ? { loginPollMs: options.loginPollMs } : {})
    });
  }

  /** 启动进程收敛轮询；不触发注入。 */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#closed || this.#options.host.isStopped()) return;
      if (!this.#reconciler.hasMappings()) return;
      void this.#reconciler.refresh({ probeIdentity: true }).catch(() => {});
    }, this.#options.pollIntervalMs ?? 5_000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#manual.dispose();
    await this.#reconciler.dispose();
  }

  injectAndListen(raw: unknown): Promise<InjectionOperationDto> {
    return this.#manual.injectAndListen(raw);
  }

  listen(raw: unknown): Promise<InjectionOperationDto> {
    return this.#manual.listen(raw);
  }

  refresh(raw: unknown): Promise<InjectionOperationDto> {
    return this.#manual.refresh(raw);
  }

  unload(raw: unknown): Promise<InjectionOperationDto> {
    return this.#manual.unload(raw);
  }

  operation(id: string): InjectionOperationDto | undefined {
    return this.#manual.operation(id);
  }

  resumeCandidates(): ManualInjectionResumeCandidate[] {
    return this.#manual.resumeCandidates();
  }

  async resumeInjectionListening(): Promise<ManualInjectionResumeResult> {
    if (this.#closed) throw new AccompanyError('core_stopped', 'qq connection service has stopped');
    await this.restoreListeningSlots();
    return this.#manual.resume();
  }

  /** 用上次监听记录重建动态槽位；只恢复待恢复状态，不启动、不注入。 */
  restoreListeningSlots(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new AccompanyError('core_stopped', 'qq connection service has stopped'));
    }
    if (!this.#options.manualStartOnly) return Promise.resolve();
    return this.#reconciler.runExclusive(() => this.#restoreListeningSlotsUnlocked());
  }

  /** 进程列表 = 一次收敛刷新 + 展示组合；并发请求共享同一次扫描。 */
  async processes(options: { avatars?: boolean } = {}): Promise<SnowLumaProcess[]> {
    const processes = await this.#reconciler.refresh({ probeIdentity: true });
    const presented = await Promise.all(processes.map((process) => this.#present(process)));
    if (!options.avatars) return presented;
    return Promise.all(presented.map(async (process) => {
      if (process.avatarDataUrl) return process;
      const accountId = process.uin ?? process.accountHint?.uin;
      if (!accountId) return process;
      const avatar = await this.#options.presentation.avatar(accountId);
      return avatar ? { ...process, avatarDataUrl: avatar.dataUrl } : process;
    }));
  }

  /** 用户停止：动态槽位整体移除，配置槽位只停止并清除恢复记录。 */
  stopInstance(id: string): Promise<void> {
    return this.#reconciler.runExclusive(async () => {
      if (this.#dynamicSlots.has(id)) await this.#removeSlotUnlocked(id);
      else {
        await this.#options.host.stop(id);
        await this.#forgetListening(id);
      }
      this.#reconciler.forgetSlot(id);
    });
  }

  removeSlot(id: string): Promise<void> {
    return this.#reconciler.runExclusive(() => this.#removeSlotUnlocked(id));
  }

  hasMappings(): boolean {
    return this.#reconciler.hasMappings();
  }

  dynamicSlotIds(): string[] {
    return [...this.#dynamicSlots];
  }

  /** 保存非动态槽位；动态槽位由监听记录重建。 */
  saveConfiguredSlots(): Promise<void> {
    return this.#persistSlots();
  }

  async #cleanupSlot(slotId: string): Promise<void> {
    if (this.#dynamicSlots.has(slotId)) await this.#removeSlotUnlocked(slotId);
    else await this.#options.host.stop(slotId);
  }

  async #removeSlotUnlocked(id: string): Promise<void> {
    if (!this.#options.host.spec(id)) throw new InvalidSpecError(`unknown slot: ${id}`);
    await this.#options.host.stop(id);
    await this.#options.host.remove(id);
    this.#dynamicSlots.delete(id);
    this.#reconciler.forgetSlot(id);
    await this.#options.host.releaseRuntime(id);
    await this.#forgetListening(id);
    this.#options.host.syncCount();
    await this.#persistSlots();
  }

  /** 手动注入确认 QQ 号后，把未绑定的槽位重绑到该账号；必须停在槽位后再换号。 */
  #rebindSlotAccount(id: string, accountId: string): Promise<void> {
    return this.#reconciler.runExclusive(async () => {
      const current = this.#options.host.spec(id);
      if (!current) throw new InvalidSpecError(`unknown slot: ${id}`);
      const spec = structuredClone(current);
      if (spec.accountId === accountId) return;
      if (spec.accountId) {
        throw new AccompanyError('injection_slot_bound', `slot ${id} is already bound to ${spec.accountId}`);
      }
      if (this.#options.host.status(id)?.state !== 'stopped') await this.#options.host.stop(id);
      if (this.#options.host.status(id)?.state !== 'stopped') {
        throw new AccompanyError('injection_slot_busy', `slot ${id} did not stop before account binding`);
      }
      await this.#options.host.releaseRuntime(id);
      await this.#options.host.remove(id);
      try {
        this.#options.host.add({ ...spec, accountId });
        await this.#persistSlots();
      } catch (error) {
        await this.#options.host.remove(id).catch(() => {});
        try {
          this.#options.host.add(spec);
          await this.#persistSlots();
        } catch {
          // 恢复失败时保留原始错误，槽位缺失会在下一次持久化或重启时暴露。
        }
        throw error;
      }
      this.#options.host.syncCount();
      this.#logger.info('slot bound to injected account', { instanceId: id, accountId });
    });
  }

  async #persistSlots(): Promise<void> {
    const specs = this.#options.host.specs().filter((spec) => !this.#dynamicSlots.has(spec.id));
    await this.#options.host.saveSlots(specs);
  }

  async #restoreListeningSlotsUnlocked(): Promise<void> {
    const runtimeDir = this.#options.host.runtimeDir();
    if (!runtimeDir) return;
    const resolved = path.resolve(runtimeDir);
    const specs = this.#options.host.specs();
    let added = 0;
    for (const record of this.#options.listening.list()) {
      if (path.resolve(record.runtimeDir) !== resolved) continue;
      if (this.#options.host.spec(record.slotId)) continue;
      const bound = specs.some((spec) =>
        spec.backend === 'snowluma'
        && spec.accountId === record.accountId
        && spec.runtimeDir !== undefined
        && path.resolve(spec.runtimeDir) === resolved
      );
      if (bound) continue;
      const spec: InstanceSpec = {
        id: record.slotId,
        backend: 'snowluma',
        runtimeDir,
        accountId: record.accountId,
        restart: { enabled: false }
      };
      try {
        this.#options.host.add(spec);
        this.#dynamicSlots.add(record.slotId);
        specs.push(spec);
        added += 1;
      } catch (error) {
        this.#logger.warn('restore listening slot failed', {
          slotId: record.slotId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (added > 0) {
      this.#options.host.syncCount();
      this.#logger.info('listening slots restored', { count: added });
    }
  }

  async #rememberListening(slotId: string, accountId: string): Promise<void> {
    const spec = this.#options.host.spec(slotId);
    if (!spec?.runtimeDir) return;
    try {
      await this.#options.listening.remember({ slotId, accountId, runtimeDir: path.resolve(spec.runtimeDir) });
    } catch (error) {
      this.#logger.warn('remember listening failed', {
        slotId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #forgetListening(slotId: string): Promise<void> {
    try {
      await this.#options.listening.forget(slotId);
    } catch (error) {
      this.#logger.warn('forget listening failed', {
        slotId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  #ensureDynamicSlot(accountId: string, pid: number): Promise<string> {
    return this.#reconciler.runExclusive(async () => {
      if (this.#closed || this.#options.host.isStopped()) {
        throw new AccompanyError('core_stopped', 'core has stopped');
      }
      assertIdentifier(accountId, 'accountId');
      const runtimeDir = this.#options.host.runtimeDir();
      if (!runtimeDir) {
        throw new AccompanyError('snowluma_runtime_unavailable', 'configure the SnowLuma runtime directory first');
      }
      const previous = this.#reconciler.mappingFor(pid);
      if (previous && previous.accountId !== accountId) {
        if (this.#dynamicSlots.has(previous.slotId)) {
          if (this.#options.host.spec(previous.slotId)) await this.#removeSlotUnlocked(previous.slotId);
        } else if (this.#options.host.spec(previous.slotId)) {
          await this.#options.host.stop(previous.slotId);
        }
        this.#reconciler.forgetProcess(pid);
      }
      for (const [otherPid, mapping] of this.#reconciler.mappings()) {
        if (mapping.accountId === accountId && otherPid !== pid) {
          throw new AccompanyError('injection_account_in_use', `QQ ${accountId} is already listening through another process`);
        }
      }
      const existing = this.#options.host.specs().find((spec) =>
        spec.backend === 'snowluma'
        && spec.accountId === accountId
        && path.resolve(spec.runtimeDir ?? '') === path.resolve(runtimeDir)
      );
      if (existing) {
        this.#reconciler.track(pid, existing.id, accountId);
        return existing.id;
      }
      const base = `qq-${accountId}`;
      let id = base;
      while (this.#options.host.spec(id)) id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
      const spec: InstanceSpec = { id, backend: 'snowluma', runtimeDir, accountId, restart: { enabled: false } };
      this.#dynamicSlots.add(id);
      try {
        this.#options.host.add(spec);
      } catch (error) {
        this.#dynamicSlots.delete(id);
        throw error;
      }
      this.#options.host.syncCount();
      this.#reconciler.track(pid, id, accountId);
      return id;
    });
  }

  async #present(process: SnowLumaProcess): Promise<SnowLumaProcess> {
    const instanceId = this.#reconciler.slotForProcess(process.pid);
    const accountId = process.uin ?? process.accountHint?.uin;
    const connected = instanceId ? this.#options.host.status(instanceId) : undefined;
    const nickname = connected && connected.accountId === accountId
      ? connected.accountNickname ?? process.nickname
      : process.nickname;
    const spec = instanceId ? this.#options.host.spec(instanceId) : undefined;
    const presented = accountId
      ? await this.#options.presentation.process(accountId, this.#options.directory.forSpec(spec, accountId), nickname)
      : {};
    return {
      ...process,
      ...(instanceId ? { instanceId } : {}),
      ...(presented.nickname ? { nickname: presented.nickname } : {}),
      ...(presented.displayName ? { displayName: presented.displayName } : {}),
      ...(presented.avatarDataUrl ? { avatarDataUrl: presented.avatarDataUrl } : {})
    };
  }
}
