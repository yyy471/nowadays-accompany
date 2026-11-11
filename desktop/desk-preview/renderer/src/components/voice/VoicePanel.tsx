import { useEffect, useRef, useState } from 'react';
import { api, apiBinary, apiUpload } from '../../api';
import { Button, Field, Input, LoadingNote, Select, Textarea } from '../../ui';
import {
  createVoiceForm,
  describeProtocolHint,
  describeVoiceFailure,
  describeVoiceSummary,
  isPresetVoiceAvailable,
  isProbeCurrent,
  normalizeBaseUrl,
  resolveCapabilities,
  summarizeProbe,
  toVoicePayload,
  validateVoiceForm,
  withReferenceAudio,
  withVoiceService,
  type VoiceConfigView,
  type VoiceForm,
  type VoiceProbeResult,
  type VoiceReferenceItem,
} from '../../voice-config.js';

type Props = {
  roleId: string;
  onChanged?: () => void;
};

const DEFAULT_PREVIEW_TEXT = '今天想和你一起，慢慢走一段路。';

export function VoicePanel({ roleId, onChanged }: Props) {
  const [config, setConfig] = useState<VoiceConfigView | null>(null);
  const [form, setForm] = useState<VoiceForm>(() => createVoiceForm(null));
  const [references, setReferences] = useState<VoiceReferenceItem[]>([]);
  const [probe, setProbe] = useState<VoiceProbeResult | null>(null);
  const [probeSource, setProbeSource] = useState<{ baseUrl: string; protocol: string } | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [previewText, setPreviewText] = useState(DEFAULT_PREVIEW_TEXT);
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
  const lastRole = useRef(roleId);
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
    // 换角色即放锁：旧请求已经作废，不该继续挡住新角色的保存与启停。
    inFlight.current = null;
  }
  // 卸载后挂起的请求同样作废：离开设置页不应再启动播放或写状态。
  const mounted = useRef(true);
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  // 异步回调里读取最新表单，用于判断探测结果是否仍对应当前地址。
  const formRef = useRef(form);
  formRef.current = form;

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
    let active = true;
    setConfig(null); setForm(createVoiceForm(null)); setReferences([]);
    setProbe(null); setProbeSource(null); setNotice(''); setError('');
    setProbeBusy(false); setPreviewBusy(false); setBusy(false); setToggleBusy(false);
    setLoading(true); setPlaying(false);
    stopPreview();
    if (!roleId) { setLoading(false); return; }
    Promise.all([
      api<{ voice: VoiceConfigView | null }>(`/v1/roles/${encodeURIComponent(roleId)}/voice`),
      api<{ items: VoiceReferenceItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/voice/references`),
    ]).then(([voice, reference]) => {
      if (!active) return;
      setConfig(voice.voice);
      setForm(createVoiceForm(voice.voice));
      setReferences(reference.items);
      setLoading(false);
    }).catch(reason => {
      if (!active) return;
      setError(failureText(reason));
      setLoading(false);
    });
    return () => { active = false; };
  }, [roleId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopPreview();
    };
  }, []);

  const patch = (next: Partial<VoiceForm>) => setForm(previous => ({ ...previous, ...next }));

  const refreshReferences = async (token: number) => {
    const result = await api<{ items: VoiceReferenceItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/voice/references`);
    if (isStale(token)) return;
    setReferences(result.items);
  };

  const runProbe = async () => {
    if (probeBusy || form.protocol === 'indextts') return;
    const token = roleToken.current;
    const source = { baseUrl: normalizeBaseUrl(form.baseUrl), protocol: form.protocol };
    setProbeBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ probe: VoiceProbeResult }>(`/v1/roles/${encodeURIComponent(roleId)}/voice/probe`, {
        method: 'POST',
        body: { baseUrl: form.baseUrl.trim() },
      });
      if (isStale(token)) return;
      const latest = formRef.current;
      if (normalizeBaseUrl(latest.baseUrl) !== source.baseUrl || latest.protocol !== source.protocol) {
        // 探测期间地址或协议改了，这份结果属于旧服务，直接丢弃。
        setNotice('地址已修改，刚才的探测结果已丢弃，请重新测试。');
        return;
      }
      setProbe(result.probe);
      setProbeSource(source);
      patch({ capabilities: result.probe.capabilities });
      if (latest.sourceKind === 'preset' && latest.voiceId.trim().length > 0
        && isPresetVoiceAvailable(result.probe.voices, latest.voiceId) === false) {
        setError('当前预置音色已不在服务端列表里，请重新选择后再试听或保存。');
        return;
      }
      setNotice(result.probe.ready
        ? `已连接 ${result.probe.service}（${result.probe.model}）`
        : `${result.probe.service} 已响应，但当前未就绪。`);
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      if (!isStale(token)) setProbeBusy(false);
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

  const runPreview = async () => {
    const text = previewText.trim();
    if (text.length === 0) { setError('试听文本不能为空。'); return; }
    const token = roleToken.current;
    const issues = validateVoiceForm(form, { capabilities: activeCapabilities });
    if (issues.length > 0) { setError(issues.map(item => item.message).join('；')); return; }
    setPreviewBusy(true); setError(''); setNotice('');
    try {
      const blob = await apiBinary(`/v1/roles/${encodeURIComponent(roleId)}/voice/preview`, {
        method: 'POST',
        body: { text, ...toVoicePayload(form, { capabilities: activeCapabilities }) },
      });
      // 切到别的角色后不再播放上一段试听。
      if (isStale(token)) return;
      if (blob.size === 0) { setError('试听返回了空音频。'); return; }
      playBlob(blob);
      setNotice('已按当前表单生成试听，正在播放。');
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      if (!isStale(token)) setPreviewBusy(false);
    }
  };

  const uploadReference = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy) return;
    const token = roleToken.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      const result = await apiUpload<{ reference: { assetId: string; fileName: string } }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice/reference`,
        body,
      );
      if (isStale(token)) return;
      // 新录音不能沿用上一段录音的参考文本。
      setForm(previous => ({ ...withReferenceAudio(previous, result.reference.assetId), sourceKind: 'reference' }));
      await refreshReferences(token);
      if (isStale(token)) return;
      setNotice(`已上传参考音频「${result.reference.fileName}」，保存后生效。`);
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      // 过期操作不能清掉当前角色的忙碌状态。
      if (!isStale(token)) {
        setBusy(false);
        if (fileInput.current) fileInput.current.value = '';
      }
    }
  };

  const removeReference = async (item: VoiceReferenceItem) => {
    if (busy) return;
    if (item.inUse) { setError('这段参考音频正在使用，先切换到其他音色再删除。'); return; }
    const token = roleToken.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ deleted: boolean; fileRemoved: boolean }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice/references/${encodeURIComponent(item.assetId)}`,
        { method: 'DELETE' },
      );
      if (isStale(token)) return;
      if (formRef.current.referenceAssetId === item.assetId) {
        setForm(previous => withReferenceAudio(previous, ''));
      }
      await refreshReferences(token);
      if (isStale(token)) return;
      setNotice(result.fileRemoved
        ? `已删除参考音频「${item.fileName}」。`
        : `已删除「${item.fileName}」的记录，但文件清理失败，可稍后重试。`);
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
    const issues = validateVoiceForm(form, { capabilities: activeCapabilities });
    if (issues.length > 0) { setError(issues.map(item => item.message).join('；')); return; }
    const lock = acquire('save');
    const token = roleToken.current;
    const configSeq = stateSeq.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ voice: VoiceConfigView }>(`/v1/roles/${encodeURIComponent(roleId)}/voice`, {
        method: 'PUT',
        body: toVoicePayload(form, { capabilities: activeCapabilities }),
      });
      if (isStale(token)) return;
      if (stateSeq.current === configSeq) setConfig(result.voice);
      setForm(createVoiceForm(result.voice));
      setProbe(null);
      setProbeSource(null);
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
    setToggleBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ voice: VoiceConfigView }>(
        `/v1/roles/${encodeURIComponent(roleId)}/voice/enabled`,
        { method: 'PUT', body: { enabled: next } },
      );
      if (isStale(token)) return;
      setConfig(result.voice);
      stateSeq.current += 1;
      setNotice(result.voice.enabled
        ? '已启用角色语音，对话会按句合成。'
        : '已停用角色语音，配置已保留，随时可以再启用。');
      onChanged?.();
    } catch (reason) {
      if (isStale(token)) return;
      setError(failureText(reason));
    } finally {
      release(lock);
      if (!isStale(token)) setToggleBusy(false);
    }
  };

  // 能力声明只在「表单仍指向已保存服务」或「刚探测过同一地址」时有效。
  const activeCapabilities = resolveCapabilities({ config, form, probe, probeSource });
  const probeMatches = isProbeCurrent(probeSource, form);

  if (loading) return <LoadingNote label="正在读取声音配置…" />;

  const summary = probeMatches && probe !== null ? summarizeProbe(probe) : null;
  const capabilities = activeCapabilities;
  const isLegacy = form.protocol === 'indextts';
  const usePreset = !isLegacy && form.sourceKind === 'preset';
  const modes = capabilities?.referenceModes ?? [];
  const selectedMode = modes.find(mode => mode.id === form.referenceMode) ?? null;
  const languages = capabilities?.languages ?? [];
  const speedRange = capabilities?.speed ?? null;
  const voices = probeMatches ? probe?.voices ?? null : null;

  return <div className="nd-voice">
    <p className="nd-appearance-hint">{describeVoiceSummary(config)}</p>

    <label className="nd-voice-toggle">
      <input
        type="checkbox"
        checked={config !== null && config.enabled !== false}
        disabled={config === null || busy || toggleBusy}
        onChange={event => void toggleVoiceEnabled(event.target.checked)}
      />
      <span>启用角色语音</span>
      <small>{config === null
        ? '保存配置后可以启用或停用。'
        : config.enabled === false
          ? '已停用：对话不再合成语音，这份配置保留。'
          : '对话会按句合成语音。'}</small>
    </label>

    <Field label="协议" hint={describeProtocolHint(form)}>
      <Select value={form.protocol} disabled={busy} onChange={event => setForm(previous => withVoiceService(previous, { protocol: event.target.value as VoiceForm['protocol'] }))}>
        <option value="nowadays-tts-v1">统一语音协议</option>
        <option value="indextts">旧 IndexTTS 协议</option>
      </Select>
    </Field>

    <Field label="服务地址" hint="换地址或协议会清空预置音色与参考模式，需要在新服务下重新选择；参考录音会保留。">
      <Input value={form.baseUrl} placeholder="http://127.0.0.1:8000" disabled={busy} onChange={event => setForm(previous => withVoiceService(previous, { baseUrl: event.target.value }))} />
    </Field>

    <div className="nd-appearance-actions">
      <Button disabled={busy || probeBusy || isLegacy || form.baseUrl.trim().length === 0} onClick={() => void runProbe()}>
        {probeBusy ? '正在测试…' : '测试连接'}
      </Button>
      {isLegacy ? <small className="nd-voice-note">旧协议没有探测接口，用下方试听验证连接。</small> : null}
    </div>
    {summary !== null ? <div className="nd-voice-probe">
      <small>{summary.service || '未知服务'} · {summary.model || '未知模型'} · {summary.ready ? '已就绪' : '未就绪'}</small>
      <small>参考模式 {summary.referenceModes.length} 种 · 预置音色 {summary.supportsPreset ? `${summary.presetVoiceCount} 个` : '不支持'} · 语言 {summary.languages.length > 0 ? summary.languages.join('、') : '未声明'}{summary.speed === null ? '' : ` · 语速 ${summary.speed.min}～${summary.speed.max}`}</small>
    </div> : null}

    {!isLegacy ? <Field label="音色来源">
      <Select value={form.sourceKind} disabled={busy} onChange={event => patch({ sourceKind: event.target.value as VoiceForm['sourceKind'] })}>
        <option value="reference">参考音频</option>
        <option value="preset">预置音色</option>
      </Select>
    </Field> : null}

    {usePreset ? <Field label="预置音色" hint={capabilities !== null && capabilities.presetVoices === false
      ? '当前服务未声明预置音色，保存会被拒绝，请改用参考音频音色。'
      : voices && voices.length > 0 ? '列表来自最近一次连接测试。' : '可以先测试连接再选，也可以直接填写音色 ID。'}>
      {voices && voices.length > 0
        ? <Select value={form.voiceId} disabled={busy} onChange={event => patch({ voiceId: event.target.value })}>
          <option value="">请选择音色</option>
          {voices.map(voice => <option key={voice.id} value={voice.id}>{voice.label || voice.id}</option>)}
          {form.voiceId.length > 0 && !voices.some(voice => voice.id === form.voiceId)
            ? <option value={form.voiceId}>{form.voiceId}（不在服务端列表）</option>
            : null}
        </Select>
        : <Input value={form.voiceId} placeholder="音色 ID" disabled={busy} onChange={event => patch({ voiceId: event.target.value })} />}
    </Field> : <>
      <Field label="参考音频" hint="使用中的参考音频不能删除，先切换到其他音色。换录音会清空参考文本。">
        <Select value={form.referenceAssetId} disabled={busy} onChange={event => setForm(previous => withReferenceAudio(previous, event.target.value))}>
          <option value="">请选择参考音频</option>
          {references.map(item => <option key={item.assetId} value={item.assetId}>{item.fileName}{item.inUse ? '（使用中）' : ''}</option>)}
          {form.referenceAssetId.length > 0 && !references.some(item => item.assetId === form.referenceAssetId)
            ? <option value={form.referenceAssetId}>已选音频（列表里没有）</option>
            : null}
        </Select>
      </Field>
      <div className="nd-appearance-actions">
        <input ref={fileInput} type="file" accept="audio/wav,audio/mpeg,audio/flac,audio/ogg" className="nd-visually-hidden" onChange={event => void uploadReference(event.target.files)} />
        <Button disabled={busy} onClick={() => fileInput.current?.click()}>上传参考音频</Button>
        <small className="nd-voice-note">支持 WAV、MP3、FLAC、OGG，单个不超过 32 MiB。</small>
      </div>
      {references.length > 0 ? <ul className="nd-voice-references">
        {references.map(item => <li key={item.assetId}>
          <span>{item.fileName}{item.inUse ? <em>使用中</em> : null}</span>
          <button type="button" disabled={busy || item.inUse} onClick={() => void removeReference(item)}>删除</button>
        </li>)}
      </ul> : <p className="nd-appearance-empty">还没有上传参考音频。</p>}
      {modes.length > 0 ? <Field label="参考模式" hint="模式由当前服务声明，换服务后需要重新选择。">
        <Select value={form.referenceMode} disabled={busy} onChange={event => patch({ referenceMode: event.target.value })}>
          <option value="">请选择参考模式</option>
          {modes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}{mode.requiresReferenceText ? '（需参考文本）' : ''}</option>)}
        </Select>
      </Field> : isLegacy ? null : <p className="nd-appearance-hint">{capabilities === null
        ? '当前服务还没有能力声明，先点「测试连接」，再选择参考模式。'
        : '当前服务未声明参考音频模式，不能使用参考音频音色，请改用预置音色。'}</p>}
      {selectedMode?.requiresReferenceText ? <Field label="参考文本" hint="服务要求与参考音频对应的文本，用于对齐音色。换录音后需要重新填写。">
        <Textarea rows={3} value={form.referenceText} disabled={busy} onChange={event => patch({ referenceText: event.target.value })} />
      </Field> : null}
    </>}

    <Field label="语言">
      {languages.length > 0
        ? <Select value={form.language} disabled={busy} onChange={event => patch({ language: event.target.value })}>
          {languages.map(code => <option key={code} value={code}>{code}</option>)}
        </Select>
        : <Input value={form.language} disabled={busy} onChange={event => patch({ language: event.target.value })} />}
    </Field>

    <Field label="语速" hint={speedRange === null ? '服务未声明语速范围，保存时由服务端判断。' : `服务声明范围 ${speedRange.min}～${speedRange.max}。`}>
      <Input
        type="number"
        step="0.05"
        min={speedRange?.min ?? 0.1}
        max={speedRange?.max ?? 10}
        value={String(form.speed)}
        disabled={busy}
        onChange={event => patch({ speed: Number(event.target.value) })}
      />
    </Field>

    <Field label="情感强度" hint="0 到 1，越高越贴近参考音频的情绪。">
      <Input
        type="number"
        step="0.05"
        min="0"
        max="1"
        value={String(form.emoAlpha)}
        disabled={busy}
        onChange={event => patch({ emoAlpha: Number(event.target.value) })}
      />
    </Field>

    <Field label="试听文本">
      <Textarea rows={2} value={previewText} maxLength={4000} disabled={busy || previewBusy} onChange={event => setPreviewText(event.target.value)} />
    </Field>

    <div className="nd-appearance-actions">
      <Button disabled={busy || previewBusy} onClick={() => void runPreview()}>{previewBusy ? '正在合成…' : '生成试听'}</Button>
      <Button disabled={!playing} onClick={stopPreview}>停止播放</Button>
      <Button variant="primary" disabled={busy || toggleBusy} onClick={() => void save()}>{busy ? '正在保存…' : '保存声音配置'}</Button>
    </div>
    {notice ? <p className="nd-appearance-notice" role="status">{notice}</p> : null}
    {error ? <p className="nd-appearance-error" role="alert">{error}</p> : null}
  </div>;
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
