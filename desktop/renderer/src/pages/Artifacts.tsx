import { useMemo, useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type {
  ArtifactItem,
  ArtifactsResponse,
  DeploymentRecord,
  DeploymentsResponse,
  Diagnostics
} from '../types';
import { Button, Card, ConfirmButton, Empty, ErrorNote, Icon, Tag, copyText, formatDateTime, useConfirm } from '../ui';

interface ArtifactsPageProps {
  data?: ArtifactsResponse;
  error?: string;
  refresh: () => Promise<void>;
}

interface ArtifactGroup {
  kind: 'plugin' | 'role-card';
  id: string;
  name: string;
  description?: string;
  items: ArtifactItem[];
  current?: string;
}

function groupArtifacts(data?: ArtifactsResponse): ArtifactGroup[] {
  if (!data) return [];
  const groups = new Map<string, ArtifactGroup>();
  for (const item of data.artifacts) {
    const key = `${item.manifest.kind}:${item.ref.id}`;
    const group = groups.get(key) ?? {
      kind: item.manifest.kind,
      id: item.ref.id,
      name: item.manifest.name ?? item.ref.id,
      ...(item.manifest.description ? { description: item.manifest.description } : {}),
      items: []
    };
    group.items.push(item);
    if (item.manifest.name) group.name = item.manifest.name;
    if (item.manifest.description) group.description = item.manifest.description;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.current = data.current[`${group.kind}:${group.id}`];
    group.items.sort((left, right) => {
      if (left.ref.revision === group.current) return -1;
      if (right.ref.revision === group.current) return 1;
      return right.ref.revision.localeCompare(left.ref.revision);
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'role-card' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function deploymentSummary(record: DeploymentRecord): string {
  const updated = record.entries.filter((entry) => entry.status === 'updated').length;
  const skipped = record.entries.filter((entry) => entry.status === 'skipped').length;
  const failed = record.entries.filter((entry) => entry.status === 'failed').length;
  return `更新 ${updated} · 跳过 ${skipped} · 失败 ${failed}`;
}

export function ArtifactsPage({ data, error, refresh }: ArtifactsPageProps) {
  const groups = useMemo(() => groupArtifacts(data), [data]);
  const deployments = usePoll<DeploymentsResponse>('/deployments', 8000);
  const diagnostics = usePoll<Diagnostics>('/diagnostics', 15000);
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const confirm = useConfirm();

  const publicRoot = diagnostics.data?.artifacts.publicRoot;

  const deploy = async (group: ArtifactGroup, revision: string): Promise<void> => {
    if (!(await confirm({
      title: '部署制品版本',
      description: `部署 ${group.kind}:${group.id}@${revision}？所有已绑定账号会按顺序滚动切换，单个失败会保留旧版本。`,
      confirmLabel: '部署'
    }))) {
      return;
    }
    setBusy(`${group.kind}:${group.id}@${revision}`);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const result = await api<{ deployment: DeploymentRecord }>(
        `/artifacts/${group.kind}/${encodeURIComponent(group.id)}/deploy`,
        { method: 'POST', body: JSON.stringify({ revision }) }
      );
      setNotice(
        `部署完成：${deploymentSummary(result.deployment)}${result.deployment.ok ? '' : '，部分账号保留了旧版本。'}`
      );
    } catch (deployError) {
      setActionError(errorMessage(deployError));
    } finally {
      setBusy(undefined);
      await Promise.all([refresh(), deployments.refresh()]);
    }
  };

  const rollback = async (): Promise<void> => {
    if (!(await confirm({
      title: '回滚公用制品目录',
      description: '回滚到上一个 catalog 快照？回滚同样会滚动应用到所有账号。',
      confirmLabel: '回滚目录',
      tone: 'danger'
    }))) return;
    setBusy('rollback');
    setActionError(undefined);
    setNotice(undefined);
    try {
      const result = await api<{ deployment: DeploymentRecord }>('/artifacts/rollback', { method: 'POST' });
      setNotice(`回滚完成：${deploymentSummary(result.deployment)}`);
    } catch (rollbackError) {
      setActionError(errorMessage(rollbackError));
    } finally {
      setBusy(undefined);
      await Promise.all([refresh(), deployments.refresh()]);
    }
  };

  return (
    <div className="page-stack">
      <div className="banner">
        <Icon name="package" size={18} />
        <div>
          <strong>公用层只做制品分发，实例之间没有互相调用。</strong>
          <span>
            角色卡和插件都通过 catalog 指向当前 revision。部署会先验证每个账号的解析结果，再逐个切到新 worker；失败账号保留 last-known-good。
          </span>
        </div>
        <div className="banner-actions">
          <Button variant="ghost" icon="refresh" onClick={() => void refresh()}>
            刷新
          </Button>
          <ConfirmButton variant="danger" icon="activity" busy={busy === 'rollback'} onClick={() => void rollback()}>
            回滚目录
          </ConfirmButton>
        </div>
      </div>

      {error ? <ErrorNote message={error} onRetry={() => void refresh()} /> : null}
      {actionError ? <ErrorNote message={actionError} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <Card
        title="公用制品目录"
        subtitle="catalog.json 记录每个制品当前生效的 revision"
        actions={
          publicRoot ? (
            <Button size="sm" icon="copy" onClick={() => void copyText(publicRoot)}>
              复制路径
            </Button>
          ) : null
        }
      >
        <code className="path-block">{publicRoot ?? '正在读取…'}</code>
      </Card>

      {groups.length === 0 ? (
        <Card>
          <Empty
            icon="package"
            title="公用层还没有制品"
            description={
              <>
                把角色卡或插件放入下面的目录结构，刷新后即可在此部署。
                <pre className="snippet">{`public/
├─ catalog.json
└─ artifacts/
   ├─ role-card/<id>/<revision>/manifest.json
   └─ plugin/<id>/<revision>/manifest.json`}</pre>
              </>
            }
            action={
              <Button icon="refresh" onClick={() => void refresh()}>
                重新扫描
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="artifact-grid">
          {groups.map((group) => {
            const key = `${group.kind}:${group.id}`;
            const currentItem = group.items.find((item) => item.ref.revision === group.current);
            const manifest = currentItem?.manifest;
            return (
              <Card key={key} className="artifact-card">
                <div className="artifact-head">
                  <div>
                    <div className="artifact-kind-row">
                      <Tag tone={group.kind === 'role-card' ? 'ok' : 'idle'}>
                        {group.kind === 'role-card' ? '角色卡' : '插件'}
                      </Tag>
                      <span className="mono muted">{group.id}</span>
                    </div>
                    <h3>{group.name}</h3>
                    {group.description ? <p className="artifact-desc">{group.description}</p> : null}
                  </div>
                  <div className="artifact-current">
                    <span className="meta-label">当前版本</span>
                    <span className="mono">{group.current ?? '未部署'}</span>
                  </div>
                </div>

                {manifest?.kind === 'role-card' && manifest.content ? (
                  <p className="role-preview role-preview-tall">{manifest.content}</p>
                ) : null}
                {manifest?.kind === 'plugin' ? (
                  <div className="artifact-meta">
                    <span>
                      entry <code>{manifest.entry ?? '—'}</code>
                    </span>
                    <span>
                      apiVersion <code>{manifest.apiVersion ?? 1}</code>
                    </span>
                  </div>
                ) : null}

                <div className="revision-list">
                  {group.items.map((item) => {
                    const isCurrent = item.ref.revision === group.current;
                    const busyKey = `${group.kind}:${group.id}@${item.ref.revision}`;
                    return (
                      <div className={`revision-row${isCurrent ? ' is-current' : ''}`} key={item.ref.revision}>
                        <div className="revision-name">
                          <Icon name={isCurrent ? 'check' : 'package'} size={15} />
                          <span className="mono">{item.ref.revision}</span>
                          {isCurrent ? <Tag tone="ok">生效中</Tag> : null}
                        </div>
                        <div className="revision-actions">
                          <details className="inline-details">
                            <summary>manifest</summary>
                            <pre className="snippet">{JSON.stringify(item.manifest, null, 2)}</pre>
                          </details>
                          <ConfirmButton
                            size="sm"
                            variant={isCurrent ? 'ghost' : 'primary'}
                            disabled={isCurrent}
                            busy={busy === busyKey}
                            onClick={() => void deploy(group, item.ref.revision)}
                          >
                            {isCurrent ? '当前版本' : '部署'}
                          </ConfirmButton>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card
        title="部署记录"
        subtitle="滚动部署按账号串行执行；失败账号不会切断旧 worker"
        actions={
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void deployments.refresh()}>
            刷新
          </Button>
        }
      >
        {deployments.error ? <ErrorNote message={deployments.error} /> : null}
        {!deployments.data?.deployments.length ? (
          <p className="muted">本次会话还没有部署记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>动作</th>
                  <th>结果</th>
                  <th>明细</th>
                </tr>
              </thead>
              <tbody>
                {[...deployments.data.deployments].reverse().slice(0, 12).map((record) => (
                  <tr key={record.id}>
                    <td className="mono">{formatDateTime(record.startedAt)}</td>
                    <td>{record.action}</td>
                    <td>
                      <Tag tone={record.ok ? 'ok' : 'warn'}>{record.ok ? '全部成功' : '部分失败'}</Tag>
                    </td>
                    <td>
                      <div className="deploy-entries">
                        {record.entries.length === 0 ? <span className="muted">无目标</span> : null}
                        {record.entries.map((entry) => (
                          <span className="deploy-entry" key={entry.instanceId}>
                            <span className="mono">{entry.instanceId}</span>
                            <Tag tone={entry.status === 'updated' ? 'ok' : entry.status === 'failed' ? 'bad' : 'idle'}>
                              {entry.status === 'updated' ? '已更新' : entry.status === 'failed' ? '失败' : '跳过'}
                            </Tag>
                            {entry.toRevision ? <span className="muted mono">→ {entry.toRevision}</span> : null}
                            {entry.error ? <span className="inline-error">{entry.error}</span> : null}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
