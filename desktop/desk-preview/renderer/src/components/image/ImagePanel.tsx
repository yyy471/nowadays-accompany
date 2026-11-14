import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../../api';
import { appearanceAssetUrl, type Outfit } from '../../types';
import { Button, Disclosure, Field, Input, LoadingNote, Select, Textarea } from '../../ui';
import type { ConfigDraftState } from '../config-draft';
import {
  createImageForm,
  describeImageFailure,
  describeImageSummary,
  imageServiceSnapshotKey,
  savedImageModelOf,
  toImagePayload,
  toSceneImagePreviewPayload,
  validateImageForm,
  withOutfitPrompt,
  type ImageForm,
  type ImagePreview,
  type ImageSettingsViewPayload,
} from '../../image-config.js';
import { ImageModelPicker } from './ImageModelPicker';
import { imageServiceCacheKey } from './image-cache.js';
import { useImageProbe } from './use-image-probe';

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
    modelName?: string;
    credentialRef?: string;
    timeoutMs?: number;
  };
  credential: {
    status: string;
    reference?: string | null;
    resolvable?: boolean;
  };
}

interface AnchorPromptResponse {
  target: 'base' | 'outfit';
  outfitId: string | null;
  prompt: string;
  source: {
    kind: 'uploaded' | 'outfit_asset';
    fileName: string;
    outfitId: string | null;
    outfitName: string | null;
  };
}

interface TaggedPreview {
  serviceId: string;
  snapshotKey: string;
  result: ImagePreview;
}

