import { useEffect, useRef, useState } from 'react';
import { api, apiBinary } from '../../api';
import { Button, Field, Input, LoadingNote, Select, Textarea } from '../../ui';
import type { ConfigDraftState } from '../config-draft';
import {
  createVoiceForm,
  describeVoiceFailure,
  describeVoiceSummary,
  isPresetVoiceAvailable,
  normalizeBaseUrl,
  pickPresetVoiceForEngine,
  resolveCapabilities,
  resolveEngines,
  toVoicePayload,
  validateVoiceForm,
  withPendingReferenceAudio,
  withReferenceAudio,
  withVoiceService,
  type VoiceConfigView,
  type VoiceForm,
  type VoiceReferenceItem,
  type VoiceServiceItem,
} from '../../voice-config.js';
import { voiceServiceCacheKey } from './voice-cache.js';
import { useVoiceProbe } from './use-voice-probe';
import { formatVoiceEngineLabel, VoiceProbeSummaryBox } from './VoiceProbeView';

const PREVIEW_EMOTION_PRESETS = ['温柔', '开心', '傲娇', '撒娇', '俏皮', '委屈', '激动', '生气', '平静'];

const MAX_REFERENCE_AUDIO_BYTES = 32 * 1024 * 1024;

type Props = {
  guardWrite?: <T>(action: () => Promise<T>) => Promise<T>;
  pausedWrite?: boolean;
  roleId: string;
  active?: boolean;
  serviceRefreshVersion?: number;
  serviceEpochs?: Record<string, number>;
  onOpenVoiceSettings?: (target?: { serviceId?: string; createNew?: boolean }) => void;
  onChanged?: () => void;
  onDraftStateChange?: (state: ConfigDraftState) => void;
};

const DEFAULT_PREVIEW_TEXT = '今天想和你一起，慢慢走一段路。';

