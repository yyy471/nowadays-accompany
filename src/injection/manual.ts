import crypto from 'node:crypto';
import { AccompanyError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { InstanceSpec, InstanceStatus } from '../instances/spec.js';
import { assertIdentifier } from '../routing/identity.js';
import {
  SnowLumaError,
  type SnowLumaManager,
  type SnowLumaProcess
} from './snowluma/manager.js';

export interface ProcessIdentity {
  pid: number;
  path?: string;
  uin?: string;
}

export interface ManualInjectionRequest {
  slotId?: string;
  identity: ProcessIdentity;
  expectedAccountId?: string;
}

export interface InjectionOperationResult {
  uin?: string;
  process?: SnowLumaProcess;
  instance?: InstanceStatus;
}

export interface InjectionOperationDto {
  id: string;
  action: 'inject-and-listen' | 'listen' | 'refresh' | 'unload';
  pid: number;
  slotId?: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: number;
  finishedAt?: number;
  result?: InjectionOperationResult;
  error?: { code: string; message: string };
}

export interface ManualInjectionResumeCandidate {
  slotId: string;
  accountId: string;
}

export interface ManualInjectionResumeResult {
  attempted: number;
  resumed: Array<{ slotId: string; accountId: string; uin: string; operationId: string }>;
  skipped: Array<{
    slotId: string;
    accountId?: string;
    reason: 'slot_unavailable' | 'process_not_found' | 'not_injected' | 'listen_failed';
    message?: string;
  }>;
}

export interface ManualInjectionHost {
  slot(id: string): InstanceSpec | undefined;
  /** 可参与“恢复上次监听”的持久化槽位；由宿主过滤到当前 runtime。 */
  resumeCandidates?(): InstanceSpec[];
  instanceStatus(id: string): InstanceStatus | undefined;
  /** 当前持有该账号租约的槽位；用于在绑定前拒绝重复宿主。 */
  accountOwner(accountId: string): string | undefined;
  /** 没有 slotId 的桌面流程按 SnowLuma 已确认的登录 QQ 号选择/创建内部槽位。 */
  resolveSlotForAccount?(accountId: string, pid: number): Promise<string>;
  /** 记录进程与已验证账号槽位的临时关系，用于停止、退出和身份变化回收。 */
  trackProcess?(pid: number, slotId: string, accountId: string): void;
  slotForProcess?(pid: number): string | undefined;
  /** 记住仍在监听的账号；应用重启后可据此重建槽位并按需恢复。 */
  rememberListening?(slotId: string, accountId: string): Promise<void>;
  /** 用户停止监听或卸载注入后清除记录，避免下次启动再次恢复。 */
  forgetListening?(slotId: string): Promise<void>;
  startSlot(id: string): Promise<void>;
  stopSlot(id: string): Promise<void>;
  rebindSlot(id: string, accountId: string): Promise<void>;
}

export interface ManualInjectionServiceOptions {
  manager: SnowLumaManager;
  host: ManualInjectionHost;
  logger: Logger;
  now?: () => number;
  loginTimeoutMs?: number;
  loginPollMs?: number;
  operationTtlMs?: number;
}

interface OperationRecord {
  dto: InjectionOperationDto;
  promise: Promise<InjectionOperationDto>;
}

const TERMINAL_CACHE_MS = 5 * 60_000;

/**
 * 用户显式触发的注入/监听操作。探测进程列表不会经过这里；
 * 同一进程的操作串行执行，成功结果按请求去重，失败后允许用户重试。
 */
export class ManualInjectionService {
  readonly #options: ManualInjectionServiceOptions;
  readonly #now: () => number;
  readonly #operations = new Map<string, OperationRecord>();
  readonly #byId = new Map<string, OperationRecord>();
  readonly #chains = new Map<number, Promise<void>>();
  #resuming: Promise<ManualInjectionResumeResult> | undefined;
  #closed = false;

  async dispose(): Promise<void> {
    this.#closed = true;
    await this.#resuming?.catch(() => {});
    await Promise.allSettled([...this.#chains.values()]);
  }

  constructor(options: ManualInjectionServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  injectAndListen(raw: unknown): Promise<InjectionOperationDto> {
    const request = parseRequest(raw, false);
    return this.#run('inject-and-listen', request, () => this.#inject(request, false));
  }

  listen(raw: unknown): Promise<InjectionOperationDto> {
    const request = parseRequest(raw, false);
    return this.#run('listen', request, () => this.#inject(request, true));
  }

  refresh(raw: unknown): Promise<InjectionOperationDto> {
    const request = parseRequest(raw, false);
    return this.#run('refresh', request, async () => {
      if (request.slotId) this.#requireSlot(request.slotId);
      const process = await this.#validateIdentity(request.identity);
      const updated = await this.#options.manager.refresh(process.pid);
      return { process: updated ?? process };
    });
  }

  unload(raw: unknown): Promise<InjectionOperationDto> {
    const request = parseRequest(raw, false);
    return this.#run('unload', request, async () => {
      const slotId = request.slotId ?? this.#options.host.slotForProcess?.(request.identity.pid);
      const slot = slotId ? this.#requireSlot(slotId) : undefined;
      const process = await this.#validateIdentity(request.identity);
      if (slotId && slot) {
        const status = this.#options.host.instanceStatus(slotId);
        const bound = status?.accountId ?? slot.accountId;
        if (bound && process.uin && bound !== process.uin) {
          throw new AccompanyError(
            'injection_identity_mismatch',
            `process ${process.pid} is logged in as ${process.uin}, slot ${slotId} is bound to ${bound}`
          );
        }
        if (status && !['stopped', 'stopping'].includes(status.state)) {
          await this.#options.host.stopSlot(slotId);
        }
      }
      const updated = await this.#options.manager.unload(process.pid);
      if (slotId) await this.#options.host.forgetListening?.(slotId);
      return { process: updated ?? process };
    });
  }

  /**
   * 恢复上次仍在运行的监听。只处理已持久化、期望运行、账号匹配且已注入的进程；
   * 不调用 load，不创建槽位，也不注入新的 QQ。
   */
  resume(): Promise<ManualInjectionResumeResult> {
    if (this.#closed) throw new AccompanyError('core_stopped', 'injection service has stopped');
    if (this.#resuming) return this.#resuming;
    let tracked: Promise<ManualInjectionResumeResult>;
    tracked = this.#resume().finally(() => {
      if (this.#resuming === tracked) this.#resuming = undefined;
    });
    this.#resuming = tracked;
    return tracked;
  }

  operation(id: string): InjectionOperationDto | undefined {
    const record = this.#byId.get(id);
    return record ? structuredClone(record.dto) : undefined;
  }

  /** 与 resume() 共用同一资格规则；供控制面展示“恢复上次监听”入口。 */
  resumeCandidates(): ManualInjectionResumeCandidate[] {
    return this.#eligibleCandidates().eligible;
  }

  #eligibleCandidates(): {
    eligible: ManualInjectionResumeCandidate[];
    skipped: ManualInjectionResumeResult['skipped'];
  } {
    const candidates = this.#options.host.resumeCandidates?.() ?? [];
    const eligible: ManualInjectionResumeCandidate[] = [];
    const skipped: ManualInjectionResumeResult['skipped'] = [];
    for (const spec of candidates) {
      if (spec.backend !== 'snowluma' || !spec.accountId) continue;
      const status = this.#options.host.instanceStatus(spec.id);
      if (!status) {
        skipped.push({ slotId: spec.id, accountId: spec.accountId, reason: 'slot_unavailable' });
        continue;
      }
      if (status.desiredState !== 'running') continue;
      if (status.state !== 'stopped' && status.state !== 'failed') continue;
      eligible.push({ slotId: spec.id, accountId: spec.accountId });
    }
    return { eligible, skipped };
  }

  async #resume(): Promise<ManualInjectionResumeResult> {
    if (!this.#options.host.resumeCandidates) {
      throw new AccompanyError('injection_resume_unavailable', 'this host cannot enumerate resumable slots');
    }
    const { eligible, skipped } = this.#eligibleCandidates();
    if (eligible.length === 0) return { attempted: 0, resumed: [], skipped };

    const processes = await this.#options.manager.listProcesses();
    const resumed: ManualInjectionResumeResult['resumed'] = [];
    for (const candidate of eligible) {
      if (this.#closed) break;
      const sameAccount = processes.filter((process) => process.uin === candidate.accountId);
      const process = sameAccount.find((entry) => entry.injected || entry.connected);
      if (!process) {
        skipped.push({
          ...candidate,
          reason: sameAccount.length > 0 ? 'not_injected' : 'process_not_found'
        });
        continue;
      }
      try {
        const operation = await this.listen({
          slotId: candidate.slotId,
          expectedAccountId: candidate.accountId,
          identity: {
            pid: process.pid,
            ...(process.path ? { path: process.path } : {}),
            ...(process.uin ? { uin: process.uin } : {})
          }
        });
        if (operation.state !== 'succeeded' || !operation.result?.uin) {
          skipped.push({ ...candidate, reason: 'listen_failed', message: operation.error?.message });
          continue;
        }
        resumed.push({
          ...candidate,
          uin: operation.result.uin,
          operationId: operation.id
        });
      } catch (error) {
        skipped.push({
          ...candidate,
          reason: 'listen_failed',
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    this.#options.logger.info('manual injection resume completed', {
      attempted: eligible.length,
      resumed: resumed.length,
      skipped: skipped.length
    });
    return { attempted: eligible.length, resumed, skipped };
  }

  #requireSlot(id: string): InstanceSpec {
    const slot = this.#options.host.slot(id);
    if (!slot) throw new AccompanyError('injection_slot_not_found', `slot ${id} does not exist`);
    return slot;
  }

  #run(
    action: InjectionOperationDto['action'],
    request: ParsedRequest,
    task: () => Promise<InjectionOperationResult>
  ): Promise<InjectionOperationDto> {
    if (this.#closed) throw new AccompanyError('core_stopped', 'injection service has stopped');
    this.#prune();
    const key = [
      action,
      request.slotId ?? '',
      request.identity.pid,
      request.identity.path ?? '',
      request.identity.uin ?? '',
      request.expectedAccountId ?? ''
    ].join('|');
    // 只在操作仍在进行时合并点击；完成后允许重新发起，已注入进程会跳过 load。
    const existing = this.#operations.get(key);
    if (existing) return existing.promise;

    const id = `injection-${crypto.randomUUID()}`;
    const dto: InjectionOperationDto = {
      id,
      action,
      pid: request.identity.pid,
      ...(request.slotId ? { slotId: request.slotId } : {}),
      state: 'running',
      startedAt: this.#now()
    };
    let settle!: (result: InjectionOperationDto) => void;
    const promise = new Promise<InjectionOperationDto>((resolve) => {
      settle = resolve;
    });
    const record: OperationRecord = { dto, promise };
    this.#operations.set(key, record);
    this.#byId.set(id, record);

    this.#enqueue(request.identity.pid, async () => {
      try {
        const result = await task();
        Object.assign(dto, { state: 'succeeded', finishedAt: this.#now(), result });
        this.#options.logger.info('manual injection operation succeeded', {
          action,
          pid: request.identity.pid,
          slotId: request.slotId,
          operationId: id,
          uin: result.uin
        });
      } catch (error) {
        Object.assign(dto, { state: 'failed', finishedAt: this.#now(), error: normalizeError(error) });
        this.#options.logger.warn('manual injection operation failed', {
          action,
          pid: request.identity.pid,
          slotId: request.slotId,
          operationId: id,
          code: dto.error?.code,
          message: dto.error?.message
        });
      } finally {
        this.#operations.delete(key);
        settle(structuredClone(dto));
      }
    });
    return promise;
  }

  #enqueue(pid: number, task: () => Promise<void>): void {
    const previous = this.#chains.get(pid) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.#chains.set(pid, settled);
    void settled.then(() => {
      if (this.#chains.get(pid) === settled) this.#chains.delete(pid);
    });
  }

  async #inject(request: ParsedRequest, listenOnly: boolean): Promise<InjectionOperationResult> {
    if (this.#closed) throw new AccompanyError('core_stopped', 'injection service has stopped');
    let slotId = request.slotId;
    let slot = slotId ? this.#options.host.slot(slotId) : undefined;
    if (slotId && !slot) throw new AccompanyError('injection_slot_not_found', `slot ${slotId} does not exist`);
    if (slot && slot.backend !== 'snowluma') {
      throw new AccompanyError('injection_backend_unsupported', `slot ${slotId} is not a SnowLuma slot`);
    }
    const expected = request.expectedAccountId ?? slot?.accountId ?? request.identity.uin;
    let process = await this.#validateIdentity(request.identity);
    if (expected && process.uin && process.uin !== expected) {
      throw new AccompanyError(
        'injection_identity_mismatch',
        `process ${process.pid} is logged in as ${process.uin}, expected ${expected}`
      );
    }
    if (listenOnly) {
      if (!process.injected && !process.connected) {
        throw new AccompanyError(
          'injection_not_loaded',
          `process ${process.pid} is not injected; use inject-and-listen instead`
        );
      }
    } else if (!process.injected && !process.connected) {
      const loaded = await this.#options.manager.load(process.pid);
      if (loaded) process = loaded;
    }

    const uin = await this.#waitForLogin(process.pid, expected);
    if (this.#closed) throw new AccompanyError('core_stopped', 'injection service has stopped');
    if (!slotId) {
      if (!this.#options.host.resolveSlotForAccount) {
        throw new AccompanyError('injection_slot_required', 'automatic slot allocation is unavailable; select a slot');
      }
      slotId = await this.#options.host.resolveSlotForAccount(uin, process.pid);
      slot = this.#options.host.slot(slotId);
      if (!slot) throw new AccompanyError('injection_slot_not_found', `resolved slot ${slotId} does not exist`);
    }
    if (!slot) throw new AccompanyError('injection_slot_not_found', `slot ${slotId} does not exist`);
    if (slot.backend !== 'snowluma') {
      throw new AccompanyError('injection_backend_unsupported', `slot ${slotId} is not a SnowLuma slot`);
    }
    if (slot.accountId && slot.accountId !== uin) {
      throw new AccompanyError(
        'injection_identity_mismatch',
        `process ${process.pid} is logged in as ${uin}, slot ${slotId} is reserved for ${slot.accountId}`
      );
    }
    if (!slot.accountId) {
      const owner = this.#options.host.accountOwner(uin);
      if (owner && owner !== slotId) {
        throw new AccompanyError(
          'injection_account_in_use',
          `account ${uin} is already owned by slot ${owner}`
        );
      }
      await this.#options.host.rebindSlot(slotId, uin);
    }
    const owner = this.#options.host.accountOwner(uin);
    if (owner && owner !== slotId) {
      throw new AccompanyError(
        'injection_account_in_use',
        `account ${uin} is already owned by slot ${owner}`
      );
    }
    const current = this.#options.host.instanceStatus(slotId);
    if (current && (current.state === 'online' || current.state === 'degraded')) {
      if (current.accountId && current.accountId !== uin) {
        throw new AccompanyError('injection_identity_mismatch', `slot ${slotId} is listening as ${current.accountId}, expected ${uin}`);
      }
      this.#options.host.trackProcess?.(process.pid, slotId, uin);
      await this.#options.host.rememberListening?.(slotId, uin);
      return { uin, process, instance: current };
    }
    if (current && !['stopped', 'failed', 'awaiting_profile'].includes(current.state)) {
      throw new AccompanyError('injection_slot_busy', `slot ${slotId} is ${current.state}; stop it before injecting again`);
    }
    if (this.#closed) throw new AccompanyError('core_stopped', 'injection service has stopped');
    await this.#options.host.startSlot(slotId);
    const instance = this.#options.host.instanceStatus(slotId);
    this.#options.host.trackProcess?.(process.pid, slotId, uin);
    await this.#options.host.rememberListening?.(slotId, uin);
    return {
      uin,
      ...(process ? { process } : {}),
      ...(instance ? { instance } : {})
    };
  }

  async #validateIdentity(identity: ProcessIdentity): Promise<SnowLumaProcess> {
    const processes = await this.#options.manager.listProcesses();
    const process = processes.find((entry) => entry.pid === identity.pid);
    if (!process) {
      throw new AccompanyError(
        'injection_process_stale',
        `process ${identity.pid} is no longer present; refresh the process list`
      );
    }
    if (identity.path && process.path && normalizePath(identity.path) !== normalizePath(process.path)) {
      throw new AccompanyError(
        'injection_process_stale',
        `process ${identity.pid} executable changed since it was discovered`
      );
    }
    if (identity.uin && process.uin && identity.uin !== process.uin) {
      throw new AccompanyError(
        'injection_identity_mismatch',
        `process ${identity.pid} is logged in as ${process.uin}, expected ${identity.uin}`
      );
    }
    return process;
  }

  async #waitForLogin(pid: number, expected?: string): Promise<string> {
    const deadline = this.#now() + (this.#options.loginTimeoutMs ?? 20_000);
    const pollMs = Math.max(50, this.#options.loginPollMs ?? 500);
    while (this.#now() < deadline) {
      if (this.#closed) throw new AccompanyError('core_stopped', 'injection service has stopped');
      const processes = await this.#options.manager.listProcesses();
      const process = processes.find((entry) => entry.pid === pid);
      if (!process) {
        throw new AccompanyError('injection_process_stale', `process ${pid} exited before login completed`);
      }
      let uin = process.uin;
      if (!uin) {
        const probed = await this.#options.manager.probeLogin(pid).catch(() => undefined);
        uin = probed?.uin;
      }
      if (uin) {
        if (expected && uin !== expected) {
          throw new AccompanyError(
            'injection_identity_mismatch',
            `process ${pid} is logged in as ${uin}, expected ${expected}`
          );
        }
        return uin;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new AccompanyError(
      'injection_login_timeout',
      `process ${pid} did not report a QQ account before the login timeout`
    );
  }

  #prune(): void {
    const now = this.#now();
    const ttl = this.#options.operationTtlMs ?? TERMINAL_CACHE_MS;
    for (const [id, record] of this.#byId) {
      if (record.dto.state === 'running') continue;
      if (record.dto.finishedAt !== undefined && now - record.dto.finishedAt > ttl) {
        this.#byId.delete(id);
      }
    }
  }
}

interface ParsedRequest {
  slotId?: string;
  identity: ProcessIdentity;
  expectedAccountId?: string;
}

function parseRequest(raw: unknown, requireSlot = true): ParsedRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AccompanyError('injection_request_invalid', 'request body must be an object');
  }
  const value = raw as Record<string, unknown>;
  let slotId: string | undefined;
  if (value.slotId !== undefined) {
    if (typeof value.slotId !== 'string') throw new AccompanyError('injection_request_invalid', 'slotId must be a string');
    slotId = assertIdentifier(value.slotId, 'slotId');
  }
  if (requireSlot && !slotId) throw new AccompanyError('injection_slot_required', 'slotId is required');
  const identityRaw = value.identity;
  if (!identityRaw || typeof identityRaw !== 'object' || Array.isArray(identityRaw)) {
    throw new AccompanyError('injection_request_invalid', 'identity must be an object');
  }
  const identity = identityRaw as Record<string, unknown>;
  const pid = Number(identity.pid);
  if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
    throw new AccompanyError('injection_request_invalid', 'identity.pid is invalid');
  }
  const path = typeof identity.path === 'string' && identity.path ? identity.path : undefined;
  const uin =
    typeof identity.uin === 'string' || typeof identity.uin === 'number' ? String(identity.uin) : undefined;
  let expectedAccountId: string | undefined;
  if (value.expectedAccountId !== undefined) {
    if (typeof value.expectedAccountId !== 'string') {
      throw new AccompanyError('injection_request_invalid', 'expectedAccountId must be a string');
    }
    expectedAccountId = assertIdentifier(value.expectedAccountId, 'expectedAccountId');
  }
  return {
    ...(slotId ? { slotId } : {}),
    identity: { pid, ...(path ? { path } : {}), ...(uin ? { uin } : {}) },
    ...(expectedAccountId ? { expectedAccountId } : {})
  };
}

function normalizePath(value: string): string {
  return pathKey(value);
}

function pathKey(value: string): string {
  return value.replace(/\//g, '\\').toLowerCase();
}

function normalizeError(error: unknown): { code: string; message: string } {
  if (error instanceof SnowLumaError || error instanceof AccompanyError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'injection_failed', message: error instanceof Error ? error.message : String(error) };
}