type NoticeKind = '' | 'anchor' | 'preview' | 'save';

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
  const [view, setView] = useState<ImageSettingsViewPayload | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [form, setForm] = useState<ImageForm>(() => createImageForm(null));
  const [savedForm, setSavedForm] = useState<ImageForm | null>(null);
  const draftCallback = useRef(onDraftStateChange);
  draftCallback.current = onDraftStateChange;
  const [preview, setPreview] = useState<TaggedPreview | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState(DEFAULT_PREVIEW_PROMPT);
  const [previewOutfitId, setPreviewOutfitId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [anchorBusyKey, setAnchorBusyKey] = useState('');
  const [anchorNotes, setAnchorNotes] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<NoticeKind>('');
  const [error, setError] = useState('');

  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const pendingUploadRef = useRef<{ target: 'base' | 'outfit'; outfitId?: string } | null>(null);

  // 角色切换与草稿变更令牌：晚到的试生图与提示词生成响应不写回过时草稿或其他角色。
  const roleToken = useRef(0);
  const previewSeq = useRef(0);
  const anchorSeq = useRef(0);
  const anchorAbortRef = useRef<AbortController | null>(null);
  const lastRole = useRef(roleId);
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
    previewSeq.current += 1;
    anchorSeq.current += 1;
    anchorAbortRef.current?.abort();
    anchorAbortRef.current = null;
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
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewOutfitRef = useRef(previewOutfitId);
  previewOutfitRef.current = previewOutfitId;
  const noticeKindRef = useRef(noticeKind);
  noticeKindRef.current = noticeKind;
  const initialServiceSync = useRef(true);
  const initialOutfitSync = useRef(true);
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  const selectedService = services.find(service => service.serviceId === form.serviceId);
  const probeCacheKey =
    selectedService && selectedService.enabled
      ? imageServiceCacheKey(selectedService)
      : '';
  const imageProbe = useImageProbe(probeCacheKey, {
    shared: probeCacheKey !== '',
    onBeforeProbe: () => setError(''),
  });

  const snapshotKeyFor = (serviceId: string, list: ServiceItem[] = servicesRef.current): string => {
    const matched = list.find(item => item.serviceId === serviceId);
    if (!matched) return '';
    return imageServiceSnapshotKey(matched, serviceEpochsRef.current[serviceId] ?? 0);
  };

  const invalidatePreview = (clearResult: boolean) => {
    previewSeq.current += 1;
    setPreviewBusy(false);
    if (clearResult) {
      setPreview(null);
      if (noticeKindRef.current === 'preview') { setNotice(''); setNoticeKind(''); }
    }
  };

  const invalidateAnchor = (clearNotes: boolean) => {
    anchorSeq.current += 1;
    anchorAbortRef.current?.abort();
    anchorAbortRef.current = null;
    setAnchorBusyKey('');
    if (clearNotes) {
      setAnchorNotes({});
      if (noticeKindRef.current === 'anchor') { setNotice(''); setNoticeKind(''); }
    }
  };

  useEffect(() => {
    draftCallback.current?.({
      dirty: savedForm !== null && JSON.stringify(form) !== JSON.stringify(savedForm),
      busy: busy || imageProbe.listBusy || imageProbe.testBusy || previewBusy || anchorBusyKey !== '',
      discard: () => {
        imageProbe.clearLog();
        invalidatePreview(true);
        invalidateAnchor(true);
        if (savedForm) setForm(savedForm);
        setError(''); setNotice(''); setNoticeKind('');
      },
    });
    // imageProbe.clearLog 是稳定回调，无需触发额外草稿上报。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, savedForm, busy, imageProbe.listBusy, imageProbe.testBusy, previewBusy, anchorBusyKey]);

  useEffect(() => {
    if (!active) {
      imageProbe.clearLog();
      invalidatePreview(false);
      invalidateAnchor(false);
    }
  }, [active, imageProbe.clearLog]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      anchorAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const token = roleToken.current;
    imageProbe.clearLog();
    invalidatePreview(true);
    invalidateAnchor(true);
    setLoading(true); setError(''); setNotice(''); setNoticeKind(''); setView(null);
    setForm(createImageForm(null)); setSavedForm(null);
    if (!roleId) { setLoading(false); return; }
    Promise.all([
      api<ImageSettingsViewPayload>(`/v1/roles/${encodeURIComponent(roleId)}/scene-image`),
      api<{ items: ServiceItem[] }>('/v1/image-services'),
      api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`),
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
        if (!next.modelPath) {
          next.modelPath = savedImageModelOf(available.items[0]);
        }
      }
      setForm(next); setSavedForm(next);
      setLoading(false);
    }).catch(reason => {
      if (isStale(token)) return;
      setError(failureText(reason));
      setLoading(false);
    });
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
            const first = available.items[0]!;
            return {
              ...previous,
              serviceId: first.serviceId,
              modelPath: previous.modelPath || savedImageModelOf(first),
            };
          }
          if (currentService && !previous.modelPath && savedImageModelOf(currentService)) {
            return { ...previous, modelPath: savedImageModelOf(currentService) };
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
    api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`)
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
      imageProbe.clearLog();
      invalidatePreview(true);
    }
    updateForm(previous => ({ ...previous, ...next }));
  };

  const selectService = (serviceId: string) => {
    const picked = services.find(item => item.serviceId === serviceId);
    patch({
      serviceId,
      modelPath: picked ? savedImageModelOf(picked) : '',
    });
  };

  const runAnchorGeneration = async (
    target: 'base' | 'outfit',
    outfitId?: string,
    file?: File,
  ) => {
    if (anchorBusyKey !== '') return;
    if (target === 'outfit' && !outfitId) return;
    const key = target === 'base' ? 'base' : outfitId!;
    const token = roleToken.current;
    const seq = ++anchorSeq.current;
    const controller = new AbortController();
    anchorAbortRef.current = controller;
    const previousPrompt =
      target === 'base'
        ? formRef.current.basePrompt
        : (formRef.current.outfitPrompts[outfitId!] ?? '');

    setAnchorBusyKey(key);
    setError('');
    if (noticeKindRef.current === 'anchor') {
      setNotice('');
      setNoticeKind('');
    }

    try {
      const payload = {
        target,
        ...(target === 'outfit' ? { outfitId } : {}),
        ...(previousPrompt.trim() ? { previousPrompt } : {}),
      };
      let body: unknown;
      if (file) {
        const formData = new FormData();
        formData.append('payload', JSON.stringify(payload));
        formData.append('image', file);
        body = formData;
      } else {
        body = payload;
      }
      const result = await api<AnchorPromptResponse>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image/anchor-prompts`,
        { method: 'POST', body, signal: controller.signal },
      );
      if (isStale(token) || anchorSeq.current !== seq) return;
      if (target === 'base') {
        updateForm(previous => ({ ...previous, basePrompt: result.prompt }));
      } else {
        updateForm(previous => withOutfitPrompt(previous, outfitId!, result.prompt));
      }
      const sourceText =
        result.source.kind === 'uploaded'
          ? `已读取上传参考图「${result.source.fileName}」生成`
          : `已读取「${result.source.outfitName || result.source.fileName}」立绘（${result.source.fileName}）生成`;
      setAnchorNotes(previous => ({
        ...previous,
        [key]: `${sourceText}；可微调或再次重新生成，确认后点保存。`,
      }));
      setNoticeKind('anchor');
      setNotice(
        target === 'base'
          ? '已用对话模型更新基础锚点提示词，当前仅在草稿生效。'
          : '已用对话模型更新服饰锚点提示词，当前仅在草稿生效。',
      );
    } catch (reason) {
      if (controller.signal.aborted || isStale(token) || anchorSeq.current !== seq) {
        return;
      }
      setError(failureText(reason));
    } finally {
      if (anchorSeq.current === seq) {
        anchorAbortRef.current = null;
        setAnchorBusyKey('');
      }
    }
  };

  const triggerUploadPrompt = (target: 'base' | 'outfit', outfitId?: string) => {
    if (anchorBusyKey !== '') return;
    pendingUploadRef.current = { target, outfitId };
    uploadInputRef.current?.click();
  };

  const handleUploadChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const pending = pendingUploadRef.current;
    pendingUploadRef.current = null;
    if (!file || !pending) return;
    void runAnchorGeneration(pending.target, pending.outfitId, file);
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

  const missingSelectedService = form.serviceId !== '' && !selectedService;
  const disabledSelectedService = Boolean(selectedService && !selectedService.enabled);
  const currentSnapshotKey = selectedService
    ? imageServiceSnapshotKey(selectedService, serviceEpochs[selectedService.serviceId] ?? 0)
    : '';
  const previewValid =
    preview !== null &&
    preview.serviceId === form.serviceId &&
    selectedService !== undefined &&
    selectedService.enabled &&
    preview.snapshotKey !== '' &&
    preview.snapshotKey === currentSnapshotKey;

  useEffect(() => {
    if (preview !== null && !previewValid) invalidatePreview(true);
  }, [preview, previewValid]);

  if (loading) return <LoadingNote label="正在读取生图配置…" />;

  const activePreview = previewValid ? preview.result : null;
  const summary = describeImageSummary(view);
  const roleProbeTarget =
    selectedService && !disabledSelectedService
      ? {
          kind: 'role' as const,
          roleId,
          serviceId: selectedService.serviceId,
          cacheKey: probeCacheKey,
          workflow: form.workflow,
        }
      : null;

  return <div className="nd-image">
    <p className="nd-image-summary">{summary}</p>
    <input
      ref={uploadInputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      onChange={handleUploadChange}
    />

    <Field label="生图服务" hint="切换服务会自动带入该服务的默认模型；未设置默认模型时可展开候选或手填。">
      <div className="nd-image-service-row">
        <Select value={form.serviceId} disabled={busy} onChange={event => selectService(event.target.value)}>
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

    <ImageModelPicker
      label="模型名称或目录"
      hint="与文本模型选取一致：点击聚焦展开或输入筛选；自定义工作流可填本地模型目录。"
      value={form.modelPath}
      onChange={value => patch({ modelPath: value })}
      models={roleProbeTarget ? imageProbe.models : []}
      listBusy={imageProbe.listBusy}
      testBusy={imageProbe.testBusy}
      notice={imageProbe.notice}
      onRefresh={() => { if (roleProbeTarget) void imageProbe.refresh(roleProbeTarget); }}
      onTest={() => { if (roleProbeTarget) void imageProbe.test(roleProbeTarget, form.modelPath); }}
      probeDisabled={!roleProbeTarget}
      disabled={busy}
    />

    <section className="nd-image-section" aria-label="基础锚点提示词">
      <div className="nd-image-section-head">
        <div className="nd-image-section-title">
          <h3>基础锚点提示词</h3>
          <p className="nd-appearance-hint">脸型、发型、发色、瞳色与画风质感等跨场景恒定特征（不含服装与背景）。</p>
        </div>
        <div className="nd-image-inline-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || anchorBusyKey !== ''}
            aria-label="用对话模型生成基础锚点提示词"
            onClick={() => void runAnchorGeneration('base')}
          >
            {anchorBusyKey === 'base'
              ? '正在生成…'
              : form.basePrompt.trim()
                ? '对话模型重新生成'
                : '用对话模型生成'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || anchorBusyKey !== ''}
            aria-label="上传参考图生成基础锚点提示词"
            onClick={() => triggerUploadPrompt('base')}
          >
            传参考图生成
          </Button>
        </div>
      </div>
      <Textarea
        rows={3}
        aria-label="基础锚点提示词"
        value={form.basePrompt}
        maxLength={2000}
        placeholder="点击右侧「用对话模型生成」自动读取当前角色立绘，或手动填写外貌与画风特征"
        onChange={event => patch({ basePrompt: event.target.value })}
      />
      {anchorNotes.base && <p className="nd-image-source-note">{anchorNotes.base}</p>}
    </section>

    <section className="nd-image-section" aria-label="服饰锚点提示词">
      <div className="nd-image-section-title">
        <h3>服饰锚点提示词</h3>
        <p className="nd-appearance-hint">生成含人物画面时接在基础提示词之后；每套服饰均可读取对应立绘交由对话模型反复生成。</p>
      </div>
      {outfits.length === 0 ? (
        <p className="nd-appearance-hint">衣柜中暂无服饰；前往左侧「外观」导入立绘后，可在此逐套生成服饰提示词。</p>
      ) : (
        <div className="nd-image-outfits">
          {outfits.map(outfit => {
            const anchorAsset = outfit.home ?? outfit.sprites[0] ?? null;
            const currentPrompt = form.outfitPrompts[outfit.outfitId] ?? '';
            const generating = anchorBusyKey === outfit.outfitId;
            return <div className="nd-image-outfit-card" key={outfit.outfitId}>
              <div className="nd-image-outfit-thumb">
                {anchorAsset
                  ? <img src={appearanceAssetUrl(roleId, anchorAsset.assetId)} alt={outfit.name} />
                  : <span>无立绘</span>}
              </div>
              <div className="nd-image-outfit-body">
                <div className="nd-image-outfit-head">
                  <div className="nd-image-outfit-meta">
                    <strong>{outfit.name}</strong>
                    <small>
                      {outfit.home
                        ? '使用主页立绘'
                        : anchorAsset
                          ? '使用差分立绘'
                          : '尚无立绘，可点传参考图生成'}
                    </small>
                  </div>
                  <div className="nd-image-inline-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || anchorBusyKey !== ''}
                      aria-label={`用对话模型生成「${outfit.name}」服饰提示词`}
                      onClick={() => void runAnchorGeneration('outfit', outfit.outfitId)}
                    >
                      {generating
                        ? '正在生成…'
                        : currentPrompt.trim()
                          ? '对话模型重新生成'
                          : '用对话模型生成'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || anchorBusyKey !== ''}
                      aria-label={`上传参考图生成「${outfit.name}」服饰提示词`}
                      onClick={() => triggerUploadPrompt('outfit', outfit.outfitId)}
                    >
                      传参考图生成
                    </Button>
                  </div>
                </div>
                <Input
                  aria-label={`${outfit.name}提示词`}
                  value={currentPrompt}
                  maxLength={1000}
                  placeholder="例如：米色风衣，深色长裤"
                  onChange={event => updateForm(previous => withOutfitPrompt(previous, outfit.outfitId, event.target.value))}
                />
                {anchorNotes[outfit.outfitId] && (
                  <p className="nd-image-source-note">{anchorNotes[outfit.outfitId]}</p>
                )}
              </div>
            </div>;
          })}
        </div>
      )}
    </section>

    <Disclosure title="生成参数" description="负向提示词、尺寸、步数、CFG、采样器与种子">
      <Field label="负向提示词" hint="留空也可出图；人物或复杂场景可填入防崩坏词提升稳定性。">
        <Input
          value={form.negativePrompt}
          maxLength={2000}
          placeholder="nsfw, worst quality, bad anatomy, watermark, jpeg artifact"
          onChange={event => patch({ negativePrompt: event.target.value })}
        />
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
    </Disclosure>

    <div className="nd-image-preview">
      <p className="nd-appearance-hint">测试生图：直接用当前草稿真出一张，不修改已保存配置，也不写入过场图历史；可反复生成提示词测试效果后再保存。</p>
      <div className="nd-image-preview-row">
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
        <Field label="带哪套服饰" hint="仅影响本次试生图拼接。">
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
      </div>
      <div className="nd-image-actions">
        <Button variant="ghost" disabled={previewBusy} onClick={() => void runPreview()}>
          {previewBusy ? '正在出图…' : '测试生图'}
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? '正在保存…' : pausedWrite ? '暂停并保存配置' : '保存配置'}
        </Button>
      </div>
      {activePreview && <figure className="nd-image-figure">
        <img src={`data:${activePreview.mediaType};base64,${activePreview.dataBase64}`} alt="测试生图结果" />
        <figcaption>{activePreview.prompt}</figcaption>
      </figure>}
    </div>

    {(notice || error) && <p role={error ? 'alert' : 'status'} className={`nd-appearance-hint${error ? ' nd-image-warn' : ''}`}>{error || notice}</p>}
  </div>;
}
