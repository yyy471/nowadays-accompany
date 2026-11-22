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
  constructor(private readonly appStore: AppStore, private readonly access: RoleAccess,
    private readonly activity: RoleActivityService, private readonly pause: PauseRoles | null) {}
  private key(kind: MediaKind, id: string): string { return `${kind}:${id}`; }
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
    return () => { this.claims.delete(token); };
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
    return this.appStore.listRoleIndexes().filter(index => index.initStatus === 'ready').flatMap(index =>
      this.access.withStore(index.roleId, storage => {
        const selected = kind === 'voice'
          ? new VoiceStore(storage.business.db, index.roleId).getSettings()?.serviceId
          : new SceneImageSettingsStore(storage.business.db, index.roleId).get()?.serviceId;
        if (selected !== id) return [];
        const activity = this.activity.view(index.roleId);
        return [{ roleId: index.roleId, displayName: storage.business.getRole(index.roleId).displayName, state: activity.state, running: activity.running }];
      }),
    );
  }
  assertResumeAllowed(roleId: string): void {
    for (const key of this.maintaining) {
      const separator = key.indexOf(':');
      const kind = key.slice(0, separator) as MediaKind;
      const id = key.slice(separator + 1);
      if (this.dependencies(kind, id).some(role => role.roleId === roleId)) this.assertAvailable(kind, id);
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
      const deadline = Date.now() + 20_000;
      while (this.inflight(kind, id).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
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
