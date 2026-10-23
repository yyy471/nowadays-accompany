import { useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type { InjectionOperationResponse, InjectionProcessesResponse, InjectionResumeResponse, InjectionRuntimeResponse, SlotsResponse, SnowLumaProcess } from '../types';
import { Button, Card, ConfirmButton, Empty, ErrorNote, Icon, StatePill, useConfirm } from '../ui';
import { AccountAvatar } from '../components/AccountAvatar';

export function QqConnections({ data, error, refresh, onSettings }: {
  data?: SlotsResponse; error?: string; refresh: () => Promise<void>; onSettings?: () => void;
}) {
  const runtime = usePoll<InjectionRuntimeResponse>('/injection/runtime', 5000);
  const processes = usePoll<InjectionProcessesResponse>('/injection/processes?avatars=1', 5000);
  const [busy, setBusy] = useState<string>();
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const confirm = useConfirm();
  const status = runtime.data?.runtime;
  const instances = data?.slots ?? [];
  const resumable = data?.resumable ?? [];
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
    const expectedAccountId = process.uin ?? process.accountHint?.uin;
    const result = await api<InjectionOperationResponse>(`/injection/processes/${process.pid}/${action}`, {
      method: 'POST', body: JSON.stringify({
        identity: { pid: process.pid, ...(process.path ? { path: process.path } : {}), ...(process.uin ? { uin: process.uin } : {}) },
        ...((action === 'listen' || action === 'inject-and-listen') && expectedAccountId ? { expectedAccountId } : {})
      })
    });
    if (result.operation.state !== 'succeeded') throw new Error(result.operation.error?.message ?? '操作失败，请刷新进程后重试');
    return result.operation;
  }

  function connect(process: SnowLumaProcess) {
    const action = process.injected || process.connected ? 'listen' : 'inject-and-listen';
    void run(`connect-${process.pid}`, async () => {
      const operation = await operate(process, action);
      setNotice(`${operation.result?.uin ? `QQ ${operation.result.uin}` : accountLabel(process)} 已开始监听，已按账号匹配本地数据。请为需要回复的群聊和私聊绑定角色卡。`);
    });
  }

  function refreshConnection(process: SnowLumaProcess) {
    void run(`refresh-${process.pid}`, async () => {
      await operate(process, 'refresh');
      setNotice(`已刷新 ${accountLabel(process)} 的连接状态。`);
    });
  }

  async function unload(process: SnowLumaProcess) {
    const label = accountLabel(process);
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

  function resumeLastListening() {
    void run('resume', async () => {
      const result = await api<InjectionResumeResponse>('/injection/resume', { method: 'POST' });
      if (result.resumed.length > 0) {
        setNotice(`已恢复 ${result.resumed.length} 个账号的监听${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ''}。`);
        return;
      }
      const reason = result.skipped[0]?.reason;
      setNotice(reason === 'not_injected'
        ? '对应 QQ 尚未注入，请先在进程卡片中注入。'
        : reason === 'process_not_found'
          ? '没有发现账号已登录的 QQ 进程。'
          : '没有可恢复的监听记录。');
    });
  }

  return <div className="page-stack">
    <div className="connection-intro">
      <span className="connection-symbol"><Icon name="radio" size={25} /></span>
      <div><h2>选择一个 QQ，开始陪伴</h2><p>打开并登录 QQ，在这里点击连接。账号识别、数据匹配和运行实例由应用管理。</p></div>
      <Button icon="refresh" disabled={Boolean(busy)} onClick={() => void run('refresh', async () => {})}>刷新账号</Button>
    </div>
    <div className="connection-service">
      <div className="connection-service-actions">
        {resumable.length > 0 && status?.running ? <Button size="sm" variant="ghost" icon="refresh" disabled={Boolean(busy)} busy={busy === 'resume'} onClick={resumeLastListening}>恢复上次监听</Button> : null}
        {onSettings ? <Button size="sm" variant="ghost" icon="settings" onClick={onSettings}>连接设置</Button> : <a href="#/settings">连接设置</a>}
      </div>
    </div>
    {!status?.running && !runtime.loading ? <div className="notice"><Icon name="folder" size={18}/><span>请先<a href="https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.22" target="_blank" rel="noreferrer">从 SnowLuma 官方发行页</a>获取 1.14.22 完整包并手动启动 SnowLuma，在官方界面完成初始化后返回这里刷新。应用不会下载或启动 SnowLuma；QQ 仍由你启动，注入与监听需要你明确点击。</span></div> : null}
    {status?.consentRequired ? <div className="notice"><Icon name="shield" size={18}/><span>SnowLuma 尚未获得用户协议与隐私政策同意。请先在 SnowLuma 自己的界面完成确认，再回到这里刷新；应用不会代你同意。</span></div> : null}
    {status?.autoLoadEnabled ? <div className="notice"><Icon name="warning" size={18}/><span>SnowLuma 的自动加载已开启。为避免重复注入，请先在 SnowLuma 配置中关闭自动加载，再从应用内连接。</span></div> : null}
    {status?.error ? <ErrorNote message={status.error} /> : null}
    {runtime.error ? <ErrorNote message={runtime.error} onRetry={() => void runtime.refresh()} /> : null}
    {processes.error && status?.configured ? <ErrorNote message={`暂时无法读取 QQ 进程：${processes.error}`} onRetry={() => void processes.refresh()} /> : null}
    {error ? <ErrorNote message={error} /> : null}
    {failure ? <ErrorNote message={failure} /> : null}
    {notice ? <div className="notice notice-ok" role="status"><Icon name="check" size={16}/><span>{notice}</span></div> : null}
    <Card title="可连接的 QQ">
      {processes.loading && !processes.data ? <p className="muted" role="status">正在检测 QQ 进程…</p> : !(processes.data?.processes.length) ? <Empty icon="user" title={status?.running ? '暂未发现 QQ 进程' : '等待 SnowLuma 管理服务'} description={status?.running ? '请先打开并登录 QQ，然后刷新进程列表。进程发现不会自动注入。' : '手动启动 SnowLuma 官方服务后，返回这里刷新以检测 QQ 进程。'} /> : <div className="connection-grid">
        {processes.data.processes.map((process, index) => {
          const instance = instances.find((item) => item.id === process.instanceId && !['stopped', 'failed'].includes(item.state));
          const injected = process.injected || process.connected;
          const accountId = process.uin ?? process.accountHint?.uin;
          const nickname = instance?.accountNickname ?? process.nickname ?? process.displayName;
          return <article className="qq-process-card" key={process.pid}>
            <div className="qq-process-heading">
              <AccountAvatar dataUrl={process.avatarDataUrl} label={`${nickname || (accountId ? `QQ ${accountId}` : `QQ ${index + 1}`)} 头像`} className="qq-process-avatar" iconSize={26}/>
              <div><h3>{nickname || (accountId ? `QQ ${accountId}` : `待识别的 QQ ${index + 1}`)}</h3><span className="muted">{accountId ? `QQ ${accountId}` : '暂未读取到账号信息'}</span></div>
              {instance ? <StatePill state={instance.state}/> : <Button variant="primary" icon="play" disabled={Boolean(busy) || !ready} busy={busy === `connect-${process.pid}`} onClick={() => connect(process)}>{injected ? '开始监听' : '注入并监听'}</Button>}
            </div>
            {instance ? <p className="muted">正在管理此账号的连接。</p> : !accountId ? <p className="muted">请确认 QQ 已登录。连接后将重新识别账号，不会按未知账号创建资料。</p> : null}
            {process.error ? <p className="inline-error">{process.error}</p> : null}
            {instance || injected ? <div className="qq-process-actions">
              {instance ? <Button icon="stop" disabled={Boolean(busy)} busy={busy === `stop-${instance.id}`} onClick={() => stop(instance.id)}>停止监听</Button> : null}
              {injected ? <Button variant="ghost" icon="refresh" disabled={Boolean(busy)} busy={busy === `refresh-${process.pid}`} onClick={() => refreshConnection(process)}>刷新状态</Button> : null}
              {process.injected ? <ConfirmButton variant="ghost" icon="close" disabled={Boolean(busy)} busy={busy === `unload-${process.pid}`} onClick={() => void unload(process)}>卸载注入</ConfirmButton> : null}
            </div> : null}
            <details className="qq-process-diagnostics"><summary>诊断详情</summary><p className="qq-process-path">PID {process.pid}<br/>{process.path ?? process.name ?? 'QQ 客户端'}</p></details>
          </article>;
        })}
      </div>}
    </Card>
    {instances.length ? <details className="connection-details"><summary>连接详情 · {instances.length} 个运行实例</summary><div className="connection-detail-list">{instances.map((instance) => <div className="connection-detail" key={instance.id}><span><strong>{instance.accountId ? `QQ ${instance.accountId}` : instance.id}</strong><small className="muted">{instance.id} · {instance.backend}</small></span><StatePill state={instance.state}/><Button size="sm" disabled={Boolean(busy)} onClick={() => stop(instance.id)}>停止 / 释放</Button></div>)}</div></details> : null}
  </div>;
}

function accountLabel(process: SnowLumaProcess): string {
  const uin = process.uin ?? process.accountHint?.uin;
  return process.nickname || process.displayName || (uin ? `QQ ${uin}` : '此 QQ');
}
