import { useMemo, useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type {
  ArtifactItem,
  ArtifactManifest,
  ArtifactsResponse,
  DeploymentRecord,
  DeploymentsResponse,
  Diagnostics
} from '../types';
import { AsyncBoundary, Button, Card, ConfirmButton, Empty, ErrorNote, Icon, LoadingNote, Tag, copyText, formatDateTime, useConfirm } from '../ui';
import { deploymentActionLabel } from '../lib/labels';
import { ArtifactImport } from '../components/ArtifactImport';
import { WorldbookLibrary } from '../components/WorldbookLibrary';

interface ArtifactsPageProps {
  locked?: boolean;
  data?: ArtifactsResponse;
  loading: boolean;
  error?: string;
  refresh: () => Promise<void>;
}

interface ArtifactGroup {
  kind: ArtifactManifest['kind'];
  id: string;
  name: string;
  description?: string;
  items: ArtifactItem[];
  current?: string;
}

const KIND_LABELS: Record<ArtifactManifest['kind'], string> = { 'role-card': '角色卡', plugin: '插件', worldbook: '世界书' };

function groupArtifacts(data?: ArtifactsResponse): ArtifactGroup[] {
  if (!data) return [];
  const groups = new Map<string, ArtifactGroup>();
  for (const item of data.artifacts) {
    if (item.manifest.kind === 'worldbook') continue;
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

export function ArtifactsPage({ data, loading, error, refresh, locked = false }: ArtifactsPageProps) {
  const groups = useMemo(() => groupArtifacts(data), [data]);
  const deployments = usePoll<DeploymentsResponse>('/deployments', 8000);
  const diagnostics = usePoll<Diagnostics>('/diagnostics', 15000);
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [worldbookReload, setWorldbookReload] = useState(0);
  const confirm = useConfirm();

  const publicRoot = diagnostics.data?.artifacts.publicRoot;

  const deploy = async (group: ArtifactGroup, revision: string): Promise<void> => {
    if (!(await confirm({
      title: '部署资源版本',
      description: `部署${KIND_LABELS[group.kind]}「${group.name}」的版本 ${revision}？部署会逐个账号切换；失败的账号会继续使用旧版本。`,
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
      title: '回滚公用资源目录',
      description: '回滚到上一个资源目录快照？回滚同样会逐个账号应用，失败的账号会继续使用旧版本。',
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
          <strong>公用资源只负责分发，正在运行的账号不会互相调用。</strong>
          <span>部署新版本时会逐个账号切换；单个账号失败会继续保留它的旧版本。详细结果见下方部署记录。</span>
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

      {actionError ? <ErrorNote message={actionError} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}

      <ArtifactImport refresh={refresh} disabled={Boolean(busy)} locked={locked} onImported={(kind) => { if (kind === 'worldbook') setWorldbookReload((value) => value + 1); }} />

      <WorldbookLibrary reloadKey={worldbookReload} locked={locked} />

      <Card
        title="公用资源目录"
        subtitle="这里记录每个角色卡和插件当前生效的版本；独立世界书使用固定版本，不参与部署"
        actions={
          publicRoot ? (
            <Button size="sm" icon="copy" onClick={() => void copyText(publicRoot)}>
              复制路径
            </Button>
          ) : null
        }
      >
        {publicRoot ? <code className="path-block">{publicRoot}</code> : diagnostics.error ? (
          <ErrorNote message={`无法读取公用资源目录：${diagnostics.error}`} onRetry={() => void diagnostics.refresh()} />
        ) : <LoadingNote label="正在读取公用资源目录…" />}
      </Card>

      <AsyncBoundary
        loading={loading}
        error={error}
        hasData={Boolean(data)}
        onRetry={() => void refresh()}
        loadingText="正在读取资源…"
        errorPrefix="资源读取失败"
      >
        {groups.length === 0 ? (
          <Card>
            <Empty
              icon="package"
              title="还没有公用资源"
              description={
                <>
                  使用上方“导入资源”选择包含 manifest.json 的单个版本目录，预览并确认后即可在这里查看。导入后需要另行部署，不会自动绑定账号。也可打开资源目录查看已导入文件。
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
                      <Tag tone={group.kind === 'role-card' ? 'ok' : 'idle'}>{KIND_LABELS[group.kind]}</Tag>
                      <span className="mono muted">{group.id}</span>
                    </div>
                    <h3>{group.name}</h3>
                    {group.description ? <p className="artifact-desc">{group.description}</p> : null}
                  </div>
                  <div className="artifact-current">
                    <span className="meta-label">当前版本</span>
                    <span className="mono">{group.kind === 'worldbook' ? '不参与部署' : group.current ?? '未部署'}</span>
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
                          {group.kind === 'worldbook' ? (
                            <span className="muted">固定版本，需在会话中选择</span>
                          ) : (
                            <ConfirmButton
                              size="sm"
                              variant={isCurrent ? 'ghost' : 'primary'}
                              disabled={isCurrent}
                              busy={busy === busyKey}
                              onClick={() => void deploy(group, item.ref.revision)}
                            >
                              {isCurrent ? '当前版本' : '部署'}
                            </ConfirmButton>
                          )}
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
      </AsyncBoundary>

      <Card
        title="部署记录"
        subtitle="部署按账号依次执行；失败的账号会继续使用旧版本"
        actions={
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void deployments.refresh()}>
            刷新
          </Button>
        }
      >
        {deployments.error ? <ErrorNote message={deployments.error} onRetry={() => void deployments.refresh()} /> : null}
        {!deployments.data ? (
          deployments.loading ? <LoadingNote label="正在读取部署记录…" /> : deployments.error ? null : <p className="muted">本次会话还没有部署记录。</p>
        ) : !deployments.data.deployments.length ? (
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
                    <td>{deploymentActionLabel(record.action)}</td>
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
