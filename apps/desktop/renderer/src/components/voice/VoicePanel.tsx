import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { api, apiBinary } from '../../api';
import { Button, Field, Input, Select, Textarea } from '../../ui';
import { VoiceWave } from '../../ui/voice-wave';
import { announceLive } from '../../ui/live-announcer';
import { useWrite } from '../config/write-runner';
import type { ConfigDraftState } from '../config-draft';
import { MediaGroup, MediaRow, MediaSheet, MediaStateRow, RoleSaveActions, type MediaSummaryStatus } from '../config/MediaSheet';
import { useSheet } from '../config/sheet/sheet-context';
import { T3, T25, T33, T34 } from '../config/config-texts';
import {
  createVoiceForm,
  describeVoiceFailure,
  isPresetVoiceAvailable,
  normalizeBaseUrl,
  pickPresetVoiceForEngine,
  resolveCapabilities,
  resolveEngines,
  syncVoiceFormServices,
  toVoicePayload,
  validateVoiceForm,
  withPendingReferenceAudio,
  withReferenceAudio,
  type VoiceConfigView,
  type VoiceForm,
  type VoiceReferenceItem,
  type VoiceServiceItem,
} from '../../voice-config';
import { voiceServiceCacheKey } from './voice-cache';
import { useVoiceProbe } from './use-voice-probe';
import { formatVoiceEngineLabel, VoiceProbeFeedback, VoiceProbeSummaryBox } from './VoiceProbeView';

const PREVIEW_EMOTION_PRESETS = ['温柔', '开心', '傲娇', '撒娇', '俏皮', '委屈', '激动', '生气', '平静'];

const MAX_REFERENCE_AUDIO_BYTES = 32 * 1024 * 1024;

type Props = {
  guardWrite?: <T>(action: () => Promise<T>, verb?: string, announceSuccess?: boolean) => Promise<T>;
  /** 由上层按角色状态传入；保存与启停已热生效，仅删除参考音频仍走停机保护。 */
  pausedWrite?: boolean;
  roleId: string;
  active?: boolean;
  serviceRefreshVersion?: number;
  serviceEpochs?: Record<string, number>;
  onOpenVoiceSettings?: (target?: { serviceId?: string; createNew?: boolean }) => void;
  onChanged?: () => void;
  onDraftStateChange?: (state: ConfigDraftState) => void;
  onSummaryStatus?: (status: MediaSummaryStatus) => void;
};

const DEFAULT_PREVIEW_TEXT = '这是一段语音试听文本。';
type PlaybackSource = 'preview' | 'reference';

