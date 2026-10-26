import { useState } from 'react';
import { apiBaseUrl, appPlatform, appVersion } from '../api';
import { usePoll } from '../hooks';
import { applyMotionPreference, readMotionPreference, type MotionPreference } from '../preferences';
import type { Diagnostics } from '../types';
import { Button, Card, ErrorNote, Field, Icon, IconButton, Select, Tag, copyText, formatDateTime } from '../ui';
import { SnowLumaSetup } from '../components/SnowLumaSetup';

export function SettingsPage({
  section = 'snowluma'
}: {
  section?: 'appearance' | 'snowluma' | 'diagnostics';
}) {
  const diagnostics = usePoll<Diagnostics>('/diagnostics', 10000);
  const [copied, setCopied] = useState<string>();
  const [motionPreference, setMotionPreference] = useState<MotionPreference>(readMotionPreference);

  const data = diagnostics.data;
  const limits = data ? Object.entries(data.limits) : [];
  const metrics = data ? Object.entries(data.metrics) : [];
  const accountLeases = data ? Object.entries(data.accounts) : [];
  const desired = data ? Object.entries(data.desired) : [];
  const copy = async (label: string, value: string): Promise<void> => {
    if (await copyText(value)) {
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 2000);
    }
  };

  return (
    <div className="page-stack">
      {section === 'diagnostics' && diagnostics.error ? (
        <ErrorNote message={diagnostics.error} onRetry={() => void diagnostics.refresh()} />
      ) : null}

      <section className="settings-section" aria-labelledby="appearance-heading" hidden={section !== 'appearance'}>
        <div className="settings-section-heading">
          <h2 id="appearance-heading">外观与动效</h2>
          <p>动效偏好保存在此设备；“跟随系统”会尊重操作系统的减少动态效果设置。</p>
        </div>
        <Card title="动效偏好" subtitle="减少非必要的动画、过渡和滚动动效。">
          <Field label="动效设置">
            <Select
              value={motionPreference}
              onChange={(event) => {
                const preference = event.target.value as MotionPreference;
                applyMotionPreference(preference);
                setMotionPreference(preference);
              }}
            >
              <option value="system">跟随系统</option>
              <option value="reduced">减少动效</option>
              <option value="full">完整动效</option>
            </Select>
          </Field>
          <p className="field-hint">当前系统偏好：{window.matchMedia('(prefers-reduced-motion: reduce)').matches ? '减少动效' : '标准动效'}。选择“完整动效”时会覆盖系统减少动效偏好。</p>
        </Card>
      </section>

      <section className="settings-section" aria-labelledby="connection-settings-heading" hidden={section !== 'snowluma'}>
        <div className="settings-section-heading">
          <h2 id="connection-settings-heading">连接</h2>
          <p>连接你手动启动的 SnowLuma；只有你明确点击后，应用才会注入 QQ 并开始监听。</p>
        </div>

      <SnowLumaSetup />
      </section>

      <section className="settings-section" aria-labelledby="runtime-settings-heading" hidden={section !== 'diagnostics'}>
        <div className="settings-section-heading">
          <h2 id="runtime-settings-heading">诊断</h2>
          <p>查看当前应用的运行信息、容量限制与诊断快照。</p>
        </div>
      <div className="settings-grid">
                <Card
          title="运行信息"
          subtitle="桌面端主进程内嵌 Core，UI 与控制面同源"
          actions={
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void diagnostics.refresh()}>
              刷新
            </Button>
          }
        >
          <dl className="detail-list">
            <div>
              <dt>版本</dt>
              <dd>
                <Tag tone="idle">{appVersion}</Tag>
                <span className="muted">{appPlatform}</span>
              </dd>
            </div>
            <div>
              <dt>数据根</dt>
              <dd>
                <code className="path-inline">{data?.dataRoot ?? '…'}</code>
                <IconButton type="button" icon={copied === 'root' ? 'check' : 'copy'} label="复制数据根路径" onClick={() => void copy('root', data?.dataRoot ?? '')} />
              </dd>
            </div>
            <div>
              <dt>控制面</dt>
              <dd>
                <code className="path-inline">{data?.apiUrl ?? apiBaseUrl}</code>
                <IconButton type="button" icon={copied === 'api' ? 'check' : 'copy'} label="复制控制面地址" onClick={() => void copy('api', data?.apiUrl ?? apiBaseUrl)} />
              </dd>
            </div>
            <div>
              <dt>公用制品</dt>
              <dd>
                <code className="path-inline">{data?.artifacts.publicRoot ?? '…'}</code>
              </dd>
            </div>
            <div>
              <dt>事件 ID</dt>
              <dd className="mono">{data?.latestEventId ?? '—'}</dd>
            </div>
            <div>
              <dt>凭据保护</dt>
              <dd>
                <Tag tone={data?.phase1?.vault.available ? 'ok' : 'warn'}>
                  {data?.phase1?.vault.available ? '可用' : '不可用'}
                </Tag>
                <span className="muted mono">{data?.phase1?.vault.kind ?? 'unknown'}</span>
              </dd>
            </div>
            <div>
              <dt>模型配置</dt>
              <dd>
                <code className="path-inline">{data?.phase1?.configFile ?? 'config.v2.json'}</code>
                <span className="muted mono">v{data?.phase1?.configVersion ?? 0}</span>
              </dd>
            </div>
            <div>
              <dt>配置指纹</dt>
              <dd className="mono">{data?.phase1?.configFingerprint ?? '—'}</dd>
            </div>
            <div>
              <dt>当前时间</dt>
              <dd className="mono">{formatDateTime(Date.now())}</dd>
            </div>
          </dl>
          <div className="settings-note">
            <Icon name="shield" size={15} />
            <span>控制面只监听 127.0.0.1，token 每次启动随机生成，只注入到渲染进程。</span>
          </div>
          <div className="settings-note">
            <Icon name="folder" size={15} />
            <span>关闭窗口只会最小化到托盘。需要完全退出请使用托盘菜单的「退出」，主进程会先排空实例再结束。</span>
          </div>
        </Card>

        <Card title="容量限制" subtitle="所有队列、SSE 与消息体都有显式上限">
          <div className="limit-grid">
            {limits.length === 0 ? <span className="muted">读取中…</span> : null}
            {limits.map(([key, value]) => (
              <div className="limit-item" key={key}>
                <span className="meta-label">{key}</span>
                <span className="mono">{value}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="账号租约" subtitle="同一 QQ 号同时只能被一个槽位持有">
          {accountLeases.length === 0 ? (
            <p className="muted">当前没有账号租约。</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>QQ</th>
                    <th>槽位</th>
                  </tr>
                </thead>
                <tbody>
                  {accountLeases.map(([accountId, instanceId]) => (
                    <tr key={accountId}>
                      <td className="mono">{accountId}</td>
                      <td>{instanceId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="期望状态" subtitle="人工 stop 会持久化，进程重启不会自动拉起">
          {desired.length === 0 ? (
            <p className="muted">当前没有持久化的实例意图。</p>
          ) : (
            <div className="chip-row">
              {desired.map(([instanceId, state]) => (
                <span className="chip" key={instanceId}>
                  {instanceId}
                  <Tag tone={state === 'running' ? 'ok' : 'idle'}>{state}</Tag>
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="Runtime" subtitle="同一 runtimeDir 的实例共享 backend，带引用计数与熔断隔离">
          <pre className="snippet snippet-tall">
            {data ? JSON.stringify(data.runtimes, null, 2) : '读取中…'}
          </pre>
        </Card>

        <Card title="指标" subtitle="本次进程内累计">
          {metrics.length === 0 ? (
            <p className="muted">还没有指标。</p>
          ) : (
            <div className="metric-list">
              {metrics.map(([key, value]) => (
                <div className="metric-row" key={key}>
                  <span className="mono">{key}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="后续阶段范围" subtitle="这些功能尚未实现，本页面不提供会“保存成功但不起作用”的入口">
          <div className="roadmap-list">
            <div className="roadmap-row">
              <Tag tone="idle">未实现</Tag>
              <div>
                <strong>世界书 / 设定触发</strong>
                <p className="muted">触发条件、预算与冲突处理尚未定稿；当前只使用角色卡与受限历史。</p>
              </div>
            </div>
            <div className="roadmap-row">
              <Tag tone="idle">未实现</Tag>
              <div>
                <strong>长期记忆</strong>
                <p className="muted">记忆提取、检索与修正不在第一阶段；账号之间不会共享对话经历。</p>
              </div>
            </div>
            <div className="roadmap-row">
              <Tag tone="idle">未实现</Tag>
              <div>
                <strong>受管 QQ launch</strong>
                <p className="muted">当前管理已运行的 SnowLuma runtime 连接，不负责启动或接管 QQ 客户端。</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card title="诊断快照" subtitle="包含审计记录、实例与部署的完整 JSON">
        <details className="inline-details">
          <summary>展开原始诊断</summary>
          <pre className="snippet snippet-tall">{data ? JSON.stringify(data, null, 2) : '读取中…'}</pre>
        </details>
      </Card>
      </section>
    </div>
  );
}