export function VoicePanel({
  roleId,
  active,
  serviceRefreshVersion = 0,
  serviceEpochs: _serviceEpochs = {},
  onOpenVoiceSettings,
  onChanged,
  onDraftStateChange,
  guardWrite = action => action(),
  pausedWrite = false,
}: Props) {
  const [config, setConfig] = useState<VoiceConfigView | null>(null);
  const [services, setServices] = useState<VoiceServiceItem[]>([]);
  const [form, setForm] = useState<VoiceForm>(() => createVoiceForm(null));
  const [savedForm, setSavedForm] = useState<VoiceForm | null>(null);
  const draftCallback = useRef(onDraftStateChange);
  draftCallback.current = onDraftStateChange;
  const [references, setReferences] = useState<VoiceReferenceItem[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [previewEmotion, setPreviewEmotion] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  // 启用状态的写入序号：保存的旧响应不能用过期快照覆盖已确认的启停结果。
  const stateSeq = useRef(0);
  // 保存与启停共用一把锁。状态更新是异步的，同一帧内的两次点击靠 useState 拦不住。
  // 锁带身份，释放时比对身份：切换角色后旧请求的 finally 不能放掉新角色的锁。
  const inFlight = useRef<{ kind: 'save' | 'toggle'; seq: number } | null>(null);
  const lockSeq = useRef(0);
  const acquire = (kind: 'save' | 'toggle') => {
    const lock = { kind, seq: ++lockSeq.current };
    inFlight.current = lock;
    return lock;
  };
  const release = (lock: { seq: number }) => {
    if (inFlight.current?.seq === lock.seq) inFlight.current = null;
  };
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrl = useRef<string | null>(null);

  // 角色切换令牌：晚到的响应一律丢弃，避免写进另一个角色的页面状态。
  const roleToken = useRef(0);
  const previewToken = useRef(0);
  const lastRole = useRef(roleId);
  const lastActive = useRef(active);
  const initialServiceSync = useRef(true);
  if (lastActive.current !== active) {
    lastActive.current = active;
    if (!active) previewToken.current += 1;
  }
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
    // 换角色即放锁：旧请求已经作废，不该继续挡住新角色的保存与启停。
    inFlight.current = null;
  }
  // 卸载后挂起的请求同样作废：离开设置页不应再启动播放或写状态。
  const mounted = useRef(true);
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  const formRef = useRef(form);
  formRef.current = form;

  const selectedService = services.find(service => service.serviceId === form.serviceId) ?? null;
  const missingSelectedService = form.serviceId.length > 0 && selectedService === null;
  const disabledSelectedService = selectedService !== null && !selectedService.enabled;
  const probeCacheKey =
    selectedService &&
    selectedService.enabled &&
    selectedService.config.protocol === 'nowadays-tts-v1'
      ? voiceServiceCacheKey(selectedService)
      : '';
  const voiceProbe = useVoiceProbe(probeCacheKey, {
    shared: probeCacheKey !== '',
    onBeforeProbe: () => {
      setError('');
      setNotice('');
    },
  });

  const stopPreview = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
      audioRef.current = null;
    }
    if (previewUrl.current !== null) {
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    }
    setPlaying(false);
  };

  useEffect(() => {
    // 探测返回的能力声明是服务信息，不代表用户修改了配置。
    const comparable = (value: VoiceForm) => {
      const { capabilities: _capabilities, ...fields } = value;
      return JSON.stringify(fields);
    };
    const stagedPending =
      pendingFile !== null && (form.protocol === 'indextts' || form.sourceKind === 'reference');
    draftCallback.current?.({
      dirty: stagedPending || (savedForm !== null && comparable(form) !== comparable(savedForm)),
      busy: busy || toggleBusy || voiceProbe.busy,
      discard: () => {
        if (savedForm) setForm(savedForm);
        setPendingFile(null);
        if (fileInput.current) fileInput.current.value = '';
        previewToken.current += 1;
        stopPreview();
        setPreviewBusy(false);
        voiceProbe.clearLog();
        setPreviewEmotion('');
        setError('');
        setNotice('');
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, savedForm, pendingFile, busy, toggleBusy, voiceProbe.busy]);

  useEffect(() => {
    if (!active) {
      stopPreview();
      setPreviewBusy(false);
      voiceProbe.clearLog();
    }
  }, [active, voiceProbe.clearLog]);

  useEffect(() => {
    let activeLoad = true;
    setConfig(null);
    setServices([]);
    setForm(createVoiceForm(null));
    setSavedForm(null);
    setReferences([]);
    setPendingFile(null);
    if (fileInput.current) fileInput.current.value = '';
    setPreviewEmotion('');
    setNotice('');
    setError('');
    setPreviewBusy(false);
    setBusy(false);
    setToggleBusy(false);
    setLoading(true);
    setPlaying(false);
    stopPreview();
    if (!roleId) {
      setLoading(false);
      return;
    }
    Promise.all([
      api<{ voice: VoiceConfigView | null }>(`/v1/roles/${encodeURIComponent(roleId)}/voice`),
      api<{ items: VoiceServiceItem[] }>('/v1/voice-services'),
      api<{ items: VoiceReferenceItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/voice/references`),
    ])
      .then(([voice, available, reference]) => {
        if (!activeLoad) return;
        setConfig(voice.voice);
        setServices(available.items);
        const initial = createVoiceForm(voice.voice);
        if (voice.voice === null && available.items.length > 0) {
          const picked = available.items.find(item => item.enabled) ?? available.items[0]!;
          initial.serviceId = picked.serviceId;
          initial.protocol = picked.config.protocol;
          initial.baseUrl = picked.config.baseUrl;
        }
        setForm(initial);
        setSavedForm(initial);
        setReferences(reference.items);
        setLoading(false);
      })
      .catch(reason => {
        if (!activeLoad) return;
        setError(failureText(reason));
        setLoading(false);
      });
    return () => {
      activeLoad = false;
    };
  }, [roleId]);

  useEffect(() => {
    if (initialServiceSync.current) {
      initialServiceSync.current = false;
      return;
    }
    if (!roleId) return;
    const token = roleToken.current;
    Promise.all([
      api<{ voice: VoiceConfigView | null }>(`/v1/roles/${encodeURIComponent(roleId)}/voice`),
      api<{ items: VoiceServiceItem[] }>('/v1/voice-services'),
    ])
      .then(([voice, available]) => {
        if (isStale(token)) return;
        setConfig(voice.voice);
        setServices(available.items);
        setForm(previous => {
          if (previous.serviceId === '' && available.items.length > 0 && !previous.configured) {
            const first = available.items.find(item => item.enabled) ?? available.items[0]!;
            return {
              ...previous,
              serviceId: first.serviceId,
              protocol: first.config.protocol,
              baseUrl: first.config.baseUrl,
            };
          }
          const matched = available.items.find(item => item.serviceId === previous.serviceId);
          if (matched) {
            return {
              ...previous,
              protocol: matched.config.protocol,
              baseUrl: matched.config.baseUrl,
            };
          }
          return previous;
        });
      })
      .catch(() => { /* 从设置返回同步失败时保留现有草稿，保存时会触发正式校验 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, serviceRefreshVersion]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopPreview();
    };
  }, []);

  const patch = (next: Partial<VoiceForm>) => setForm(previous => ({ ...previous, ...next }));

  const selectService = (nextServiceId: string) => {
    const picked = services.find(item => item.serviceId === nextServiceId);
    if (!picked) {
      setForm(previous => withVoiceService(previous, { serviceId: nextServiceId }));
      return;
    }
    setForm(previous =>
      withVoiceService(previous, {
        serviceId: picked.serviceId,
        protocol: picked.config.protocol,
        baseUrl: picked.config.baseUrl,
      }),
    );
  };

  const refreshReferences = async (token: number) => {
    const result = await api<{ items: VoiceReferenceItem[] }>(
      `/v1/roles/${encodeURIComponent(roleId)}/voice/references`,
    );
    if (isStale(token)) return;
    setReferences(result.items);
  };

  const runProbe = async () => {
    if (voiceProbe.busy || !selectedService || disabledSelectedService) return;
    if (selectedService.config.protocol === 'indextts') return;
    const targetId = selectedService.serviceId;
    const probed = await voiceProbe.run({
      kind: 'savedService',
      serviceId: targetId,
      cacheKey: probeCacheKey,
    });
    if (!probed) return;
    const latest = formRef.current;
    if (latest.serviceId !== targetId) return;
    patch({ capabilities: probed.capabilities });
    if (
      latest.sourceKind === 'preset' &&
      latest.voiceId.trim().length > 0 &&
      isPresetVoiceAvailable(probed.voices, latest.voiceId) === false
    ) {
      setError('当前预置音色已不在服务端列表里，请重新选择后再试听或保存。');
    }
  };

  const playBlob = (blob: Blob) => {
    stopPreview();
    const url = URL.createObjectURL(blob);
    previewUrl.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => { stopPreview(); };
    audio.onerror = () => { setError('试听音频无法播放。'); stopPreview(); };
    setPlaying(true);
    void audio.play().catch(() => {
      setError('试听音频无法播放。');
      stopPreview();
    });
  };

  const probeSource =
    selectedService && voiceProbe.result !== null
      ? {
          baseUrl: normalizeBaseUrl(selectedService.config.baseUrl),
          protocol: selectedService.config.protocol,
        }
      : null;

  const activeCapabilities = resolveCapabilities({
    config,
    form,
    probe: voiceProbe.result,
    probeSource,
  });
  const activeEngines = resolveEngines({
    config,
    form,
    probe: voiceProbe.result,
    probeSource,
  });

  const validateServiceSelectionBeforeAction = (): string | null => {
    if (form.serviceId === '' && form.baseUrl.trim().length === 0) {
      return services.length === 0
        ? '还没有语音服务，请先在「设置 -> 模型 -> 语音」中添加。'
        : '请先选择一项语音服务。';
    }
    if (missingSelectedService) {
      return '当前所选语音服务已不存在，请重新选择或前往设置新建。';
    }
    if (disabledSelectedService) {
      return describeVoiceFailure({ code: 'VOICE_SERVICE_DISABLED' });
    }
    return null;
  };

  const runPreview = async () => {
    const text = previewText.trim();
    if (text.length === 0) {
      setError('试听文本不能为空。');
      return;
    }
    const serviceProblem = validateServiceSelectionBeforeAction();
    if (serviceProblem !== null) {
      setError(serviceProblem);
      return;
    }
    const token = roleToken.current;
    const preview = previewToken.current;
    const stagedFile =
      pendingFile !== null && (form.protocol === 'indextts' || form.sourceKind === 'reference')
        ? pendingFile
        : null;
    const hasPendingReference = stagedFile !== null;
    const issues = validateVoiceForm(form, {
      capabilities: activeCapabilities,
      engines: activeEngines.engines,
      hasPendingReference,
      requireService: form.serviceId.length > 0 || services.length > 0,
    });
    if (issues.length > 0) {
      setError(issues.map(item => item.message).join('；'));
      return;
    }
    setPreviewBusy(true);
    setError('');
    setNotice('');
    try {
      const emotion = !isLegacy ? previewEmotion.trim() : '';
      const payload = {
        text,
        ...(emotion.length > 0 ? { emotion } : {}),
        ...toVoicePayload(form, {
          capabilities: activeCapabilities,
          engines: activeEngines.engines,
          defaultEngine: selectedService?.config.defaultEngine ?? activeEngines.defaultEngine,
          hasPendingReference,
        }),
      };
      let body: unknown = payload;
      if (stagedFile !== null) {
        const formData = new FormData();
        formData.append('payload', JSON.stringify(payload));
        formData.append('file', stagedFile, stagedFile.name);
        body = formData;
      }
      const blob = await apiBinary(`/v1/roles/${encodeURIComponent(roleId)}/voice/preview`, {
        method: 'POST',
        body,
      });
      // 切到别的角色后不再播放上一段试听。
      if (isStale(token) || preview !== previewToken.current) return;
      if (blob.size === 0) {
        setError('试听返回了空音频。');
        return;
      }
      playBlob(blob);
      setNotice(
        stagedFile !== null
          ? `已用待上传录音「${stagedFile.name}」生成临时试听（尚未写入目录），正在播放。`
          : '已按当前表单生成试听，正在播放。',
      );
    } catch (reason) {
      if (isStale(token) || preview !== previewToken.current) return;
      setError(failureText(reason));
    } finally {
      if (!isStale(token) && preview === previewToken.current) setPreviewBusy(false);
    }
  };

  const selectPendingReference = (files: FileList | null) => {
    const file = files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file || busy) return;
    setError('');
    if (file.size === 0) { setError('参考音频不能为空。'); return; }
    if (file.size > MAX_REFERENCE_AUDIO_BYTES) { setError('参考音频超过 32 MiB 上限。'); return; }
    setPendingFile(file);
    // 选定新音频必须清空上一段录音遗留的参考文本，但不提前写盘。
    setForm(previous => withPendingReferenceAudio(previous));
    setNotice(`已暂存待上传录音「${file.name}」，可直接生成试听，点保存后正式写入角色目录。`);
  };

  const clearPendingReference = () => {
    if (pendingFile === null || busy) return;
    setPendingFile(null);
    if (fileInput.current) fileInput.current.value = '';
    patch({ referenceText: '' });
    setNotice('已取消待上传录音。');
  };

  const removeReference = async (item: VoiceReferenceItem) => {
    if (busy) return;
    if (item.inUse) {
      setError('这段参考音频正在使用，先切换到其他音色再删除。');
      return;
    }
    const token = roleToken.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await guardWrite(() => api<{ deleted: boolean; fileRemoved: boolean }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice/references/${encodeURIComponent(item.assetId)}`,
        { method: 'DELETE' },
      ));
      if (isStale(token)) return;
      if (formRef.current.referenceAssetId === item.assetId) {
        setForm(previous => withReferenceAudio(previous, ''));
      }
      await refreshReferences(token);
      if (isStale(token)) return;
      setNotice(
        result.fileRemoved
          ? `已删除参考音频「${item.fileName}」。`
          : `已删除「${item.fileName}」的记录，但文件清理失败，可稍后重试。`,
      );
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      if (!isStale(token)) setBusy(false);
    }
  };

  const save = async () => {
    // 保存与启停互斥：任一进行中都不接受另一个，避免旧快照覆盖已确认的启用状态。
    if (inFlight.current !== null || busy || toggleBusy) return;
    const serviceProblem = validateServiceSelectionBeforeAction();
    if (serviceProblem !== null) {
      setError(serviceProblem);
      return;
    }
    const stagedFile =
      pendingFile !== null && (form.protocol === 'indextts' || form.sourceKind === 'reference')
        ? pendingFile
        : null;
    const hasPendingReference = stagedFile !== null;
    const issues = validateVoiceForm(form, {
      capabilities: activeCapabilities,
      engines: activeEngines.engines,
      hasPendingReference,
      requireService: form.serviceId.length > 0 || services.length > 0,
    });
    if (issues.length > 0) {
      setError(issues.map(item => item.message).join('；'));
      return;
    }
    const lock = acquire('save');
    const token = roleToken.current;
    const configSeq = stateSeq.current;
    const submittedForm = form;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (submittedForm.serviceId) {
        const available = await api<{ items: VoiceServiceItem[] }>('/v1/voice-services');
        if (isStale(token)) return;
        setServices(available.items);
        const latest = available.items.find(item => item.serviceId === submittedForm.serviceId);
        if (!latest) {
          setError('当前所选语音服务已不存在，请重新选择或前往设置新建。');
          return;
        }
        if (!latest.enabled) {
          setError(describeVoiceFailure({ code: 'VOICE_SERVICE_DISABLED' }));
          return;
        }
      }
      const payload = toVoicePayload(submittedForm, {
        capabilities: activeCapabilities,
        engines: activeEngines.engines,
        defaultEngine: selectedService?.config.defaultEngine ?? activeEngines.defaultEngine,
        hasPendingReference,
        clearEngine: config !== null && Boolean(config.ttsEngine) && submittedForm.ttsEngine.trim() === '',
      });
      let body: unknown = payload;
      if (stagedFile !== null) {
        const formData = new FormData();
        formData.append('payload', JSON.stringify(payload));
        formData.append('file', stagedFile, stagedFile.name);
        body = formData;
      }
      const result = await guardWrite(() => api<{ voice: VoiceConfigView }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice`,
        {
          method: 'PUT',
          body,
        },
      ));
      if (isStale(token)) return;
      if (stateSeq.current === configSeq) setConfig(result.voice);
      setPendingFile(null);
      if (fileInput.current) fileInput.current.value = '';
      const saved = createVoiceForm(result.voice);
      setForm(saved);
      setSavedForm(saved);
      await refreshReferences(token);
      if (isStale(token)) return;
      setNotice('已保存声音配置。');
      onChanged?.();
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      release(lock);
      if (!isStale(token)) setBusy(false);
    }
  };

  // 启用／停用只改开关，不动这份配置：停用后再启用仍读同一份（DL-149）。
  const toggleVoiceEnabled = async (next: boolean) => {
    if (inFlight.current !== null || toggleBusy || busy) return;
    const lock = acquire('toggle');
    const token = roleToken.current;
    setToggleBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await guardWrite(() => api<{ voice: VoiceConfigView }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice/enabled`,
        { method: 'PUT', body: { enabled: next } },
      ));
      if (isStale(token)) return;
      setConfig(result.voice);
      stateSeq.current += 1;
      setNotice(
        result.voice.enabled
          ? '已启用角色语音，对话会按句合成。'
          : '已停用角色语音，配置已保留，随时可以再启用。',
      );
      onChanged?.();
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      release(lock);
      if (!isStale(token)) setToggleBusy(false);
    }
  };

  if (loading) return <LoadingNote label="正在读取声音配置…" />;

  const activeDefaultEngine = selectedService?.config.defaultEngine ?? activeEngines.defaultEngine;
  const availableEngineEntries = activeEngines.engines ? Object.entries(activeEngines.engines) : [];
  const isLegacy = form.protocol === 'indextts';
  const usePreset = !isLegacy && form.sourceKind === 'preset';
  const capabilities = activeCapabilities;
  const modes = capabilities?.referenceModes ?? [];
  const selectedMode = modes.find(mode => mode.id === form.referenceMode) ?? null;
  const languages = capabilities?.languages ?? [];
  const speedRange = capabilities?.speed ?? null;
  const voices = probeSource !== null ? voiceProbe.result?.voices ?? null : null;

  return (
    <div className="nd-voice">
      <p className="nd-appearance-hint">{describeVoiceSummary(config)}</p>

      <label className="nd-voice-toggle">
        <input
          type="checkbox"
          checked={config !== null && config.enabled !== false}
          disabled={config === null || busy || toggleBusy}
          onChange={event => void toggleVoiceEnabled(event.target.checked)}
        />
        <span>启用角色语音</span>
        <small>
          {config === null
            ? '保存配置后可以启用或停用。'
            : config.enabled === false
              ? '已停用：对话不再合成语音，这份配置保留。'
              : '对话会按句合成语音。'}
        </small>
      </label>

      <Field
        label="语音服务"
        hint={
          selectedService
            ? `${selectedService.config.protocol === 'indextts' ? '旧 IndexTTS 协议（仅试听验证）' : '统一语音协议'} · ${selectedService.config.baseUrl}`
            : config !== null && !config.serviceId && config.baseUrl
              ? `当前沿用直连地址 ${config.baseUrl}；建议改为选择设置中维护的全局语音服务。`
              : '服务地址与协议在「设置 -> 模型 -> 语音」统一维护，这里按角色选择服务与音色。'
        }
      >
        <div className="nd-voice-service-row">
          <Select
            aria-label="语音服务"
            disabled={busy}
            value={form.serviceId}
            onChange={event => selectService(event.target.value)}
          >
            {services.length === 0 ? <option value="">还没有语音服务</option> : null}
            {services.length > 0 && form.serviceId === '' ? (
              <option value="">请选择语音服务</option>
            ) : null}
            {missingSelectedService ? (
              <option value={form.serviceId}>原服务已删除（请重新选择）</option>
            ) : null}
            {services.map(service => (
              <option key={service.serviceId} value={service.serviceId}>
                {service.name}
                {service.enabled ? '' : '（已停用）'}
              </option>
            ))}
          </Select>
          {selectedService && !isLegacy ? (
            <Button
              disabled={busy || voiceProbe.busy || disabledSelectedService}
              onClick={() => void runProbe()}
            >
              {voiceProbe.busy ? '正在测试…' : '测试连接'}
            </Button>
          ) : null}
          {onOpenVoiceSettings ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onOpenVoiceSettings(
                  selectedService
                    ? { serviceId: selectedService.serviceId }
                    : services.length === 0
                      ? { createNew: true }
                      : undefined,
                )
              }
            >
              {services.length === 0 ? '去设置添加 →' : '在设置中管理 →'}
            </Button>
          ) : null}
        </div>
        {missingSelectedService ? (
          <p role="alert" className="nd-appearance-hint nd-voice-warn">
            当前所选语音服务已不存在，请重新选择或前往设置新建。
          </p>
        ) : null}
        {disabledSelectedService ? (
          <p role="alert" className="nd-appearance-hint nd-voice-warn">
            当前所选语音服务已停用，请先启用或重新选择。
          </p>
        ) : null}
        {isLegacy && selectedService ? (
          <small className="nd-voice-note">旧 IndexTTS 协议没有探测接口，请直接用下方试听验证连接。</small>
        ) : null}
      </Field>

      {voiceProbe.notice ? (
        <p role={voiceProbe.notice.kind === 'alert' ? 'alert' : 'status'}>
          {voiceProbe.notice.text}
        </p>
      ) : null}
      <VoiceProbeSummaryBox probe={probeSource !== null ? voiceProbe.result : null} />

      {!isLegacy && (availableEngineEntries.length > 0 || form.ttsEngine.length > 0 || activeDefaultEngine) ? (
        <Field
          label="语音引擎"
          hint={
            activeDefaultEngine
              ? `当前服务默认 ${activeDefaultEngine}；可按角色覆盖 CosyVoice3（自然语言情绪指令更细腻、更省显存）或 IndexTTS-2.5（热态推理更快）。`
              : '由当前服务探测声明；留空则使用服务端默认引擎。'
          }
        >
          <Select
            aria-label="语音引擎"
            disabled={busy}
            value={form.ttsEngine}
            onChange={event => {
              const nextEngine = event.target.value;
              const mappedVoiceId =
                form.sourceKind === 'preset' && voices
                  ? pickPresetVoiceForEngine(voices, form.voiceId, nextEngine)
                  : form.voiceId;
              patch({ ttsEngine: nextEngine, voiceId: mappedVoiceId });
            }}
          >
            <option value="">
              {activeDefaultEngine ? `跟随服务默认（${activeDefaultEngine}）` : '跟随服务默认'}
            </option>
            {availableEngineEntries.map(([id, status]) => (
              <option key={id} value={id}>
                {formatVoiceEngineLabel(id, status, activeDefaultEngine)}
              </option>
            ))}
            {form.ttsEngine.length > 0 && !availableEngineEntries.some(([id]) => id === form.ttsEngine) ? (
              <option value={form.ttsEngine}>{form.ttsEngine}（未在当前探测列表）</option>
            ) : null}
          </Select>
        </Field>
      ) : null}

      {!isLegacy ? (
        <Field label="音色来源">
          <Select
            aria-label="音色来源"
            disabled={busy}
            value={form.sourceKind}
            onChange={event => patch({ sourceKind: event.target.value as VoiceForm['sourceKind'] })}
          >
            <option value="reference">参考音频</option>
            <option value="preset">预置音色</option>
          </Select>
        </Field>
      ) : null}

      {usePreset ? (
        <Field
          label="预置音色"
          hint={
            capabilities !== null && capabilities.presetVoices === false
              ? '当前服务未声明预置音色，保存会被拒绝，请改用参考音频音色。'
              : voices && voices.length > 0
                ? '列表来自最近一次连接测试。'
                : '可以先在设置或此处点击「测试连接」获取列表，也可以直接填写音色 ID。'
          }
        >
          {voices && voices.length > 0 ? (
            <Select
              aria-label="预置音色"
              disabled={busy}
              value={form.voiceId}
              onChange={event => patch({ voiceId: event.target.value })}
            >
              <option value="">请选择音色</option>
              {voices.map(voice => (
                <option key={voice.id} value={voice.id}>
                  {voice.label || voice.id}
                </option>
              ))}
              {form.voiceId.length > 0 && !voices.some(voice => voice.id === form.voiceId) ? (
                <option value={form.voiceId}>{form.voiceId}（不在服务端列表）</option>
              ) : null}
            </Select>
          ) : (
            <Input
              aria-label="预置音色"
              disabled={busy}
              placeholder="音色 ID"
              value={form.voiceId}
              onChange={event => patch({ voiceId: event.target.value })}
            />
          )}
        </Field>
      ) : (
        <>
          <Field label="参考音频" hint="选定新录音先暂存在表单中，可先试听；点击「保存声音配置」后才写入角色目录。使用中的参考音频不能删除。">
            <Select
              aria-label="参考音频"
              disabled={busy}
              value={form.referenceAssetId}
              onChange={event => {
                setPendingFile(null);
                setForm(previous => withReferenceAudio(previous, event.target.value));
              }}
            >
              <option value="">{pendingFile ? `待上传：${pendingFile.name}` : '请选择参考音频'}</option>
              {references.map(item => (
                <option key={item.assetId} value={item.assetId}>
                  {item.fileName}
                  {item.inUse ? '（使用中）' : ''}
                </option>
              ))}
              {form.referenceAssetId.length > 0 && !references.some(item => item.assetId === form.referenceAssetId) ? (
                <option value={form.referenceAssetId}>已选音频（列表里没有）</option>
              ) : null}
            </Select>
          </Field>
          <div className="nd-appearance-actions">
            <input
              ref={fileInput}
              type="file"
              accept="audio/wav,audio/mpeg,audio/flac,audio/ogg"
              className="nd-visually-hidden"
              onChange={event => selectPendingReference(event.target.files)}
            />
            <Button disabled={busy} onClick={() => fileInput.current?.click()}>
              选择参考音频
            </Button>
            {pendingFile ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={clearPendingReference}>
                取消待上传
              </Button>
            ) : null}
            <small className="nd-voice-note">支持 WAV、MP3、FLAC、OGG，单个不超过 32 MiB；保存后正式上传。</small>
          </div>
          {pendingFile ? (
            <div className="nd-voice-probe" role="status">
              <small>
                待上传：{pendingFile.name}（{(pendingFile.size / 1024).toFixed(1)} KiB）· 点击「保存声音配置」后正式写入
              </small>
            </div>
          ) : null}
          {references.length > 0 ? (
            <ul className="nd-voice-references">
              {references.map(item => (
                <li key={item.assetId}>
                  <span>
                    {item.fileName}
                    {item.inUse ? <em>使用中</em> : null}
                  </span>
                  <button type="button" disabled={busy || item.inUse} onClick={() => void removeReference(item)}>
                    删除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="nd-appearance-empty">还没有上传参考音频。</p>
          )}
          {modes.length > 0 ? (
            <Field label="参考模式" hint="模式由当前服务声明，换服务后需要重新选择。">
              <Select
                aria-label="参考模式"
                disabled={busy}
                value={form.referenceMode}
                onChange={event => patch({ referenceMode: event.target.value })}
              >
                <option value="">请选择参考模式</option>
                {modes.map(mode => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                    {mode.requiresReferenceText ? '（需参考文本）' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          ) : isLegacy ? null : (
            <p className="nd-appearance-hint">
              {capabilities === null
                ? '当前服务还没有能力声明，先点「测试连接」，再选择参考模式。'
                : '当前服务未声明参考音频模式，不能使用参考音频音色，请改用预置音色。'}
            </p>
          )}
          {selectedMode?.requiresReferenceText ? (
            <Field label="参考文本" hint="服务要求与参考音频对应的文本，用于对齐音色。换录音后需要重新填写。">
              <Textarea
                aria-label="参考文本"
                rows={3}
                disabled={busy}
                value={form.referenceText}
                onChange={event => patch({ referenceText: event.target.value })}
              />
            </Field>
          ) : null}
        </>
      )}

      <Field label="语言">
        {languages.length > 0 ? (
          <Select
            aria-label="语言"
            disabled={busy}
            value={form.language}
            onChange={event => patch({ language: event.target.value })}
          >
            {languages.map(code => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        ) : (
          <Input
            aria-label="语言"
            disabled={busy}
            value={form.language}
            onChange={event => patch({ language: event.target.value })}
          />
        )}
      </Field>

      <Field
        label="语速"
        hint={speedRange === null ? '服务未声明语速范围，保存时由服务端判断。' : `服务声明范围 ${speedRange.min}～${speedRange.max}。`}
      >
        <Input
          aria-label="语速"
          type="number"
          step="0.05"
          min={speedRange?.min ?? 0.1}
          max={speedRange?.max ?? 10}
          disabled={busy}
          value={String(form.speed)}
          onChange={event => patch({ speed: Number(event.target.value) })}
        />
      </Field>

      <Field label="情感强度" hint="0 到 1，越高越贴近参考音频的情绪。">
        <Input
          aria-label="情感强度"
          type="number"
          step="0.05"
          min="0"
          max="1"
          disabled={busy}
          value={String(form.emoAlpha)}
          onChange={event => patch({ emoAlpha: Number(event.target.value) })}
        />
      </Field>

      {!isLegacy ? (
        <Field
          label="试听情绪指令"
          hint="可选；留空由服务自动判断。CosyVoice 支持自然语言语气，IndexTTS 支持情绪词（对话中会由模型按语境自动标注）。"
        >
          <div className="nd-voice">
            <Select
              aria-label="预设试听情绪"
              disabled={busy || previewBusy}
              value={PREVIEW_EMOTION_PRESETS.includes(previewEmotion) ? previewEmotion : ''}
              onChange={event => setPreviewEmotion(event.target.value)}
            >
              <option value="">自动判断 / 自定义输入</option>
              {PREVIEW_EMOTION_PRESETS.map(item => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
            <Input
              aria-label="试听情绪指令"
              disabled={busy || previewBusy}
              maxLength={100}
              placeholder="例如：温柔轻声哄人、傲娇嘴硬（留空自动）"
              value={previewEmotion}
              onChange={event => setPreviewEmotion(event.target.value)}
            />
          </div>
        </Field>
      ) : null}

      <Field label="试听文本">
        <Textarea
          aria-label="试听文本"
          rows={2}
          disabled={busy || previewBusy}
          maxLength={4000}
          value={previewText}
          onChange={event => setPreviewText(event.target.value)}
        />
      </Field>

      <div className="nd-appearance-actions">
        <Button disabled={busy || previewBusy} onClick={() => void runPreview()}>
          {previewBusy ? '正在合成…' : '生成试听'}
        </Button>
        <Button disabled={!playing} onClick={stopPreview}>
          停止播放
        </Button>
        <Button variant="primary" disabled={busy || toggleBusy} onClick={() => void save()}>
          {busy ? '正在保存…' : pausedWrite ? '暂停并保存声音配置' : '保存声音配置'}
        </Button>
      </div>
      {notice ? (
        <p className="nd-appearance-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="nd-appearance-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function failureText(reason: unknown): string {
  if (reason instanceof Error) {
    return describeVoiceFailure({
      code: (reason as { code?: string | null }).code ?? null,
      message: reason.message,
    });
  }
  return describeVoiceFailure({ message: String(reason) });
}
