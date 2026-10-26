import type { SnowLumaRuntimeStatus } from '../types.js';

export type ConnectionBlockerCode =
  | 'status_unknown'
  | 'not_configured'
  | 'not_running'
  | 'version_incompatible'
  | 'password_missing'
  | 'autoload_unknown'
  | 'autoload_enabled'
  | 'consent_required';

export interface ConnectionBlocker {
  code: ConnectionBlockerCode;
  title: string;
  detail: string;
}

export interface ConnectionReadiness {
  ready: boolean;
  blockers: ConnectionBlocker[];
}

/** 连接资格的唯一解释入口；页面只负责展示，不再各自判断。 */
export function connectionReadiness(status: SnowLumaRuntimeStatus | undefined): ConnectionReadiness {
  if (!status) {
    return {
      ready: false,
      blockers: [{
        code: 'status_unknown',
        title: '正在读取 SnowLuma 状态',
        detail: '状态读取完成后会显示连接条件。'
      }]
    };
  }
  const blockers: ConnectionBlocker[] = [];
  if (!status.configured) {
    blockers.push({
      code: 'not_configured',
      title: '尚未连接 SnowLuma',
      detail: '先在连接设置中选择 SnowLuma 目录并保存管理密码。'
    });
  }
  if (!status.running) {
    blockers.push({
      code: 'not_running',
      title: 'SnowLuma 管理服务未运行',
      detail: '请手动启动 SnowLuma 1.14.x，再回到这里刷新。应用不会下载或启动它。'
    });
  }
  if (!status.compatible) {
    blockers.push({
      code: 'version_incompatible',
      title: 'SnowLuma 版本不兼容',
      detail: `当前版本 ${status.version ?? '未知'}，需要 ${status.supportedVersion}。`
    });
  }
  if (!status.passwordConfigured) {
    blockers.push({
      code: 'password_missing',
      title: '尚未保存 WebUI 管理密码',
      detail: '在连接设置中填写 SnowLuma 官方界面设置的密码。'
    });
  }
  if (!status.autoLoadKnown) {
    blockers.push({
      code: 'autoload_unknown',
      title: '无法确认自动注入状态',
      detail: '请在 SnowLuma 官方设置中检查 hookAutoLoad 是否关闭，然后刷新。'
    });
  }
  if (status.autoLoadKnown && status.autoLoadEnabled) {
    blockers.push({
      code: 'autoload_enabled',
      title: 'SnowLuma 自动注入已开启',
      detail: '为避免重复注入，请先在 SnowLuma 中关闭自动注入。'
    });
  }
  if (status.consentRequired) {
    blockers.push({
      code: 'consent_required',
      title: '尚未完成官方协议确认',
      detail: '请先在 SnowLuma 自己的界面确认用户协议与隐私政策。应用不会代你同意。'
    });
  }
  return { ready: blockers.length === 0, blockers };
}
