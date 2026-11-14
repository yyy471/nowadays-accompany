import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Button, Disclosure, Field, Input, LoadingNote, Select, Textarea } from '../../ui';
import type { ConfigDraftState } from '../config-draft';
import {
  createImageForm,
  describeImageFailure,
  describeImageSummary,
  imageServiceSnapshotKey,
  summarizeImageProbe,
  toImagePayload,
  toSceneImagePreviewPayload,
  validateImageForm,
  withOutfitPrompt,
  type ImageForm,
  type ImagePreview,
  type ImageProbeResult,
  type ImageSettingsViewPayload,
} from '../../image-config.js';

type Props = {
  roleId: string;
  active?: boolean;
  serviceRefreshVersion?: number;
  serviceEpochs?: Record<string, number>;
  outfitRefreshVersion?: number;
  onOpenImageSettings?: (target?: { serviceId?: string; createNew?: boolean }) => void;
  onChanged?: () => void;
  onDraftStateChange?: (state: ConfigDraftState) => void;
  guardWrite?: <T>(action: () => Promise<T>) => Promise<T>;
  pausedWrite?: boolean;
};

interface ServiceItem {
  serviceId: string;
  name: string;
  enabled: boolean;
  updatedAt?: string;
  config: {
    protocol?: 'comfyui';
    baseUrl: string;
    credentialRef?: string;
    timeoutMs?: number;
  };
  credential: {
    status: string;
    reference?: string | null;
    resolvable?: boolean;
  };
}

interface OutfitItem {
  outfitId: string;
  name: string;
}

interface TaggedProbe {
  serviceId: string;
  snapshotKey: string;
  result: ImageProbeResult;
}

interface TaggedPreview {
  serviceId: string;
  snapshotKey: string;
  result: ImagePreview;
}

type NoticeKind = '' | 'probe' | 'preview' | 'save';

const DEFAULT_PREVIEW_PROMPT = '半身肖像，柔和自然光，背景简洁，细节清晰';

function failureText(reason: unknown): string {
  if (reason instanceof ApiError) return describeImageFailure(reason.code, reason.message);
  return reason instanceof Error ? reason.message : String(reason);
}

