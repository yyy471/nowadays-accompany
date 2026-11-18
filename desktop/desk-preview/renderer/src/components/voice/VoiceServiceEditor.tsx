import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Button, Field, Input, Select } from '../../ui';
import {
  describeVoiceFailure,
  toVoiceServiceConfig,
  validateVoiceServiceDraft,
  type VoiceProtocol,
  type VoiceServiceItem,
} from '../../voice-config.js';
import { clearVoiceProbeCache, voiceServiceCacheKey, writeVoiceProbeCache } from './voice-cache.js';
import { VoiceDefaultEngineField, VoiceProbeSummaryBox } from './VoiceProbeView';
import { useVoiceProbe } from './use-voice-probe';

type RoleNameItem = { roleId: string; displayName: string };
type ActivityItem = { roleId: string; state: 'active' | 'stopping' | 'stopped'; running: boolean };

function voiceErrorText(reason: unknown): string {
  if (reason instanceof ApiError) {
    return describeVoiceFailure({ code: reason.code, message: reason.message });
  }
  if (reason instanceof Error) {
    return describeVoiceFailure({ message: reason.message });
  }
  return describeVoiceFailure({ message: String(reason) });
}

export function VoiceServiceCreate({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (service: VoiceServiceItem) => void;
}) {
  const [name, setName] = useState('本机语音服务');
  const [protocol, setProtocol] = useState<VoiceProtocol>('nowadays-tts-v1');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:9890');
  const [defaultEngine, setDefaultEngine] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const probe = useVoiceProbe(`new-voice|${protocol}|${baseUrl}`, {
    onBeforeProbe: () => setError(''),
  });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const isLegacy = protocol === 'indextts';

  const create = async () => {
    if (busy) return;
    const problem = validateVoiceServiceDraft({ name, protocol, baseUrl });
    if (problem !== null) {
      setError(problem);
      return;
    }
    const carriedProbe = probe.result;
    setBusy(true);
    setError('');
    try {
      const created = await api<{ service: VoiceServiceItem }>('/v1/voice-services', {
        method: 'POST',
        body: {
          name: name.trim(),
          config: toVoiceServiceConfig({ protocol, baseUrl, defaultEngine }),
        },
      });
      // 提交后即使组件已因跳转返回角色配置而卸载，已落库的探测缓存与父级刷新通知仍必须完成。
      if (carriedProbe !== null) {
        writeVoiceProbeCache(voiceServiceCacheKey(created.service), carriedProbe);
      }
      onCreated(created.service);
    } catch (reason) {
      if (live.current) setError(voiceErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  return (
    <div className="config-prose">
      <header className="config-section-heading">
        <small>
          <i>＋</i> 模型 · 语音 · NEW VOICE SERVICE
        </small>
        <h2>添加语音服务</h2>
        <p>全局维护 TTS 服务地址、协议与默认引擎；保存后所有角色均可直接选用并配置各自音色与试听。</p>
      </header>
      <Field label="名称">
        <Input
          aria-label="语音服务名称"
          disabled={busy}
          maxLength={200}
          value={name}
          onChange={event => setName(event.target.value)}
        />
      </Field>
      <Field
        label="接口协议"
        hint={
          isLegacy
            ? '旧 IndexTTS 只提供参考音频合成，没有能力探测接口。'
            : '统一语音协议支持连接探测、多引擎（CosyVoice / IndexTTS）与音色列表。'
        }
      >
        <Select
          aria-label="语音接口协议"
          disabled={busy}
          value={protocol}
          onChange={event => {
            const nextProtocol = event.target.value as VoiceProtocol;
            setProtocol(nextProtocol);
            if (nextProtocol === 'indextts') setDefaultEngine('');
            probe.reset();
          }}
        >
          <option value="nowadays-tts-v1">统一语音协议（nowadays-tts-v1）</option>
          <option value="indextts">旧 IndexTTS 协议</option>
        </Select>
      </Field>
      <Field label="服务地址" hint="本机 WSL 桥接常用 http://127.0.0.1:9890；独立服务请填实际 HTTP/HTTPS 地址。">
        <Input
          aria-label="语音服务地址"
          disabled={busy}
          placeholder="http://127.0.0.1:9890"
          value={baseUrl}
          onChange={event => {
            setBaseUrl(event.target.value);
            probe.reset();
          }}
        />
      </Field>
      {!isLegacy ? (
        <>
          <div className="config-actions">
            <Button
              disabled={busy || probe.busy || !baseUrl.trim()}
              onClick={() => void probe.run({ kind: 'draft', config: { protocol, baseUrl } })}
            >
              {probe.busy ? '正在测试…' : '测试连接'}
            </Button>
          </div>
          {probe.notice ? (
            <p role={probe.notice.kind === 'alert' ? 'alert' : 'status'}>{probe.notice.text}</p>
          ) : null}
          <VoiceProbeSummaryBox probe={probe.result} />
          <VoiceDefaultEngineField
            disabled={busy}
            engines={probe.result?.engines ?? null}
            probeDefaultEngine={probe.result?.defaultEngine ?? null}
            value={defaultEngine}
            onChange={setDefaultEngine}
          />
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="config-actions">
        <Button
          disabled={busy || !name.trim() || !baseUrl.trim()}
          onClick={() => void create()}
        >
          {busy ? '正在保存…' : '保存语音服务'}
        </Button>
        <button type="button" disabled={busy} onClick={onCancel}>
          返回目录
        </button>
      </div>
    </div>
  );
}

export function VoiceServiceDetail({
  service,
  activities,
  roles,
  stopActiveRoles,
  onUpdated,
  onRemoved,
}: {
  service?: VoiceServiceItem;
  activities: ActivityItem[];
  roles: RoleNameItem[];
  stopActiveRoles: () => Promise<{ pausedIds: string[]; error?: unknown }>;
  onUpdated: (changedServiceId?: string) => void;
  onRemoved: (serviceId: string) => void;
}) {
  const [draftName, setDraftName] = useState(service?.name ?? '');
  const [draftProtocol, setDraftProtocol] = useState<VoiceProtocol>(
    service?.config.protocol ?? 'nowadays-tts-v1',
  );
  const [draftUrl, setDraftUrl] = useState(service?.config.baseUrl ?? '');
  const [defaultEngine, setDefaultEngine] = useState(service?.config.defaultEngine ?? '');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pausedRoleIds, setPausedRoleIds] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const savedKey = service ? voiceServiceCacheKey(service) : '';
  const matchesSaved =
    Boolean(service) &&
    draftProtocol === service!.config.protocol &&
    draftUrl.trim() === service!.config.baseUrl;
  const probe = useVoiceProbe(
    matchesSaved ? savedKey : `${savedKey}|draft|${draftProtocol}|${draftUrl}`,
    {
      shared: matchesSaved,
      onBeforeProbe: () => {
        setError('');
        setMessage('');
      },
    },
  );
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => () => { probe.clearLog(); }, [probe.clearLog]);

  if (!service) {
    return (
      <div className="config-prose">
        <header className="config-section-heading">
          <small>
            <i>01</i> 模型 · 语音 · VOICE
          </small>
          <h2>语音服务</h2>
          <p>选择或添加一个语音服务；角色的音色来源、语速情感与试听在角色配置中管理。</p>
        </header>
      </div>
    );
  }

  const hasActiveRoles = activities.some(item => item.state !== 'stopped');
  const isLegacy = draftProtocol === 'indextts';

  const ensurePaused = async (): Promise<string[] | null> => {
    const stopped = await stopActiveRoles();
    if (stopped.pausedIds.length > 0 && live.current) {
      setPausedRoleIds(previous => [...new Set([...previous, ...stopped.pausedIds])]);
    }
    if (stopped.error) {
      if (live.current) setError(voiceErrorText(stopped.error));
      return null;
    }
    return stopped.pausedIds;
  };

  const runProbe = async () => {
    if (isLegacy || !draftUrl.trim()) return;
    if (matchesSaved) {
      await probe.run({ kind: 'savedService', serviceId: service.serviceId, cacheKey: savedKey });
    } else {
      await probe.run({
        kind: 'draft',
        config: { protocol: draftProtocol, baseUrl: draftUrl },
      });
    }
  };

  const save = async () => {
    if (busy) return;
    const problem = validateVoiceServiceDraft({
      name: draftName,
      protocol: draftProtocol,
      baseUrl: draftUrl,
    });
    if (problem !== null) {
      setError(problem);
      return;
    }
    const carriedProbe = probe.result;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const paused = await ensurePaused();
      if (paused === null) return;
      const result = await api<{ service: VoiceServiceItem }>(
        `/v1/voice-services/${encodeURIComponent(service.serviceId)}`,
        {
          method: 'PATCH',
          body: {
            name: draftName.trim(),
            config: toVoiceServiceConfig({
              protocol: draftProtocol,
              baseUrl: draftUrl,
              defaultEngine,
            }),
          },
        },
      );
      const nextKey = voiceServiceCacheKey(result.service);
      if (nextKey !== savedKey) clearVoiceProbeCache(savedKey);
      if (carriedProbe !== null) writeVoiceProbeCache(nextKey, carriedProbe);
      onUpdated(service.serviceId);
      if (!live.current) return;
      setDraftName(result.service.name);
      setDraftProtocol(result.service.config.protocol);
      setDraftUrl(result.service.config.baseUrl);
      setDefaultEngine(result.service.config.defaultEngine ?? '');
      probe.clearLog();
      setMessage('语音服务已保存。');
    } catch (reason) {
      if (live.current) setError(voiceErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const paused = await ensurePaused();
      if (paused === null) return;
      await api<{ service: VoiceServiceItem }>(
        `/v1/voice-services/${encodeURIComponent(service.serviceId)}`,
        {
          method: 'PATCH',
          body: { enabled: !service.enabled },
        },
      );
      if (service.enabled) clearVoiceProbeCache(savedKey);
      onUpdated(service.serviceId);
      if (!live.current) return;
      probe.clearLog();
      setMessage(service.enabled ? '语音服务已全局停用。' : '语音服务已全局启用。');
    } catch (reason) {
      if (live.current) setError(voiceErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const paused = await ensurePaused();
      if (paused === null) return;
      await api(`/v1/voice-services/${encodeURIComponent(service.serviceId)}`, {
        method: 'DELETE',
      });
      clearVoiceProbeCache(savedKey);
      for (const roleId of paused) {
        try {
          await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, {
            method: 'POST',
          });
        } catch {
          /* 尽力恢复；未恢复的角色可在角色状态页手动继续 */
        }
      }
      onRemoved(service.serviceId);
    } catch (reason) {
      if (live.current) setError(voiceErrorText(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const resumePaused = async () => {
    if (busy || pausedRoleIds.length === 0) return;
    const names: string[] = [];
    for (const roleId of pausedRoleIds) {
      try {
        await api(`/v1/roles/${encodeURIComponent(roleId)}/activity/resume`, {
          method: 'POST',
        });
        names.push(roles.find(item => item.roleId === roleId)?.displayName ?? roleId);
      } catch (reason) {
        if (live.current) setError(`继续活动失败：${voiceErrorText(reason)}`);
      }
    }
    onUpdated();
    if (!live.current) return;
    setPausedRoleIds([]);
    if (names.length > 0) setMessage(`已继续本次活动暂停的角色：${names.join('、')}。`);
  };

  return (
    <div className="config-prose">
      <header className="config-section-heading">
        <small>
          <i>01</i> 模型 · 语音 · VOICE
        </small>
        <h2>{service.name}</h2>
        <p>全局维护语音服务地址、协议与默认引擎；角色可选用该服务并配置各自音色、参考音频与情绪试听。</p>
      </header>
      <div className="config-ledger">
        <div className="config-ledger-label">
          <b>状态</b>
          <small>全局</small>
        </div>
        <div>{service.enabled ? '已启用' : '已停用'}</div>
      </div>
      <div className="config-ledger">
        <div className="config-ledger-label">
          <b>名称</b>
          <small>语音服务</small>
        </div>
        <div>
          <Input
            aria-label="语音服务名称"
            disabled={busy}
            maxLength={200}
            value={draftName}
            onChange={event => setDraftName(event.target.value)}
          />
        </div>
      </div>
      <div className="config-ledger">
        <div className="config-ledger-label">
          <b>连接</b>
          <small>协议与地址</small>
        </div>
        <div className="config-connection">
          <Field label="接口协议">
            <Select
              aria-label="语音接口协议"
              disabled={busy}
              value={draftProtocol}
              onChange={event => {
                const nextProtocol = event.target.value as VoiceProtocol;
                setDraftProtocol(nextProtocol);
                if (nextProtocol === 'indextts') setDefaultEngine('');
                probe.clearLog();
              }}
            >
              <option value="nowadays-tts-v1">统一语音协议（nowadays-tts-v1）</option>
              <option value="indextts">旧 IndexTTS 协议</option>
            </Select>
          </Field>
          <Field label="服务地址">
            <Input
              aria-label="语音服务地址"
              disabled={busy}
              value={draftUrl}
              onChange={event => {
                setDraftUrl(event.target.value);
                probe.clearLog();
              }}
            />
          </Field>
        </div>
      </div>
      {!isLegacy ? (
        <div className="config-ledger">
          <div className="config-ledger-label">
            <b>引擎与探测</b>
            <small>默认引擎可覆盖</small>
          </div>
          <div>
            <VoiceDefaultEngineField
              disabled={busy}
              engines={probe.result?.engines ?? null}
              probeDefaultEngine={probe.result?.defaultEngine ?? null}
              value={defaultEngine}
              onChange={setDefaultEngine}
            />
            <div className="config-actions">
              <Button
                disabled={busy || probe.busy || !draftUrl.trim()}
                onClick={() => void runProbe()}
              >
                {probe.busy ? '正在测试…' : '测试连接'}
              </Button>
            </div>
            {probe.notice ? (
              <p role={probe.notice.kind === 'alert' ? 'alert' : 'status'}>{probe.notice.text}</p>
            ) : null}
            <VoiceProbeSummaryBox probe={probe.result} />
          </div>
        </div>
      ) : null}
      <div className="config-ledger">
        <div className="config-ledger-label">
          <b>管理</b>
          <small>修改前需全员停止</small>
        </div>
        <div>
          {hasActiveRoles ? (
            <p className="config-muted">
              当前有启用中的角色；保存、启停或删除时会先暂停活跃角色，完成后可一键继续。
            </p>
          ) : null}
          <div className="config-actions">
            <Button disabled={busy || !draftName.trim() || !draftUrl.trim()} onClick={() => void save()}>
              {hasActiveRoles ? '暂停活跃角色并保存' : '保存语音服务'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void toggleEnabled()}>
              {service.enabled
                ? hasActiveRoles
                  ? '暂停并停用'
                  : '全局停用'
                : hasActiveRoles
                  ? '暂停并启用'
                  : '全局启用'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(true)}>
              删除语音服务
            </Button>
          </div>
          {confirmDelete ? (
            <div role="alert">
              <p>确认删除语音服务「{service.name}」？已选用该服务的角色需在角色语音中重新指定。</p>
              <Button disabled={busy} onClick={() => void remove()}>
                {hasActiveRoles ? '暂停并删除' : '确认删除'}
              </Button>{' '}
              <button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {pausedRoleIds.length > 0 ? (
        <p role="status">
          已暂停 {pausedRoleIds.map(id => roles.find(item => item.roleId === id)?.displayName ?? id).join('、')}。{' '}
          <button type="button" onClick={() => void resumePaused()}>
            继续本次暂停的角色
          </button>
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
