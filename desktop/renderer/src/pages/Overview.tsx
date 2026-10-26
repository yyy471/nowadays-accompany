import { usePoll } from '../hooks';
import type { InjectionProcessesResponse, InjectionRuntimeResponse, SlotsResponse } from '../types';
import { AsyncBoundary, Button, Card, ErrorNote, Icon, StatePill } from '../ui';
import { SnowLumaStatusTags } from '../components/SnowLumaStatusTags';

interface OverviewPageProps {
  slots?: SlotsResponse;
  slotsLoading: boolean;
  slotsError?: string;
  onNavigate: (page: string) => void;
  refreshSlots: () => Promise<void>;
}

export function OverviewPage({ slots, slotsLoading, slotsError, onNavigate, refreshSlots }: OverviewPageProps) {
  const runtime = usePoll<InjectionRuntimeResponse>('/injection/runtime', 5000);
  const processes = usePoll<InjectionProcessesResponse>('/injection/processes', 5000);
  const instances = slots?.slots ?? [];
  const onlineCount = instances.filter((instance) => instance.state === 'online').length;
  const runningCount = instances.filter((instance) => !['stopped', 'failed'].includes(instance.state)).length;
  const resumableCount = slots?.resumable.length ?? 0;
  const headline = onlineCount
    ? `${onlineCount} 个账号正在监听`
    : runningCount
      ? `${runningCount} 个实例正在连接`
      : '还没有账号在监听';

  return <div className="page-stack">
    <div className="connection-intro">
      <span className="connection-symbol"><Icon name="overview" size={25} /></span>
      <div>
        <h2>{slots ? headline : '运行概览'}</h2>
        <p>这里汇总 SnowLuma 与运行实例的状态；注入、监听和停止操作都在“实例与监听”完成。</p>
      </div>
      <Button variant="primary" icon="slots" onClick={() => onNavigate('instances')}>去实例与监听</Button>
      <Button variant="ghost" icon="settings" onClick={() => onNavigate('settings')}>连接设置</Button>
    </div>

    <AsyncBoundary
      loading={slotsLoading}
      error={slotsError}
      hasData={Boolean(slots)}
      onRetry={() => void refreshSlots()}
      loadingText="正在读取运行状态…"
      errorPrefix="运行状态读取失败"
    >
      <div className="stat-strip">
        <div className="stat"><span>QQ 进程</span><strong>{processes.data ? processes.data.processes.length : '—'}</strong></div>
        <div className="stat"><span>活动实例</span><strong>{runningCount}</strong></div>
        <div className="stat"><span>在线账号</span><strong>{onlineCount}</strong></div>
        <div className="stat"><span>可恢复监听</span><strong>{resumableCount}</strong></div>
      </div>

      <Card title="SnowLuma 管理服务" actions={<Button size="sm" variant="ghost" icon="refresh" disabled={runtime.loading} onClick={() => void runtime.refresh()}>刷新</Button>}>
        <SnowLumaStatusTags status={runtime.data?.runtime} />
        {runtime.data?.runtime && !runtime.data.runtime.running ? <p className="muted">需要先在“实例与监听”页按提示手动启动 SnowLuma；应用不会下载或启动它。</p> : null}
        {runtime.error ? <ErrorNote message={`无法读取 SnowLuma 状态：${runtime.error}`} onRetry={() => void runtime.refresh()} /> : null}
      </Card>

      <Card title="运行实例" subtitle="完整连接与停止操作在“实例与监听”。" actions={<Button size="sm" icon="slots" onClick={() => onNavigate('instances')}>管理实例</Button>}>
        {instances.length ? <div className="connection-detail-list">{instances.map((instance) => <div className="connection-detail" key={instance.id}>
          <span><strong>{instance.accountNickname || (instance.accountId ? `QQ ${instance.accountId}` : instance.id)}</strong><small className="muted">{instance.accountId ? `QQ ${instance.accountId} · ${instance.id}` : instance.id}</small></span>
          <StatePill state={instance.state} />
        </div>)}</div> : <p className="muted">还没有运行实例。在“实例与监听”中注入并开始监听后，账号会出现在这里。</p>}
      </Card>
    </AsyncBoundary>

    <Card title="账号准备" subtitle="连接后，为需要互动的群聊和私聊单独绑定角色，再选择账号模型。">
      <div className="connection-shortcuts">
        <Button icon="accounts" onClick={() => onNavigate('roles')}>资料与角色</Button>
        <Button icon="bolt" onClick={() => onNavigate('model-config')}>模型配置</Button>
        <Button icon="artifacts" onClick={() => onNavigate('artifacts')}>资源库</Button>
      </div>
    </Card>
  </div>;
}
