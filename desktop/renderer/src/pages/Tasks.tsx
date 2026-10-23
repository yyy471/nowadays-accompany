import { useEffect, useMemo, useState } from 'react';
import { api, fetchMediaBlob } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type {
  AccountsResponse,
  JobDto,
  JobState,
  JobsResponse,
  MediaRef,
  MediaResponse
} from '../types';
import { Button, CancelButton, Card, ConfirmButton, Empty, ErrorNote, Icon, Select, Tag, formatDateTime, relativeTime, useConfirm } from '../ui';

const JOB_TONES: Record<JobState, string> = {
  queued: 'idle',
  running: 'busy',
  waiting_remote: 'warn',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'idle',
  interrupted: 'warn'
};

const JOB_LABELS: Record<JobState, string> = {
  queued: '排队',
  running: '运行中',
  waiting_remote: '等待远端',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};

const CAPABILITY_LABELS: Record<string, string> = {
  chat: '文字对话',
  'image.understand': '图片理解',
  'video.understand': '视频理解',
  'image.generate': '图片生成'
};

const TERMINAL: JobState[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TasksPage({ accounts }: { accounts?: AccountsResponse }) {
  const accountIds = useMemo(() => (accounts?.accounts ?? []).map((account) => account.accountId), [accounts]);
  const [mediaAccount, setMediaAccount] = useState('');
  const [jobAccount, setJobAccount] = useState('all');
  const [jobState, setJobState] = useState<'all' | JobState>('all');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const confirm = useConfirm();

  const jobs = usePoll<JobsResponse>('/jobs', 3_000);
  const media = usePoll<MediaResponse>(
    mediaAccount ? `/accounts/${encodeURIComponent(mediaAccount)}/media` : null,
    10_000
  );

  useEffect(() => {
    if (!mediaAccount && accountIds.length) setMediaAccount(accountIds[0]!);
    if (mediaAccount && !accountIds.includes(mediaAccount)) setMediaAccount(accountIds[0] ?? '');
  }, [accountIds, mediaAccount]);

  const cancel = async (job: JobDto): Promise<void> => {
    if (!(await confirm({ title: '取消媒体任务', description: `取消任务 ${job.id}？远端是否已取消会单独标注。`, confirmLabel: '取消任务' }))) return;
    setBusy(job.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await api<{ job: JobDto }>(`/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ accountId: job.accountId })
      });
      setNotice(
        response.job.state === 'cancelled'
          ? `任务 ${job.id} 已取消；远端取消状态：${response.job.remoteCancelled ? '已确认' : '未知/本地取消'}`
          : `任务 ${job.id} 已请求取消，等待执行器停止。`
      );
      await jobs.refresh();
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    } finally {
      setBusy(undefined);
    }
  };

  const removeMedia = async (item: MediaRef): Promise<void> => {
    if (!(await confirm({ title: '删除媒体文件', description: `删除媒体 ${item.mediaId}？运行中的任务引用会被保护，这里只删除已持久化文件。`, confirmLabel: '删除媒体', tone: 'danger' }))) return;
    setBusy(item.mediaId);
    setError(undefined);
    try {
      await api(`/accounts/${encodeURIComponent(item.accountId)}/media/${encodeURIComponent(item.mediaId)}`, {
        method: 'DELETE'
      });
      setNotice(`媒体 ${item.mediaId} 已删除。`);
      await media.refresh();
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setBusy(undefined);
    }
  };

  const cleanup = async (): Promise<void> => {
    if (!(await confirm({ title: '清理过期媒体', description: '按保留策略清理所有账号的过期媒体？正在被任务引用的文件会跳过。', confirmLabel: '清理过期媒体', tone: 'danger' }))) return;
    setBusy('cleanup');
    setError(undefined);
    try {
      const result = await api<{ deleted: number; skippedInUse: number; failed: number }>('/media/cleanup', {
        method: 'POST'
      });
      setNotice(`清理完成：删除 ${result.deleted}，跳过使用中 ${result.skippedInUse}，失败 ${result.failed}。`);
      await media.refresh();
      await jobs.refresh();
    } catch (cleanupError) {
      setError(errorMessage(cleanupError));
    } finally {
      setBusy(undefined);
    }
  };

  const visibleJobs = (jobs.data?.jobs ?? []).filter(
    (job) =>
      (jobAccount === 'all' || job.accountId === jobAccount) &&
      (jobState === 'all' || job.state === jobState)
  );
  const pendingJobs = (jobs.data?.jobs ?? []).filter((job) => !TERMINAL.includes(job.state)).length;

  return (
    <div className="page-stack">
      <div className="banner">
        <Icon name="clock" size={18} />
        <div>
          <strong>媒体任务与文字对话分开调度，结果仍经过原会话的统一发送出口。</strong>
          <span>
            任务状态和媒体引用都按账号隔离。本地取消不等于远端已取消；中断的任务不会自动重新提交。
          </span>
        </div>
      </div>

      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {jobs.error ? <ErrorNote message={jobs.error} onRetry={() => void jobs.refresh()} /> : null}

      <div className="stat-strip">
        <div className="stat">
          <span>进行中任务</span>
          <strong>{pendingJobs}</strong>
          <em>排队、运行与等待远端</em>
        </div>
        <div className="stat">
          <span>任务总数</span>
          <strong>{jobs.data?.jobs.length ?? 0}</strong>
          <em>按账号查询</em>
        </div>
        <div className="stat">
          <span>媒体文件</span>
          <strong>{media.data?.media.length ?? 0}</strong>
          <em>{mediaAccount || '未选择账号'}</em>
        </div>
        <div className="stat">
          <span>清理</span>
          <strong>{media.data?.media.filter((item) => item.expiresAt <= Date.now()).length ?? 0}</strong>
          <em>已过期条目</em>
        </div>
      </div>

      <Card
        title="媒体任务"
        subtitle="新任务和更新会实时出现在这里；取消遵循适配器声明，远端未知不会伪装成已取消。"
        actions={
          <>
            <Select aria-label="任务账号" value={jobAccount} onChange={(event) => setJobAccount(event.target.value)}>
              <option value="all">全部账号</option>
              {accountIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
            <Select aria-label="任务状态" value={jobState} onChange={(event) => setJobState(event.target.value as 'all' | JobState)}>
              <option value="all">全部状态</option>
              {Object.entries(JOB_LABELS).map(([state, label]) => (
                <option key={state} value={state}>
                  {label}
                </option>
              ))}
            </Select>
            <Button size="sm" icon="refresh" busy={jobs.loading} onClick={() => void jobs.refresh()}>
              刷新
            </Button>
          </>
        }
      >
        {visibleJobs.length === 0 ? (
          <Empty
            icon="clock"
            title="没有符合条件的任务"
            description="视频理解、生图或显式 /draw 命令会创建媒体任务；完成后显示发送状态。"
          />
        ) : (
          <div className="job-list">
            {visibleJobs.map((job) => (
              <div className={`job-row${TERMINAL.includes(job.state) ? '' : ' is-live'}`} key={job.id}>
                <div className="job-main">
                  <div className="job-title">
                    <Tag tone={JOB_TONES[job.state]}>{JOB_LABELS[job.state]}</Tag>
                    <strong>{CAPABILITY_LABELS[job.capability] ?? job.capability}</strong>
                    <span className="muted mono">{job.id}</span>
                  </div>
                  <div className="job-meta">
                    <span className="mono">账号 {job.accountId}</span>
                    <span>
                      {job.conversation.kind === 'group' ? '群' : '私聊'} {job.conversation.peerId}
                    </span>
                    <span className="mono">
                      {job.providerId ?? 'provider?'} / {job.modelId ?? 'model?'}
                    </span>
                    <span className="muted">交付 {job.delivery}</span>
                    <span className="muted">{relativeTime(job.updatedAt)}</span>
                  </div>
                  {job.error ? (
                    <p className="inline-error">
                      {job.error.code}: {job.error.message}
                    </p>
                  ) : null}
                  {job.note ? <p className="muted">{job.note}</p> : null}
                  {job.result?.text ? <p className="job-result">{job.result.text}</p> : null}
                  {job.result?.media?.length ? (
                    <div className="job-media">
                      {job.result.media.map((item) => (
                        <MediaPreview key={item.mediaId} accountId={job.accountId} item={item} compact />
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="job-actions">
                  <span className="muted mono">{formatDateTime(job.createdAt)}</span>
                  {!TERMINAL.includes(job.state) ? (
                    <CancelButton
                      size="sm"
                      variant="danger"
                      icon="stop"
                      busy={busy === job.id}
                      onClick={() => void cancel(job)}
                    >
                      取消
                    </CancelButton>
                  ) : null}
                  <span className="muted">
                    取消模式 {job.cancelMode}
                    {job.cancelRequested ? ' · 已请求' : ''}
                    {job.remoteCancelled ? ' · 远端已确认' : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="账号媒体"
        subtitle="媒体保存在账号目录内。预览使用带 token 的本地请求，不生成公开链接。"
        actions={
          <>
            <Select aria-label="媒体账号" value={mediaAccount} onChange={(event) => setMediaAccount(event.target.value)}>
              {accountIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
            <Button size="sm" icon="refresh" busy={media.loading} onClick={() => void media.refresh()}>
              刷新
            </Button>
            <ConfirmButton size="sm" variant="ghost" icon="trash" busy={busy === 'cleanup'} onClick={() => void cleanup()}>
              清理过期
            </ConfirmButton>
          </>
        }
      >
        {media.error ? <ErrorNote message={media.error} onRetry={() => void media.refresh()} /> : null}
        {!media.data?.media.length ? (
          <Empty
            icon="folder"
            title="该账号还没有媒体"
            description="收到的图片、视频和生成的图片会按账号保存；过期后可按保留策略清理。"
          />
        ) : (
          <div className="media-grid">
            {media.data.media.map((item) => (
              <div className="media-card" key={item.mediaId}>
                <MediaPreview accountId={item.accountId} item={item} />
                <div className="media-meta">
                  <span className="mono">{item.kind}</span>
                  <span>{formatBytes(item.bytes)}</span>
                  <span className="muted">{formatDateTime(item.createdAt)}</span>
                </div>
                <div className="media-refs">
                  {item.source.jobId ? <span className="muted mono">job {item.source.jobId}</span> : null}
                  <span className="muted">
                    过期 {formatDateTime(item.expiresAt)}
                  </span>
                </div>
                <div className="row-actions">
                  <ConfirmButton
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    busy={busy === item.mediaId}
                    onClick={() => void removeMedia(item)}
                  >
                    删除
                  </ConfirmButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function MediaPreview({
  accountId,
  item,
  compact = false
}: {
  accountId: string;
  item: MediaRef;
  compact?: boolean;
}) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (item.kind !== 'image' && item.kind !== 'video') return;
    let active = true;
    let objectUrl: string | undefined;
    fetchMediaBlob(accountId, item.mediaId)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [accountId, item.mediaId, item.kind]);

  if (item.kind === 'image') {
    if (url) {
      return (
        <img
          className={`media-preview${compact ? ' is-compact' : ''}`}
          src={url}
          alt=""
        />
      );
    }
    return (
      <div className={`media-placeholder${compact ? ' is-compact' : ''}`}>
        <Icon name={failed ? 'warning' : 'clock'} size={18} />
        <span>{failed ? '无法预览' : '加载中'}</span>
      </div>
    );
  }
  if (item.kind === 'video') {
    if (url) {
      return (
        <video
          className={`media-preview${compact ? ' is-compact' : ''}`}
          src={url}
          controls
          preload="metadata"
        />
      );
    }
    return (
      <div className={`media-placeholder${compact ? ' is-compact' : ''}`}>
        <Icon name={failed ? 'warning' : 'clock'} size={18} />
        <span>{failed ? '无法预览' : '视频加载中'}</span>
      </div>
    );
  }
  return (
    <div className={`media-placeholder${compact ? ' is-compact' : ''}`}>
      <Icon name="folder" size={18} />
      <span>{item.kind}</span>
    </div>
  );
}