export function ImagePanel({
  roleId,
  active = true,
  serviceRefreshVersion = 0,
  serviceEpochs = {},
  outfitRefreshVersion = 0,
  onOpenImageSettings,
  onChanged,
  onDraftStateChange,
  guardWrite = action => action(),
  pausedWrite = false,
}: Props) {
  const modelsListId = `nd-image-models-${useId()}`;
  const [view, setView] = useState<ImageSettingsViewPayload | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [outfits, setOutfits] = useState<OutfitItem[]>([]);
  const [form, setForm] = useState<ImageForm>(() => createImageForm(null));
  const [savedForm, setSavedForm] = useState<ImageForm | null>(null);
  const draftCallback = useRef(onDraftStateChange);
  draftCallback.current = onDraftStateChange;
  const [probe, setProbe] = useState<TaggedProbe | null>(null);
  const [preview, setPreview] = useState<TaggedPreview | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState(DEFAULT_PREVIEW_PROMPT);
  const [previewOutfitId, setPreviewOutfitId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<NoticeKind>('');
  const [error, setError] = useState('');

  // 角色切换与草稿变更令牌：晚到的探测／试生图响应不写回过时草稿或其他角色。
  const roleToken = useRef(0);
  const probeSeq = useRef(0);
  const previewSeq = useRef(0);
  const lastRole = useRef(roleId);
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
    probeSeq.current += 1;
    previewSeq.current += 1;
  }
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const servicesRef = useRef(services);
  servicesRef.current = services;
  const serviceEpochsRef = useRef(serviceEpochs);
  serviceEpochsRef.current = serviceEpochs;
  const formRef = useRef(form);
  formRef.current = form;
  const probeRef = useRef(probe);
  probeRef.current = probe;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewOutfitRef = useRef(previewOutfitId);
  previewOutfitRef.current = previewOutfitId;
  const noticeKindRef = useRef(noticeKind);
  noticeKindRef.current = noticeKind;
  const initialServiceSync = useRef(true);
  const initialOutfitSync = useRef(true);
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  const snapshotKeyFor = (serviceId: string, list: ServiceItem[] = servicesRef.current): string => {
    const matched = list.find(item => item.serviceId === serviceId);
    if (!matched) return '';
    return imageServiceSnapshotKey(matched, serviceEpochsRef.current[serviceId] ?? 0);
  };

  // 所有推进 probeSeq/previewSeq 的路径同步释放对应 busy 态，防止在途请求因序号失配把按钮长期锁死。
  const invalidateProbe = (clearResult: boolean) => {
    probeSeq.current += 1;
    setProbeBusy(false);
    if (clearResult) {
      setProbe(null);
      if (noticeKindRef.current === 'probe') { setNotice(''); setNoticeKind(''); }
    }
  };

  const invalidatePreview = (clearResult: boolean) => {
    previewSeq.current += 1;
    setPreviewBusy(false);
    if (clearResult) {
      setPreview(null);
      if (noticeKindRef.current === 'preview') { setNotice(''); setNoticeKind(''); }
    }
  };

  useEffect(() => {
    draftCallback.current?.({
      dirty: savedForm !== null && JSON.stringify(form) !== JSON.stringify(savedForm),
      busy: busy || probeBusy || previewBusy,
      discard: () => {
        invalidateProbe(true);
        invalidatePreview(true);
        if (savedForm) setForm(savedForm);
        setError(''); setNotice(''); setNoticeKind('');
      },
    });
  }, [form, savedForm, busy, probeBusy, previewBusy]);

  useEffect(() => {
    if (!active) {
      invalidateProbe(false);
      invalidatePreview(false);
    }
  }, [active]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const token = roleToken.current;
    invalidateProbe(true);
    invalidatePreview(true);
    setLoading(true); setError(''); setNotice(''); setNoticeKind(''); setView(null);
    setForm(createImageForm(null)); setSavedForm(null);
    if (!roleId) { setLoading(false); return; }
    Promise.all([
      api<ImageSettingsViewPayload>(`/v1/roles/${encodeURIComponent(roleId)}/scene-image`),
      api<{ items: ServiceItem[] }>('/v1/image-services'),
      api<{ items: OutfitItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`),
    ]).then(([config, available, wardrobe]) => {
      if (isStale(token)) return;
      setView(config);
      servicesRef.current = available.items;
      setServices(available.items);
      setOutfits(wardrobe.items);
      setPreviewOutfitId(prev => prev && !wardrobe.items.some(item => item.outfitId === prev) ? '' : prev);
      const next = createImageForm(config.settings);
      if (next.serviceId === '' && available.items.length > 0) {
        next.serviceId = available.items[0]!.serviceId;
      }
      setForm(next); setSavedForm(next);
      setLoading(false);
    }).catch(reason => {
      if (isStale(token)) return;
      setError(failureText(reason));
      setLoading(false);
    });
    // isStale 依赖 ref，不需要进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId]);

  useEffect(() => {
    if (initialServiceSync.current) {
      initialServiceSync.current = false;
      return;
    }
    if (!roleId) return;
    const token = roleToken.current;
    Promise.all([
      api<ImageSettingsViewPayload>(`/v1/roles/${encodeURIComponent(roleId)}/scene-image`),
      api<{ items: ServiceItem[] }>('/v1/image-services'),
    ])
      .then(([config, available]) => {
        if (isStale(token)) return;
        setView(config);
        servicesRef.current = available.items;
        setServices(available.items);
        const currentServiceId = formRef.current.serviceId;
        const nextKey = snapshotKeyFor(currentServiceId, available.items);
        const currentService = available.items.find(item => item.serviceId === currentServiceId);
        const serviceInvalidated = !currentService || !currentService.enabled || nextKey === '';
        if (probeRef.current && (
          probeRef.current.serviceId !== currentServiceId ||
          serviceInvalidated ||
          probeRef.current.snapshotKey !== nextKey
        )) {
          invalidateProbe(true);
        } else if (serviceInvalidated) {
          invalidateProbe(false);
        }
        if (previewRef.current && (
          previewRef.current.serviceId !== currentServiceId ||
          serviceInvalidated ||
          previewRef.current.snapshotKey !== nextKey
        )) {
          invalidatePreview(true);
        } else if (serviceInvalidated) {
          invalidatePreview(false);
        }
        setForm(previous => {
          if (previous.serviceId === '' && available.items.length > 0) {
            return { ...previous, serviceId: available.items[0]!.serviceId };
          }
          return previous;
        });
      })
      .catch(() => { /* 从设置返回同步失败时保留现有草稿，保存时会触发正式校验 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, serviceRefreshVersion]);

  useEffect(() => {
    if (initialOutfitSync.current) {
      initialOutfitSync.current = false;
      return;
    }
    if (!roleId) return;
    const token = roleToken.current;
    api<{ items: OutfitItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`)
      .then(wardrobe => {
        if (isStale(token)) return;
        setOutfits(wardrobe.items);
        const selectedOutfitId = previewOutfitRef.current;
        if (selectedOutfitId && !wardrobe.items.some(item => item.outfitId === selectedOutfitId)) {
          setPreviewOutfitId('');
          invalidatePreview(true);
        }
      })
      .catch(() => { /* 外观列表刷新失败时不覆盖已有选择 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, outfitRefreshVersion]);

  const updateForm = (updater: (previous: ImageForm) => ImageForm) => {
    invalidatePreview(false);
    setForm(previous => updater(previous));
  };

  const patch = (next: Partial<ImageForm>) => {
    if (next.serviceId !== undefined && next.serviceId !== form.serviceId) {
      invalidateProbe(true);
      invalidatePreview(true);
    }
    updateForm(previous => ({ ...previous, ...next }));
  };

  const save = async () => {
    if (busy) return;
    const issues = validateImageForm(form);
    if (issues.length > 0) { setError(issues[0]!.message); return; }
    const currentLocal = services.find(service => service.serviceId === form.serviceId);
    if (!currentLocal) {
      setError('当前所选生图服务已不存在，请重新选择或前往设置新建。');
      return;
    }
    if (!currentLocal.enabled) {
      setError(describeImageFailure('IMAGE_SERVICE_DISABLED', ''));
      return;
    }
    const token = roleToken.current;
    const submittedForm = form;
    setBusy(true); setError(''); setNotice(''); setNoticeKind('');
    try {
      // 提交保存前先从后端读取一次最新生图服务列表，确保不会先把活跃角色停下来再因停用/删除失败（292 R05）。
      const available = await api<{ items: ServiceItem[] }>('/v1/image-services');
      if (isStale(token)) return;
      servicesRef.current = available.items;
      setServices(available.items);
      const latest = available.items.find(service => service.serviceId === submittedForm.serviceId);
      if (!latest) {
        setError('当前所选生图服务已不存在，请重新选择或前往设置新建。');
        return;
      }
      if (!latest.enabled) {
        setError(describeImageFailure('IMAGE_SERVICE_DISABLED', ''));
        return;
      }
      const saved = await guardWrite(() => api<ImageSettingsViewPayload>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image`,
        { method: 'PUT', body: toImagePayload(submittedForm) },
      ));
      if (isStale(token)) return;
      setView(saved);
      setSavedForm(submittedForm);
      setNoticeKind('save');
      setNotice('已保存生图配置。');
      onChanged?.();
    } catch (reason) {
      if (!isStale(token)) setError(failureText(reason));
    } finally {
      if (!isStale(token)) setBusy(false);
    }
  };

  const runProbe = async () => {
    if (probeBusy) return;
    if (!form.serviceId) { setError('先选择或前往设置添加一个生图服务'); return; }
    const currentLocal = services.find(service => service.serviceId === form.serviceId);
    if (!currentLocal) {
      setError('当前所选生图服务已不存在，请重新选择或前往设置新建。');
      return;
    }
    const targetServiceId = currentLocal.serviceId;
    const requestKey = snapshotKeyFor(targetServiceId);
    const token = roleToken.current;
    const seq = ++probeSeq.current;
    setProbeBusy(true); setError(''); setNotice(''); setNoticeKind('');
    try {
      const result = await api<ImageProbeResult>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image/probe`,
        {
          method: 'POST',
          body: {
            serviceId: targetServiceId,
            ...(form.workflow ? { workflow: form.workflow } : {}),
          },
        },
      );
      if (
        isStale(token) ||
        probeSeq.current !== seq ||
        !activeRef.current ||
        formRef.current.serviceId !== targetServiceId ||
        snapshotKeyFor(targetServiceId) !== requestKey
      ) {
        return;
      }
      setProbe({ serviceId: targetServiceId, snapshotKey: requestKey, result });
      setNoticeKind('probe');
      setNotice(result.probe.workflowReady ? '服务可用。' : '服务能连上，但工作流还缺节点。');
    } catch (reason) {
      if (
        !isStale(token) &&
        probeSeq.current === seq &&
        activeRef.current &&
        formRef.current.serviceId === targetServiceId &&
        snapshotKeyFor(targetServiceId) === requestKey
      ) {
        setError(failureText(reason));
      }
    } finally {
      if (!isStale(token) && probeSeq.current === seq) setProbeBusy(false);
    }
  };

  const runPreview = async () => {
    if (previewBusy) return;
    const issues = validateImageForm(form);
    if (issues.length > 0) { setError(issues[0]!.message); return; }
    const currentLocal = services.find(service => service.serviceId === form.serviceId);
    if (!currentLocal) {
      setError('当前所选生图服务已不存在，请重新选择或前往设置新建。');
      return;
    }
    if (!currentLocal.enabled) {
      setError(describeImageFailure('IMAGE_SERVICE_DISABLED', ''));
      return;
    }
    const targetServiceId = currentLocal.serviceId;
    const requestKey = snapshotKeyFor(targetServiceId);
    const token = roleToken.current;
    const seq = ++previewSeq.current;
    setPreviewBusy(true); setError(''); setNotice(''); setNoticeKind('');
    try {
      const result = await api<ImagePreview>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image/preview`,
        {
          method: 'POST',
          body: toSceneImagePreviewPayload(form, {
            prompt: previewPrompt,
            outfitId: previewOutfitId,
          }),
        },
      );
      if (
        isStale(token) ||
        previewSeq.current !== seq ||
        !activeRef.current ||
        formRef.current.serviceId !== targetServiceId ||
        snapshotKeyFor(targetServiceId) !== requestKey
      ) {
        return;
      }
      setPreview({ serviceId: targetServiceId, snapshotKey: requestKey, result });
      setNoticeKind('preview');
      setNotice(`已用当前草稿生成测试样图（${result.width}×${result.height}），未改动已保存配置。`);
    } catch (reason) {
      if (
        !isStale(token) &&
        previewSeq.current === seq &&
        activeRef.current &&
        formRef.current.serviceId === targetServiceId &&
        snapshotKeyFor(targetServiceId) === requestKey
      ) {
        setError(failureText(reason));
      }
    } finally {
      if (!isStale(token) && previewSeq.current === seq) setPreviewBusy(false);
    }
  };

  const selectedService = services.find(service => service.serviceId === form.serviceId);
  const missingSelectedService = form.serviceId !== '' && !selectedService;
  const disabledSelectedService = Boolean(selectedService && !selectedService.enabled);
  const currentSnapshotKey = selectedService
    ? imageServiceSnapshotKey(selectedService, serviceEpochs[selectedService.serviceId] ?? 0)
    : '';
  const probeValid =
    probe !== null &&
    probe.serviceId === form.serviceId &&
    selectedService !== undefined &&
    selectedService.enabled &&
    probe.snapshotKey !== '' &&
    probe.snapshotKey === currentSnapshotKey;
  const previewValid =
    preview !== null &&
    preview.serviceId === form.serviceId &&
    selectedService !== undefined &&
    selectedService.enabled &&
    preview.snapshotKey !== '' &&
    preview.snapshotKey === currentSnapshotKey;

  useEffect(() => {
    if (probe !== null && !probeValid) invalidateProbe(true);
    if (preview !== null && !previewValid) invalidatePreview(true);
  }, [probe, probeValid, preview, previewValid]);

  if (loading) return <LoadingNote label="正在读取生图配置…" />;

  const activeProbe = probeValid ? probe.result : null;
  const activePreview = previewValid ? preview.result : null;
  const summary = describeImageSummary(view);
  const probeText = summarizeImageProbe(activeProbe?.probe);
  const detectedModels = activeProbe?.probe.models ?? [];

  return <div className="nd-image">
    <p className="nd-appearance-hint">{summary}</p>

    <Field label="生图服务" hint="ComfyUI 地址在全局维护，同一地址可以跑不同模型。">
      <div className="nd-image-service-row">
        <Select value={form.serviceId} disabled={busy} onChange={event => patch({ serviceId: event.target.value })}>
          {services.length === 0 && <option value="">还没有生图服务</option>}
          {services.length > 0 && form.serviceId === '' && <option value="">请选择生图服务</option>}
          {missingSelectedService && <option value={form.serviceId}>原服务已删除（请重新选择）</option>}
          {services.map(service => <option key={service.serviceId} value={service.serviceId}>
            {service.name}{service.enabled ? '' : '（已停用）'}
          </option>)}
        </Select>
        {onOpenImageSettings && <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenImageSettings(
            selectedService
              ? { serviceId: selectedService.serviceId }
              : services.length === 0
                ? { createNew: true }
                : undefined,
          )}
        >
          在设置中管理 →
        </Button>}
      </div>
      {missingSelectedService && <p role="alert" className="nd-appearance-hint nd-image-warn">当前所选生图服务已不存在，请重新选择或前往设置新建。</p>}
      {disabledSelectedService && <p role="alert" className="nd-appearance-hint nd-image-warn">当前所选生图服务已停用，请先启用或重新选择。</p>}
    </Field>

    <Field label="模型目录" hint="MOSS-Image 的本地目录或探测到的模型名，需含 transformer／text_encoder／tokenizer／vae。">
      <Input
        list={detectedModels.length > 0 ? modelsListId : undefined}
        value={form.modelPath}
        maxLength={2000}
        placeholder="/models/MOSS-Image-Base"
        onChange={event => patch({ modelPath: event.target.value })}
      />
      {detectedModels.length > 0 && <>
        <datalist id={modelsListId}>
          {detectedModels.map(name => <option key={name} value={name} />)}
        </datalist>
        <div className="nd-image-models" role="group" aria-label="探测到的生图模型">
          {detectedModels.map(name => <Button
            key={name}
            variant={form.modelPath === name ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => patch({ modelPath: name })}
          >
            {name}
          </Button>)}
        </div>
      </>}
    </Field>
    <Field label="基础锚点提示词" hint="脸型、发型、发色、瞳色等跨场景保持稳定的特征。">
      <Textarea rows={3} value={form.basePrompt} maxLength={2000} onChange={event => patch({ basePrompt: event.target.value })} />
    </Field>

    <Disclosure title="生成参数与服饰锚点" description="负向提示词、尺寸、步数、CFG、采样器、种子与各服饰提示词">
      <Field label="负向提示词">
        <Input value={form.negativePrompt} maxLength={2000} onChange={event => patch({ negativePrompt: event.target.value })} />
      </Field>

      <div className="nd-image-grid">
        <Field label="宽度"><Input type="number" min={256} max={2048} step={16} value={form.width} onChange={event => patch({ width: Number(event.target.value) })} /></Field>
        <Field label="高度"><Input type="number" min={256} max={2048} step={16} value={form.height} onChange={event => patch({ height: Number(event.target.value) })} /></Field>
        <Field label="步数"><Input type="number" min={1} max={150} value={form.steps} onChange={event => patch({ steps: Number(event.target.value) })} /></Field>
        <Field label="CFG"><Input type="number" min={0} max={30} step={0.5} value={form.cfg} onChange={event => patch({ cfg: Number(event.target.value) })} /></Field>
        <Field label="采样器"><Input value={form.sampler} onChange={event => patch({ sampler: event.target.value })} /></Field>
        <Field label="调度器"><Input value={form.scheduler} onChange={event => patch({ scheduler: event.target.value })} /></Field>
        <Field label="种子" hint="留空则每次随机。">
          <Input
            type="number"
            min={0}
            value={form.seed === null ? '' : form.seed}
            placeholder="随机"
            onChange={event => patch({ seed: event.target.value === '' ? null : Number(event.target.value) })}
          />
        </Field>
      </div>

      {outfits.length > 0 && <div className="nd-image-outfits">
        <p className="nd-appearance-hint">服饰锚点提示词：生成含人物画面时接在基础提示词后面。</p>
        {outfits.map(outfit => <Field key={outfit.outfitId} label={outfit.name}>
          <Input
            value={form.outfitPrompts[outfit.outfitId] ?? ''}
            maxLength={1000}
            placeholder="例如：米色风衣，深色长裤"
            onChange={event => updateForm(previous => withOutfitPrompt(previous, outfit.outfitId, event.target.value))}
          />
        </Field>)}
      </div>}
    </Disclosure>

    <div className="nd-image-actions">
      <Button variant="ghost" disabled={probeBusy || !form.serviceId} onClick={() => void runProbe()}>
        {probeBusy ? '正在测试…' : '测试连接'}
      </Button>
      <Button disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : pausedWrite ? '暂停并保存配置' : '保存配置'}</Button>
    </div>
    {probeText && <p className={`nd-appearance-hint${activeProbe?.probe.workflowReady === false ? ' nd-image-warn' : ''}`}>{probeText}</p>}

    <div className="nd-image-preview">
      <p className="nd-appearance-hint">测试生图：直接用当前草稿真出一张，不修改已保存配置，也不写入过场图历史。</p>
      <Field label="测试画面描述">
        <Input
          value={previewPrompt}
          maxLength={2000}
          onChange={event => {
            invalidatePreview(false);
            setPreviewPrompt(event.target.value);
          }}
        />
      </Field>
      <Field label="带哪套服饰" hint="只影响这次测试的提示词。">
        <Select
          value={previewOutfitId}
          onChange={event => {
            invalidatePreview(false);
            setPreviewOutfitId(event.target.value);
          }}
        >
          <option value="">不带服饰提示词</option>
          {outfits.map(outfit => <option key={outfit.outfitId} value={outfit.outfitId}>{outfit.name}</option>)}
        </Select>
      </Field>
      <Button variant="ghost" disabled={previewBusy} onClick={() => void runPreview()}>
        {previewBusy ? '正在出图…' : '测试生图'}
      </Button>
      {activePreview && <figure className="nd-image-figure">
        <img src={`data:${activePreview.mediaType};base64,${activePreview.dataBase64}`} alt="测试生图结果" />
        <figcaption>{activePreview.prompt}</figcaption>
      </figure>}
    </div>

    {(notice || error) && <p role={error ? 'alert' : 'status'} className="nd-appearance-hint">{error || notice}</p>}
  </div>;
}
