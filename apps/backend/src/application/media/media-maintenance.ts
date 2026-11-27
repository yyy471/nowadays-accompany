import { AppError } from '../../domain/errors.js';
import type { AppStore } from '../../storage/core/app-store.js';
import { VoiceStore } from '../../storage/media/voice-store.js';
import { SceneImageSettingsStore } from '../../storage/media/scene-image-settings-store.js';
import type { RoleAccess } from '../role/role-access.js';
import type { RoleActivityService } from '../role/role-activity-service.js';

export type MediaKind = 'voice' | 'image';
type PauseRoles = (roleIds: string[]) => Promise<{ pausedRoleIds: string[] }>;

/** 单进程内协调媒体服务维护、角色绑配与在途调用；不持有模块级可变状态。 */
export class MediaMaintenance {
  private readonly maintaining = new Set<string>();
  private readonly claims = new Map<symbol, { key: string; roleId: string }>();
  private readonly waiters = new Map<string, Set<() => void>>();
  constructor(private readonly appStore: AppStore, private readonly access: RoleAccess,
    private readonly activity: RoleActivityService, private readonly pause: PauseRoles | null) {}
  private key(kind: MediaKind, id: string): string { return `${kind}:${id}`; }
  /** 角色媒体配置落库后同步依赖投影；serviceId 为空表示解除该类绑定。 */
  syncBinding(roleId: string, kind: MediaKind, serviceId: string | null, now?: string): void {
    this.appStore.setRoleMediaBinding(roleId, kind, serviceId, now);
  }
  /**
   * V16→V17 老库启动期一次性回填依赖投影。回填完成写入版本标记，
   * 之后启动直接跳过，避免每次启动打开全部角色库。
   */
  backfillBindings(): void {
    if (this.appStore.getMeta('media_bindings_v1') === '1') return;
    for (const index of this.appStore.listRoleIndexes().filter(role => role.initStatus === 'ready')) {
      try {
        this.access.withStore(index.roleId, storage => {
          this.appStore.setRoleMediaBinding(index.roleId, 'voice',
            new VoiceStore(storage.business.db, index.roleId).getSettings()?.serviceId ?? null);
          this.appStore.setRoleMediaBinding(index.roleId, 'image',
            new SceneImageSettingsStore(storage.business.db, index.roleId).get()?.serviceId ?? null);
        });
      } catch {
        // 个别角色库异常不影响其他角色与启动；该角色下次保存配置时会重新同步。
      }
    }
    this.appStore.setMeta('media_bindings_v1', '1');
  }
  assertAvailable(kind: MediaKind, id: string | null | undefined): void {
    if (id && this.maintaining.has(this.key(kind, id))) {
      throw new AppError(409, 'MEDIA_SERVICE_MAINTENANCE', '服务正在维护，请稍后重试', { kind, serviceId: id });
    }
  }
  claim(kind: MediaKind, id: string | null | undefined, roleId: string): () => void {
    if (!id) return () => {};
    this.assertAvailable(kind, id);
    const token = Symbol();
    this.claims.set(token, { key: this.key(kind, id), roleId });
    return () => {
      if (!this.claims.delete(token)) return;
      const key = this.key(kind, id);
      if (this.waiters.has(key) && ![...this.claims.values()].some(item => item.key === key)) {
        for (const wake of this.waiters.get(key) ?? []) wake();
      }
    };
  }
  private begin(kind: MediaKind, id: string): void {
    this.assertAvailable(kind, id);
    this.maintaining.add(this.key(kind, id));
  }
  private end(kind: MediaKind, id: string): void { this.maintaining.delete(this.key(kind, id)); }
  private inflight(kind: MediaKind, id: string): string[] {
    const key = this.key(kind, id);
    return [...new Set([...this.claims.values()].filter(item => item.key === key).map(item => item.roleId))];
  }
  dependencies(kind: MediaKind, id: string) {
    // 依赖关系由 app 库投影索引直接命中，只打开真正使用该服务的角色库。
    return this.appStore.listRoleIdsByMediaService(kind, id).flatMap(roleId =>
      this.access.withStore(roleId, storage => {
        const activity = this.activity.view(roleId);
        return [{ roleId, displayName: storage.business.getRole(roleId).displayName, state: activity.state, running: activity.running }];
      }),
    );
  }
  assertResumeAllowed(roleId: string): void {
    if (!this.maintaining.size) return;
    // O(1) 查表：不逐个扫描角色库，只按该角色投影出的服务校验维护状态。
    for (const binding of this.appStore.listRoleMediaBindings(roleId)) {
      this.assertAvailable(binding.kind, binding.serviceId);
    }
  }
  async update<T>(kind: MediaKind, id: string, connectionChanged: boolean, action: () => T): Promise<{ value: T; maintenance: { connectionChanged: boolean; pausedRoleIds: string[] } }> {
    if (!connectionChanged) { this.assertAvailable(kind, id); return { value: action(), maintenance: { connectionChanged: false, pausedRoleIds: [] } }; }
    this.begin(kind, id);
    let pausedRoleIds: string[] = [];
    try {
      const pending = this.dependencies(kind, id).filter(role => role.state !== 'stopped');
      if (pending.length) {
        if (!this.pause) throw new AppError(409, 'ROLES_NOT_STOPPED', '角色维护协调尚未配置，请稍后重试', { roles: pending });
        pausedRoleIds = (await this.pause(pending.map(role => role.roleId))).pausedRoleIds;
      }
      const key = this.key(kind, id);
      if (this.inflight(kind, id).length) await new Promise<void>(resolve => {
        const waiters = this.waiters.get(key) ?? new Set<() => void>();
        this.waiters.set(key, waiters);
        const finish = () => {
          clearTimeout(timer);
          waiters.delete(finish);
          if (!waiters.size) this.waiters.delete(key);
          resolve();
        };
        const timer = setTimeout(finish, 20_000);
        waiters.add(finish);
      });
      const busy = this.inflight(kind, id);
      if (busy.length) throw new AppError(409, 'MEDIA_SERVICE_MAINTENANCE', '仍有调用正在使用这个服务，请等它结算后再保存', { roleIds: busy });
      const unpaused = this.dependencies(kind, id).filter(role => role.state !== 'stopped');
      if (unpaused.length) throw new AppError(409, 'MEDIA_SERVICE_MAINTENANCE', '维护期间出现活动依赖，请重新确认后保存', { roles: unpaused });
      return { value: action(), maintenance: { connectionChanged: true, pausedRoleIds } };
    } catch (error) {
      const details = error instanceof AppError && error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details as Record<string, unknown> : {};
      const partial = Array.isArray(details.pausedRoleIds) ? details.pausedRoleIds.filter((id): id is string => typeof id === 'string') : [];
      const stopped = [...new Set([...pausedRoleIds, ...partial])];
      if (error instanceof AppError && stopped.length) throw new AppError(error.status, error.code, error.message, { ...details, maintenance: { pausedRoleIds: stopped } });
      throw error;
    } finally { this.end(kind, id); }
  }
  remove<T>(kind: MediaKind, id: string, action: () => T): T {
    this.begin(kind, id);
    try {
      const roles = this.dependencies(kind, id).filter(role => role.state !== 'stopped');
      const inFlightRoleIds = this.inflight(kind, id);
      if (roles.length || inFlightRoleIds.length) throw new AppError(409, 'MEDIA_SERVICE_IN_USE', '服务仍被活动角色或在途调用使用', { kind, serviceId: id, roles, inFlightRoleIds });
      return action();
    } finally { this.end(kind, id); }
  }
}
