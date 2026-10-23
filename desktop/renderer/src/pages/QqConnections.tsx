import { useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type { InjectionOperationResponse, InjectionProcessesResponse, InjectionRuntimeResponse, SlotsResponse, SnowLumaProcess } from '../types';
import { Button, Card, ConfirmButton, Empty, ErrorNote, Icon, StatePill, Tag, useConfirm } from '../ui';

export function QqConnections({ data, error, refresh, onSettings }: {
  data?: SlotsResponse; error?: string; refresh: () => Promise<void>; onSettings?: () => void;
}) {
  const runtime = usePoll<InjectionRuntimeResponse>('/injection/runtime', 5000);
  const processes = usePoll<InjectionProcessesResponse>('/injection/processes', 5000);
  const [busy, setBusy] = useState<string>();
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const confirm = useConfirm();
  const status = runtime.data?.runtime;
  const instances = data?.slots ?? [];
  const ready = Boolean(status?.running && status.compatible && status.passwordConfigured && status.autoLoadKnown && !status.autoLoadEnabled && !status.consentRequired);

  async function run(key: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(key); setFailure(undefined); setNotice(undefined);
    try { await action(); }
    catch (error) { setFailure(errorMessage(error)); }
    finally {
      await Promise.all([refresh(), processes.refresh(), runtime.refresh()]);
      busyRef.current = false; setBusy(undefined);
    }
  }

  async function operate(process: SnowLumaProcess, action: InjectionOperationResponse['operation']['action']) {
    const result = await api<InjectionOperationResponse>(`/injection/processes/${process.pid}/${action}`, {
      method: 'POST', body: JSON.stringify({ identity: { pid: process.pid, ...(process.path ? { path: process.path } : {}), ...(process.uin ? { uin: process.uin } : {}) } })
    });
    if (result.operation.state !== 'succeeded') throw new Error(result.operation.error?.message ?? '操作失败，请刷新进程后重试');
    return result.operation;
  }

  function connect(process: SnowLumaProcess) {
    const action = process.injected || process.connected ? 'listen' : 'inject-and-listen';
    void run(`connect-${process.pid}`, async () => {
      const operation = await operate(process, action);
      setNotice(`QQ ${operation.result?.uin ?? process.uin ?? process.pid} 已开始监听，已按账号匹配本地数据。请为需要回复的群聊和私聊绑定角色卡。`);
    });
  }

  function refreshConnection(process: SnowLumaProcess) {
    void run(`refresh-${process.pid}`, async () => {
      await operate(process, 'refresh');
      setNotice(`已刷新 QQ ${process.uin ?? process.pid} 的注入状态。`);
    });
  }

  async function unload(process: SnowLumaProcess) {
    const label = process.uin ? `QQ ${process.uin}` : `PID ${process.pid}`;
    if (!(await confirm({
      title: '卸载 QQ 注入',
      description: `卸载 ${label} 的注入？卸载会停止此账号的监听并移除注入；本地账号资料与聊天历史保留，之后可以重新注入。`,
      confirmLabel: '卸载注入',
      tone: 'danger'
    }))) return;
    void run(`unload-${process.pid}`, async () => {
      await operate(process, 'unload');
      setNotice('已停止监听并卸载注入，账号资料与历史已保留。');
    });
  }

  function stop(id: string) {
    void run(`stop-${id}`, async () => {
      await api(`/instances/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      setNotice('已停止监听并释放运行实例；QQ 中仍保留注入，可在进程卡片中卸载。账号资料与历史已保留。');
    });
  }

  return <div className="page-stack">
    <div className="connection-intro">
      <span className="connection-symbol"><Icon name="radio" size={25} /></span>
      <div><h2>选择一个 QQ，开始陪伴</h2><p>打开并登录 QQ，在这里点击连接。账号识别、数据匹配和运行实例由应用管理。</p></div>
      <Button icon="refresh" disabled={Boolean(busy)} onClick={() => void run('refresh', async () => {})}>刷新进程</Button>
    </div>
    <div className="connection-service">
      <Tag tone={status?.running && !status.error ? 'ok' : 'warn'}>{status?.running ? 'SnowLuma 管理服务在线' : status?.configured ? 'SnowLuma 管理服务未运行' : '尚未连接 SnowLuma'}</Tag>
      <span className="muted">{status?.running ? '连接你已手动启动的服务' : '请先从官方入口手动启动 SnowLuma'}</span>
      <div className="connection-service-actions">
        {onSettings ? <Button size="sm" variant="ghost" icon="settings" onClick={onSettings}>连接设置</Button> : <a href="#/settings">连接设置</a>}
      </div>
    </div>
    {!status?.running && !runtime.loading ? <div className="notice"><Icon name="folder" size={18}/><span>请先<a href="https://github.com/SnowLuma/SnowLuma/releases" target="_blank" rel="noreferrer">从 SnowLuma 官方发行页</a>获取并手动启动 SnowLuma，在官方界面完成初始化后返回这里刷新。应用不会下载或启动 SnowLuma；QQ 仍由你启动，注入与监听需要你明确点击。</span></div> : null}
    {status?.consentRequired ? <div className="notice"><Icon name="shield" size={18}/><span>SnowLuma 尚未获得用户协议与隐私政策同意。请先在 SnowLuma 自己的界面完成确认，再回到这里刷新；应用不会代你同意。</span></div> : null}
    {status?.autoLoadEnabled ? <div className="notice"><Icon name="warning" size={18}/><span>SnowLuma 的自动加载已开启。为避免重复注入，请先在 SnowLuma 配置中关闭自动加载，再从应用内连接。</span></div> : null}
    {status?.error ? <ErrorNote message={status.error} /> : null}
    {runtime.error ? <ErrorNote message={runtime.error} onRetry={() => void runtime.refresh()} /> : null}
    {processes.error && status?.configured ? <ErrorNote message={`暂时无法读取 QQ 进程：${processes.error}`} onRetry={() => void processes.refresh()} /> : null}
    {error ? <ErrorNote message={error} /> : null}
    {failure ? <ErrorNote message={failure} /> : null}
    {notice ? <div className="notice notice-ok" role="status"><Icon name="check" size={16}/><span>{notice}</span></div> : null}
    <Card title="可连接的 QQ" subtitle="只展示 SnowLuma 确认的注入目标；发现进程不会自动注入。">
      {processes.loading && !processes.data ? <p className="muted" role="status">正在检测 QQ 进程…</p> : !(processes.data?.processes.length) ? <Empty icon="user" title={status?.running ? '暂未发现 QQ 进程' : '等待 SnowLuma 管理服务'} description={status?.running ? '请先打开并登录 QQ，然后刷新进程列表。进程发现不会自动注入。' : '手动启动 SnowLuma 官方服务后，返回这里刷新以检测 QQ 进程。'} /> : <div className="connection-grid">
        {processes.data.processes.map((process) => {
          const instance = instances.find((item) => item.id === process.instanceId && !['stopped', 'failed'].includes(item.state));
          const injected = process.injected || process.connected;
          return <article className="qq-process-card" key={process.pid}>
            <div className="qq-process-heading"><span className="qq-process-avatar"><Icon name="user" size={26}/></span><div><h3>{process.uin ? `QQ ${process.uin}` : '等待识别账号'}</h3><span className="muted mono">PID {process.pid}</span></div>{instance ? <StatePill state={instance.state}/> : <Tag tone={injected ? 'ok' : 'idle'}>{injected ? '已注入' : '可注入'}</Tag>}</div>
            <p className="qq-process-path" title={process.path}>{process.path ?? process.name ?? 'QQ 客户端'}</p>
            <p className="muted">{instance ? '正在管理此账号的连接。' : process.uin ? '连接后自动匹配此账号的角色、模型与历史。' : '连接后读取真实 QQ 号，再匹配账号资料。'}</p>
            {process.error ? <p className="inline-error">{process.error}</p> : null}
            <div className="qq-process-actions">
              {instance ? <Button icon="stop" disabled={Boolean(busy)} busy={busy === `stop-${instance.id}`} onClick={() => stop(instance.id)}>停止监听</Button> : <Button variant="primary" icon="play" disabled={Boolean(busy) || !ready} busy={busy === `connect-${process.pid}`} onClick={() => connect(process)}>{injected ? '开始监听' : '注入并监听'}</Button>}
              {injected ? <Button variant="ghost" icon="refresh" disabled={Boolean(busy)} busy={busy === `refresh-${process.pid}`} onClick={() => refreshConnection(process)}>刷新状态</Button> : null}
              {process.injected ? <ConfirmButton variant="ghost" icon="close" disabled={Boolean(busy)} busy={busy === `unload-${process.pid}`} onClick={() => void unload(process)}>卸载注入</ConfirmButton> : null}
            </div>
          </article>;
        })}
      </div>}
    </Card>
    {instances.length ? <details className="connection-details"><summary>连接详情 · {instances.length} 个运行实例</summary><div className="connection-detail-list">{instances.map((instance) => <div className="connection-detail" key={instance.id}><span><strong>{instance.accountId ? `QQ ${instance.accountId}` : instance.id}</strong><small className="muted">{instance.id} · {instance.backend}</small></span><StatePill state={instance.state}/><Button size="sm" disabled={Boolean(busy)} onClick={() => stop(instance.id)}>停止 / 释放</Button></div>)}</div></details> : null}
  </div>;
}