export function VoicePanel({
  roleId,
  active,
  serviceRefreshVersion = 0,
  serviceEpochs: _serviceEpochs = {},
  onOpenVoiceSettings,
  onChanged,
  onDraftStateChange,
  onSummaryStatus,
  guardWrite = action => action(),
}: Props) {
  const { sheet, closeNow } = useSheet();
  const { reportResult } = useWrite();
  const editing = Boolean(active && sheet?.id === 'media:voice');
  const [config, setConfig] = useState<VoiceConfigView | null>(null);
  const [services, setServices] = useState<VoiceServiceItem[]>([]);
  const [{ form, savedForm }, setForms] = useState<{ form: VoiceForm; savedForm: VoiceForm | null }>(
    () => ({ form: createVoiceForm(null), savedForm: null }),
  );
  const setForm = useCallback((update: SetStateAction<VoiceForm>) => {
    setForms(previous => {
      const next = typeof update === 'function' ? update(previous.form) : update;
      return next === previous.form ? previous : { ...previous, form: next };
    });
  }, []);
  const draftStateRef = useRef<ConfigDraftState>({ dirty: false, busy: false, discard: () => {} });
  const draftCallback = useRef(onDraftStateChange);
  draftCallback.current = onDraftStateChange;
  const [references, setReferences] = useState<VoiceReferenceItem[]>([]);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // 每个角色面板常驻；切换服务时暂存各自的会话草稿及未上传录音。
  const serviceDrafts = useRef(new Map<string, { form: VoiceForm; file: File | null; text: string; emotion: string }>());
  const savedServiceForms = useRef(new Map<string, VoiceForm>());
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
  const [previewEmotion, setPreviewEmotion] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [playback, setPlayback] = useState<{ source: PlaybackSource; playing: boolean } | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [referenceError, setReferenceError] = useState('');
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
  const [readRetry, setReadRetry] = useState(0);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const previewUrl = useRef<string | null>(null);

  // 角色切换令牌：晚到的响应一律丢弃，避免写进另一个角色的页面状态。
  const roleToken = useRef(0);
  const previewToken = useRef(0);
  const previewAbortRef = useRef<AbortController | null>(null);
  const [previewElapsed, setPreviewElapsed] = useState(0);
  const lastRole = useRef(roleId);
  const lastActive = useRef(editing);
  const serviceSyncSeq = useRef(0);
  const syncedState = useRef<{ roleId: string; version: number; active: boolean | undefined } | null>(null);
  if (lastActive.current !== editing) {
    lastActive.current = editing;
    if (!editing) {
      previewToken.current += 1;
      previewAbortRef.current?.abort();
      previewAbortRef.current = null;
    }
  }
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
    previewToken.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    // 换角色即放锁：旧请求已经作废，不该继续挡住新角色的保存与启停。
    inFlight.current = null;
  }
  // 卸载后挂起的请求同样作废：离开设置页不应再启动播放或写状态。
  const mounted = useRef(true);
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  const formRef = useRef(form);
  formRef.current = form;

  const selectedService = services.find(service => service.serviceId === form.serviceId) ?? null;
  const hasAvailableService = services.some(service => service.enabled);
  const comparison = savedForm?.serviceId === form.serviceId ? savedForm : savedServiceForms.current.get(form.serviceId) ?? createVoiceForm(null);
  const count = Number(pendingFile !== null && (form.protocol === 'indextts' || form.sourceKind === 'reference')) + (savedForm
    ? Number(form.serviceId !== savedForm.serviceId) + (Object.keys(form) as (keyof VoiceForm)[]).filter(key =>
      !['serviceId', 'protocol', 'baseUrl', 'capabilities'].includes(key) && JSON.stringify(form[key]) !== JSON.stringify(comparison[key]),
    ).length
    : 0);
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

  useEffect(() => { if (editing && voiceProbe.notice) announceLive(voiceProbe.notice.text); }, [editing, voiceProbe.notice]);

  const stopPreview = () => {
    const audio = audioRef.current;
    if (audio) {
      audioRef.current = null;
      audio.onplaying = null;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (previewUrl.current !== null) {
      URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    }
    setPlayback(null);
  };

  const resetPreviewRequest = () => {
    previewToken.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewBusy(false);
    stopPreview();
  };

  useEffect(() => {
    draftStateRef.current = {
      dirty: count > 0,
      count,
      busy: busy || toggleBusy,
      discard: () => {
        serviceDrafts.current.clear();
        if (savedForm) setForm(savedForm);
        setPendingFile(null);
        if (fileInput.current) fileInput.current.value = '';
        resetPreviewRequest();
        setPreviewError(''); setReferenceError('');
        voiceProbe.clearLog();
        setPreviewEmotion('');
        setError('');
        setNotice('');
      },
    };
    draftCallback.current?.(draftStateRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, savedForm, busy, toggleBusy]);

  useEffect(() => {
    if (!editing) {
      resetPreviewRequest();
      setPreviewError(''); setReferenceError('');
      voiceProbe.cancelPending();
    }
  }, [editing, voiceProbe.cancelPending]);

  useEffect(() => () => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
  }, []);

  useEffect(() => {
    if (!previewBusy) {
      setPreviewElapsed(0);
      return;
    }
    setPreviewElapsed(0);
    const timer = window.setInterval(() => setPreviewElapsed(seconds => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [previewBusy]);

  useEffect(() => {
    let activeLoad = true;
    const syncSeq = ++serviceSyncSeq.current;
    syncedState.current = { roleId, version: serviceRefreshVersion, active };
    serviceDrafts.current.clear();
    savedServiceForms.current.clear();
    setConfig(null);
    setServices([]);
    setForms({ form: createVoiceForm(null), savedForm: null });
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
    setPreviewError(''); setReferenceError('');
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
        setReferences(reference.items);
        const baseForm = createVoiceForm(voice.voice);
        if (voice.voice?.serviceId) savedServiceForms.current.set(voice.voice.serviceId, baseForm);
        if (syncSeq === serviceSyncSeq.current) {
          setConfig(voice.voice);
          setServices(available.items);
          const initial =
            voice.voice === null ? syncVoiceFormServices(baseForm, available.items) : baseForm;
          setForms({ form: initial, savedForm: initial });
        } else {
          setForms(previous => previous.savedForm === null ? { form: baseForm, savedForm: baseForm } : previous);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, readRetry]);

  useEffect(() => {
    const previousSync = syncedState.current;
    if (!previousSync || previousSync.roleId !== roleId) {
      syncedState.current = { roleId, version: serviceRefreshVersion, active };
      return;
    }
    const versionChanged = previousSync.version !== serviceRefreshVersion;
    const becameActive = Boolean(active && !previousSync.active);
    syncedState.current = { roleId, version: serviceRefreshVersion, active };
    if (!versionChanged && !becameActive) return;
    if (!roleId) return;
    const token = roleToken.current;
    const syncSeq = ++serviceSyncSeq.current;
    Promise.all([
      api<{ voice: VoiceConfigView | null }>(`/v1/roles/${encodeURIComponent(roleId)}/voice`),
      api<{ items: VoiceServiceItem[] }>('/v1/voice-services'),
    ])
      .then(([voice, available]) => {
        if (isStale(token) || syncSeq !== serviceSyncSeq.current) return;
        setConfig(voice.voice);
        setServices(available.items);
        if (voice.voice?.serviceId) savedServiceForms.current.set(voice.voice.serviceId, createVoiceForm(voice.voice));
        setForms(previous => {
          const { form: draft, savedForm: baseline } = previous;
          if (baseline === null) {
            const initial = createVoiceForm(voice.voice);
            const next = voice.voice === null ? syncVoiceFormServices(initial, available.items) : initial;
            return { form: next, savedForm: next };
          }
          // 目录补齐的默认服务属于基线，用户在途选中的其他服务仍属于草稿。
          const sameService = draft.serviceId === baseline.serviceId;
          const next = draft.serviceId || sameService ? syncVoiceFormServices(draft, available.items) : draft;
          const nextBaseline = sameService ? syncVoiceFormServices(baseline, available.items) : baseline;
          return next === draft && nextBaseline === baseline ? previous : { form: next, savedForm: nextBaseline };
        });
      })
      .catch(() => { /* 从设置返回同步失败时保留现有草稿，保存时会触发正式校验 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, serviceRefreshVersion, active]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopPreview();
    };
  }, []);

  const patch = (next: Partial<VoiceForm>) => setForm(previous => ({ ...previous, ...next }));

  const selectService = (nextServiceId: string) => {
    if (nextServiceId === form.serviceId) return;
    resetPreviewRequest();
    setPreviewError(''); setReferenceError('');
    serviceDrafts.current.set(form.serviceId, { form, file: pendingFile, text: previewText, emotion: previewEmotion });
    const picked = services.find(item => item.serviceId === nextServiceId);
    const cached = serviceDrafts.current.get(nextServiceId);
    const base = cached?.form ?? savedServiceForms.current.get(nextServiceId) ?? createVoiceForm(null);
    setForm(picked ? { ...base, serviceId: picked.serviceId, protocol: picked.config.protocol, baseUrl: picked.config.baseUrl } : { ...base, serviceId: nextServiceId });
    setPendingFile(cached?.file ?? null);
    if (fileInput.current) fileInput.current.value = '';
    setPreviewText(cached?.text ?? DEFAULT_PREVIEW_TEXT);
    setPreviewEmotion(cached?.emotion ?? '');
    setError(''); setNotice('');
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

  const playBlob = (blob: Blob, source: PlaybackSource, onPlaying?: () => void) => {
    stopPreview();
    const url = URL.createObjectURL(blob);
    previewUrl.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    setPlayback({ source, playing: false });
    audio.onplaying = () => {
      if (audioRef.current !== audio) return;
      setPlayback({ source, playing: true });
      onPlaying?.();
    };
    audio.onended = () => {
      if (audioRef.current !== audio) return;
      stopPreview();
      if (source === 'preview') setNotice('试听播放完毕。');
    };
    const fail = () => {
      if (audioRef.current !== audio) return;
      if (source === 'preview') { setPreviewError('试听音频无法播放。'); setNotice(''); }
      else setReferenceError('无法播放这段参考录音，请检查文件格式。');
      stopPreview();
    };
    audio.onerror = fail;
    void audio.play().catch(fail);
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

  const validateServiceSelectionBeforeAction = (allowRetained = false): string | null => {
    if (form.serviceId === '' && form.baseUrl.trim().length === 0) {
      return services.length === 0
        ? '还没有语音服务，请先在「设置 -> 模型 -> 语音」中添加。'
        : '请先选择一项语音服务。';
    }
    if (missingSelectedService) {
      return '当前所选语音服务已不存在，请重新选择或前往设置新建。';
    }
    if (disabledSelectedService && (!allowRetained || config?.serviceId !== form.serviceId)) {
      return describeVoiceFailure({ code: 'VOICE_SERVICE_DISABLED' });
    }
    return null;
  };

  const runPreview = async () => {
    if (previewAbortRef.current) return;
    const text = previewText.trim();
    if (text.length === 0) {
      setPreviewError('试听文本不能为空。');
      return;
    }
    const serviceProblem = validateServiceSelectionBeforeAction();
    if (serviceProblem !== null) {
      setPreviewError(serviceProblem);
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
      setPreviewError(issues.map(item => item.message).join('；'));
      return;
    }
    const controller = new AbortController();
    stopPreview();
    previewAbortRef.current = controller;
    setPreviewBusy(true);
    setPreviewError('');
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
        signal: controller.signal,
      });
      // 切到别的角色或已取消后不再播放上一段试听。
      if (controller.signal.aborted || isStale(token) || preview !== previewToken.current) return;
      if (blob.size === 0) {
        setPreviewError('试听返回了空音频。');
        return;
      }
      playBlob(blob, 'preview', () => setNotice(
        stagedFile !== null
          ? `已用待上传录音「${stagedFile.name}」生成临时试听（尚未写入目录），正在播放。`
          : '已按当前表单生成试听，正在播放。',
      ));
    } catch (reason) {
      if (controller.signal.aborted || isStale(token) || preview !== previewToken.current) return;
      setPreviewError(failureText(reason));
    } finally {
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
      if (!isStale(token) && preview === previewToken.current) setPreviewBusy(false);
    }
  };

  const cancelPreview = () => {
    resetPreviewRequest();
    setNotice('已取消本次试听合成。');
  };

  const selectPendingReference = (files: FileList | null) => {
    const file = files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!file || busy) return;
    setError('');
    if (file.size === 0) { setError('参考音频不能为空。'); return; }
    if (file.size > MAX_REFERENCE_AUDIO_BYTES) { setError('参考音频超过 32 MiB 上限。'); return; }
    resetPreviewRequest();
    setReferenceError('');
    setPendingFile(file);
    // 选定新音频必须清空上一段录音遗留的参考文本，但不提前写盘。
    setForm(previous => withPendingReferenceAudio(previous));
    setNotice(`已暂存待上传录音「${file.name}」，可直接生成试听，点保存后正式写入角色目录。`);
  };

  const clearPendingReference = () => {
    if (pendingFile === null || busy) return;
    resetPreviewRequest();
    setReferenceError('');
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
      ), '删除参考音频', false);
      if (isStale(token)) return;
      if (formRef.current.referenceAssetId === item.assetId) {
        setForm(previous => withReferenceAudio(previous, ''));
      }
      reportResult(
        result.fileRemoved
          ? `已删除参考音频「${item.fileName}」。`
          : `已删除「${item.fileName}」的记录，但文件清理失败，可稍后重试。`,
        result.fileRemoved ? 'success' : 'warning',
      );
      await refreshReferences(token);
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
    const serviceProblem = validateServiceSelectionBeforeAction(true);
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
        if (!latest.enabled && config?.serviceId !== submittedForm.serviceId) {
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
      const result = await api<{ voice: VoiceConfigView }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice`,
        {
          method: 'PUT',
          body,
        },
      );
      if (isStale(token)) return;
      if (stateSeq.current === configSeq) setConfig(result.voice);
      setPendingFile(null);
      if (fileInput.current) fileInput.current.value = '';
      const saved = createVoiceForm(result.voice);
      serviceDrafts.current.delete(saved.serviceId);
      if (saved.serviceId) savedServiceForms.current.set(saved.serviceId, saved);
      setForms({ form: saved, savedForm: saved });
      closeNow(undefined, '已保存声音配置');
      void refreshReferences(token).catch(() => { /* 配置已保存；再次打开时仍可读取参考音频列表。 */ });
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
      const result = await api<{ voice: VoiceConfigView }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice/enabled`,
        { method: 'PUT', body: { enabled: next } },
      );
      if (isStale(token)) return;
      setConfig(result.voice);
      stateSeq.current += 1;
      reportResult(
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

  const dirty = count > 0;
  const state: ConfigDraftState = { dirty, count, busy: busy || toggleBusy, discard: () => draftStateRef.current.discard() };
  const tone = form.sourceKind === 'preset' ? form.voiceId : pendingFile?.name || references.find(item => item.assetId === form.referenceAssetId)?.fileName || '';
  const unset = config === null && !dirty;
  const status = unset ? 'off' : dirty ? 'dirty' : !form.serviceId ? 'off' : !selectedService ? 'error' : !selectedService.enabled || !tone || config?.enabled === false ? 'off' : 'ok';
  const statusText = unset ? '未设置' : dirty ? '有改动未保存' : !form.serviceId ? '未设置' : !selectedService ? '原服务已删除' : !selectedService.enabled ? '服务已停用' : !tone ? '未选音色' : config?.enabled === false ? '角色语音已停用' : '生效中';
  useEffect(() => {
    if (loading) { onSummaryStatus?.({ status: 'none', label: '正在读取…' }); return; }
    if (!savedForm && error) { onSummaryStatus?.({ status: 'error', label: '读取失败' }); return; }
    onSummaryStatus?.({ status, label: statusText });
  }, [status, statusText, loading, Boolean(savedForm), Boolean(error), onSummaryStatus]);
  if (loading || (!savedForm && error)) return <MediaStateRow label="语音" loading={loading} error={error} onRetry={() => setReadRetry(value => value + 1)}/>;

  return (<>
    <MediaRow id="voice" label="语音" value={unset || !form.serviceId ? '未选择' : !selectedService ? '原服务已删除，请重新选择' : `${selectedService.name} · ${form.sourceKind === 'preset' ? '预置音色' : '参考音频'}`} status={status} statusText={statusText} keys={!unset && selectedService ? [
      {label:'音色', value:tone || (form.sourceKind === 'preset' ? '未选音色' : '未选参考音频'), group:'音色'},
      {label:'语速', value:`${Number(form.speed).toFixed(1)}×`, group:'表现'},
      {label:'情感强度', value:`情感 ${Number(form.emoAlpha).toFixed(1)}`, group:'表现'},
    ] : []}/>
    <MediaSheet id="voice" active={Boolean(active)} state={state} footer={<RoleSaveActions count={count} pause={false} busy={busy || toggleBusy} error={error} onSave={() => void save()}/>}>
    {group => <div className="nd-voice"><MediaGroup title="服务" group={group}>

      <label className="nd-voice-toggle">
        <input
          type="checkbox"
          checked={config !== null && config.enabled !== false}
          disabled={config === null || busy || toggleBusy || (config.enabled === false && (disabledSelectedService || missingSelectedService))}
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
              <option value={form.serviceId} disabled>{T34.option}</option>
            ) : null}
            {services.map(service => (
              <option key={service.serviceId} value={service.serviceId} disabled={!service.enabled}>
                {service.name}
                {service.enabled ? '' : T33.optionSuffix}
              </option>
            ))}
          </Select>
          {selectedService && !isLegacy ? (
            <Button
              busy={voiceProbe.busy}
              disabled={busy || disabledSelectedService}
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
                  !hasAvailableService ? { createNew: true } : selectedService
                    ? { serviceId: selectedService.serviceId }
                    : undefined,
                )
              }
            >
              {hasAvailableService ? T25.manage : T25.add}
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
            {T33.selectedNote}
          </p>
        ) : null}
        {isLegacy && selectedService ? (
          <small className="nd-voice-note">旧 IndexTTS 协议没有探测接口，请直接用下方试听验证连接。</small>
        ) : null}
      </Field>

      <VoiceProbeFeedback busy={voiceProbe.busy} notice={voiceProbe.notice}/>
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

      </MediaGroup><MediaGroup title="音色" group={group}>{!isLegacy ? (
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
              ? T3
              : voices && voices.length > 0
                ? undefined
                : '可手填音色 ID，或测试连接以获取音色列表。'
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
                resetPreviewRequest();
                setReferenceError('');
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
            <div className="nd-voice-probe nd-voice-reference-playback">
              <small role="status">
                待上传：{pendingFile.name}（{(pendingFile.size / 1024).toFixed(1)} KiB）· 点击「保存声音配置」后正式写入
              </small>
              <Button size="sm" className="nd-voice-playback" disabled={busy || previewBusy}
                aria-busy={playback?.source === 'reference' && !playback.playing || undefined}
                onClick={() => {
                  if (playback?.source === 'reference') { stopPreview(); return; }
                  setReferenceError(''); setNotice('');
                  playBlob(pendingFile, 'reference');
                }}>
                {playback?.source === 'reference' ? <>
                  <VoiceWave state={playback.playing ? 'playing' : 'synthesizing'} />
                  {playback.playing ? '停止参考录音' : '取消载入录音'}
                </> : '播放参考录音'}
              </Button>
              {referenceError && <small role="alert" className="nd-appearance-error">{referenceError}</small>}
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
                ? '测试连接后可选择参考模式。'
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

      </MediaGroup><MediaGroup title="表现" group={group}><div className="config-media-performance"><Field label="语言">
        <Select aria-label="语言" disabled={busy} value={form.language} onChange={event => patch({ language: event.target.value })}>
          {[...new Set([...(languages.length ? languages : ['auto', 'zh', 'ja', 'en']), form.language])].map(code => (
            <option key={code} value={code}>{({ auto: '自动判断', zh: '中文', ja: '日语', en: '英语' } as Record<string, string>)[code] ?? code}</option>
          ))}
        </Select>
      </Field>

      <Field label="语速"><div className="config-media-range">
        <input
          aria-label="语速"
          type="range"
          step="0.1"
          min={speedRange?.min ?? Math.min(0.5, form.speed)}
          max={speedRange?.max ?? Math.max(2, form.speed)}
          disabled={busy}
          value={String(form.speed)}
          onChange={event => patch({ speed: Number(event.target.value) })}
        /><output>{Number(form.speed).toFixed(1)}×</output></div>
      </Field></div>

      <Field label="情感强度"><div className="config-media-range">
        <input
          aria-label="情感强度"
          type="range"
          step="0.1"
          min="0"
          max="1"
          disabled={busy}
          value={String(form.emoAlpha)}
          onChange={event => patch({ emoAlpha: Number(event.target.value) })}
        /><output>{Number(form.emoAlpha).toFixed(1)}</output></div>
      </Field>

      </MediaGroup><MediaGroup title="试听" group={group}>{!isLegacy ? (
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

      <div className="nd-appearance-actions nd-voice-preview-actions">
        <Button className="nd-voice-playback" disabled={busy} aria-busy={previewBusy || undefined} aria-disabled={previewBusy || undefined} onClick={() => void runPreview()}>
          {previewBusy ? <><VoiceWave state="synthesizing" />{`正在合成（${previewElapsed}s）…`}</> : '生成试听'}
        </Button>
        {previewBusy && <Button variant="ghost" onClick={cancelPreview}>取消</Button>}
        <Button className="nd-voice-playback" disabled={playback?.source !== 'preview'} onClick={() => { stopPreview(); setNotice('已停止试听。'); }}>
          {playback?.source === 'preview' && <VoiceWave state={playback.playing ? 'playing' : 'synthesizing'} />}停止播放
        </Button>
      </div>
      {previewError && <p role="alert" className="nd-appearance-error">{previewError}</p>}
      </MediaGroup>
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
    </div>}
    </MediaSheet>
  </>);
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
