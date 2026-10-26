import type { SnowLumaRuntimeStatus } from '../types';
import { Tag } from '../ui';

/** SnowLuma 运行状态的共享展示；连接页与设置页使用同一套标签。 */
export function SnowLumaStatusTags({ status }: { status?: SnowLumaRuntimeStatus }) {
  if (!status) return <p className="muted" role="status">正在读取 SnowLuma 状态…</p>;
  return (
    <div className="chip-row">
      <Tag tone={status.running ? 'ok' : 'idle'}>{status.running ? '管理服务在线' : '管理服务未运行'}</Tag>
      <Tag tone={status.compatible ? 'ok' : 'bad'}>{status.version ?? '版本未知'} / 支持 {status.supportedVersion}</Tag>
      <Tag tone={status.authenticated ? 'ok' : 'warn'}>{status.authenticated ? '已验证密码' : status.passwordConfigured ? '密码未验证' : '尚未保存密码'}</Tag>
      <Tag tone={status.autoLoadKnown ? status.autoLoadEnabled ? 'bad' : 'ok' : 'warn'}>{status.autoLoadKnown ? status.autoLoadEnabled ? '自动注入已开启' : '自动注入已关闭' : '自动注入状态未知'}</Tag>
      {status.consentRequired ? <Tag tone="warn">尚未完成官方协议确认</Tag> : null}
      {status.owner === 'external' && status.running ? <Tag tone="idle">复用现有服务</Tag> : null}
    </div>
  );
}
