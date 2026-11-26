import { useCallback, useEffect, useRef, useState, type ChangeEvent, type SetStateAction } from 'react';
import { api, ApiError } from '../../api';
import { appearanceAssetUrl, type Outfit } from '../../types';
import { Button, Field, Input, Select, Textarea } from '../../ui';
import { PhotoDevelopment } from '../../ui/photo-development';
import { announceLive } from '../../ui/live-announcer';
import type { ConfigDraftState } from '../config-draft';
import { MediaGroup, MediaRow, MediaSheet, MediaStateRow, RoleSaveActions, type MediaSummaryStatus } from '../config/MediaSheet';
import { useSheet } from '../config/sheet/sheet-context';
import { T25, T33, T34 } from '../config/config-texts';
import {
  createImageForm,
  describeImageFailure,
  imageServiceSnapshotKey,
  savedImageModelOf,
  syncImageFormServices,
  toImagePayload,
  toSceneImagePreviewPayload,
  validateImageForm,
  withOutfitPrompt,
  type ImageForm,
  type ImagePreview,
  type ImageSettingsViewPayload,
} from '../../image-config';
import { ImageModelPicker } from './ImageModelPicker';
import { OutfitReferences } from './OutfitReferences';
import { imageServiceCacheKey } from './image-cache';
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
  onSummaryStatus?: (status: MediaSummaryStatus) => void;
  guardWrite?: <T>(action: () => Promise<T>, verb?: string, announceSuccess?: boolean) => Promise<T>;
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
  sequence: number;
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
  onSummaryStatus,
  guardWrite = action => action(),
  pausedWrite = false,
}: Props) {
  const { sheet, closeNow } = useSheet();
  const editing = active && sheet?.id === 'media:image';
  const [view, setView] = useState<ImageSettingsViewPayload | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [{ form, savedForm }, setForms] = useState<{ form: ImageForm; savedForm: ImageForm | null }>(
    () => ({ form: createImageForm(null), savedForm: null }),
  );
  const setForm = useCallback((update: SetStateAction<ImageForm>) => {
    setForms(previous => {
      const next = typeof update === 'function' ? update(previous.form) : update;
      return next === previous.form ? previous : { ...previous, form: next };
    });
  }, []);
  const draftStateRef = useRef<ConfigDraftState>({ dirty: false, busy: false, discard: () => {} });
  const draftCallback = useRef(onDraftStateChange);
  draftCallback.current = onDraftStateChange;
  const [preview, setPreview] = useState<TaggedPreview | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState(DEFAULT_PREVIEW_PROMPT);
  const [previewOutfitId, setPreviewOutfitId] = useState('');
  const [loading, setLoading] = useState(true);
  const [readRetry, setReadRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewElapsed, setPreviewElapsed] = useState(0);
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
  const previewAbortRef = useRef<AbortController | null>(null);
  const anchorSeq = useRef(0);
  const anchorAbortRef = useRef<AbortController | null>(null);
  const lastRole = useRef(roleId);
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
    previewSeq.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    anchorSeq.current += 1;
    anchorAbortRef.current?.abort();
    anchorAbortRef.current = null;
  }
  const mounted = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = editing;
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
  const serviceSyncSeq = useRef(0);
  const syncedState = useRef<{ roleId: string; version: number; active: boolean } | null>(null);
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

  useEffect(() => { if (editing && imageProbe.notice?.source === 'test') announceLive(imageProbe.notice.text); }, [editing, imageProbe.notice]);

  const snapshotKeyFor = (serviceId: string, list: ServiceItem[] = servicesRef.current): string => {
    const matched = list.find(item => item.serviceId === serviceId);
    if (!matched) return '';
    return imageServiceSnapshotKey(matched, serviceEpochsRef.current[serviceId] ?? 0);
  };

  const invalidatePreview = (clearResult: boolean) => {
    previewSeq.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewBusy(false);
    setPreviewError('');
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
    draftStateRef.current = {
      dirty: savedForm !== null && JSON.stringify(form) !== JSON.stringify(savedForm),
      busy: busy || imageProbe.listBusy || imageProbe.testBusy || previewBusy || anchorBusyKey !== '',
      discard: () => {
        imageProbe.clearLog();
        invalidatePreview(true);
        invalidateAnchor(true);
        if (savedForm) setForm(savedForm);
        setError(''); setNotice(''); setNoticeKind('');
      },
    };
    draftCallback.current?.(draftStateRef.current);
    // imageProbe.clearLog 是稳定回调，无需触发额外草稿上报。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, savedForm, busy, imageProbe.listBusy, imageProbe.testBusy, previewBusy, anchorBusyKey]);

  useEffect(() => {
    if (!editing) {
      imageProbe.reset();
      invalidatePreview(false);
      invalidateAnchor(false);
    }
  }, [editing, imageProbe.reset]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      previewAbortRef.current?.abort();
      anchorAbortRef.current?.abort();
    };
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
    const token = roleToken.current;
    const syncSeq = ++serviceSyncSeq.current;
    syncedState.current = { roleId, version: serviceRefreshVersion, active };
    imageProbe.clearLog();
    invalidatePreview(true);
    invalidateAnchor(true);
    setLoading(true); setError(''); setNotice(''); setNoticeKind(''); setView(null);
    setForms({ form: createImageForm(null), savedForm: null });
    if (!roleId) { setLoading(false); return; }
    Promise.all([
      api<ImageSettingsViewPayload>(`/v1/roles/${encodeURIComponent(roleId)}/scene-image`),
      api<{ items: ServiceItem[] }>('/v1/image-services'),
      api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`),
    ]).then(([config, available, wardrobe]) => {
      if (!activeLoad || isStale(token)) return;
      setOutfits(wardrobe.items);
      setPreviewOutfitId(prev => prev && !wardrobe.items.some(item => item.outfitId === prev) ? '' : prev);
      const baseForm = createImageForm(config.settings);
      if (syncSeq === serviceSyncSeq.current) {
        setView(config);
        servicesRef.current = available.items;
        setServices(available.items);
        const next = syncImageFormServices(baseForm, available.items);
        setForms({ form: next, savedForm: next });
      } else {
        setForms(previous => previous.savedForm === null ? { form: baseForm, savedForm: baseForm } : previous);
      }
      setLoading(false);
    }).catch(reason => {
      if (!activeLoad || isStale(token)) return;
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
    const becameActive = active && !previousSync.active;
    syncedState.current = { roleId, version: serviceRefreshVersion, active };
    if (!versionChanged && !becameActive) return;
    if (!roleId) return;
    const token = roleToken.current;
    const syncSeq = ++serviceSyncSeq.current;
    Promise.all([
      api<ImageSettingsViewPayload>(`/v1/roles/${encodeURIComponent(roleId)}/scene-image`),
      api<{ items: ServiceItem[] }>('/v1/image-services'),
    ])
      .then(([config, available]) => {
        if (isStale(token) || syncSeq !== serviceSyncSeq.current) return;
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
        setForms(previous => {
          const { form: draft, savedForm: baseline } = previous;
          if (baseline === null) {
            const initial = syncImageFormServices(createImageForm(config.settings), available.items);
            return { form: initial, savedForm: initial };
          }
          if (draft.serviceId !== baseline.serviceId) return previous;
          // 只补齐草稿和基线中还相同的字段，保留用户录入或清空的模型。
          const defaults = syncImageFormServices(baseline, available.items);
          if (defaults === baseline) return previous;
          const sameModel = draft.modelPath === baseline.modelPath;
          const serviceId = defaults.serviceId;
          return {
            form: { ...draft, serviceId, modelPath: sameModel ? defaults.modelPath : draft.modelPath },
            savedForm: { ...baseline, serviceId, modelPath: sameModel ? defaults.modelPath : baseline.modelPath },
          };
        });
      })
      .catch(() => { /* 从设置返回同步失败时保留现有草稿，保存时会触发正式校验 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId, serviceRefreshVersion, active]);

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
    } else if (next.workflow !== undefined) {
      imageProbe.clearLog();
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
        modelType: formRef.current.modelType,
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
          ? `参考图「${result.source.fileName}」`
          : `「${result.source.outfitName || result.source.fileName}」的立绘（${result.source.fileName}）`;
      setAnchorNotes(previous => ({
        ...previous,
        [key]: `提示词参考了${sourceText}，可以调整后保存。`,
      }));
      setNoticeKind('anchor');
      setNotice(
        target === 'base'
          ? '基础提示词已更新到草稿。'
          : '服饰提示词已更新到草稿。',
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
    const retainService = view?.settings?.serviceId === form.serviceId;
    if (!currentLocal.enabled && !retainService) {
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
      if (!latest.enabled && !retainService) {
        setError(describeImageFailure('IMAGE_SERVICE_DISABLED', ''));
        return;
      }
      const saved = await guardWrite(() => api<ImageSettingsViewPayload>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image`,
        { method: 'PUT', body: toImagePayload(submittedForm) },
      ), '保存生图配置', false);
      if (isStale(token)) return;
      setView(saved);
      setForms(previous => ({ ...previous, savedForm: submittedForm }));
      closeNow(undefined, '已保存生图配置');
      onChanged?.();
    } catch (reason) {
      if (!isStale(token)) setError(failureText(reason));
    } finally {
      if (!isStale(token)) setBusy(false);
    }
  };

  const runPreview = async () => {
    if (previewAbortRef.current) return;
    const issues = validateImageForm(form);
    if (issues.length > 0) { setPreviewError(issues[0]!.message); return; }
    const currentLocal = services.find(service => service.serviceId === form.serviceId);
    if (!currentLocal) {
      setPreviewError('当前所选生图服务已不存在，请重新选择或前往设置新建。');
      return;
    }
    if (!currentLocal.enabled) {
      setPreviewError(describeImageFailure('IMAGE_SERVICE_DISABLED', ''));
      return;
    }
    const targetServiceId = currentLocal.serviceId;
    const requestKey = snapshotKeyFor(targetServiceId);
    const token = roleToken.current;
    const seq = ++previewSeq.current;
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setPreviewBusy(true); setPreviewError(''); setError(''); setNotice(''); setNoticeKind('');
    const isCurrent = () => !controller.signal.aborted && !isStale(token) && previewSeq.current === seq && activeRef.current
      && formRef.current.serviceId === targetServiceId && snapshotKeyFor(targetServiceId) === requestKey;
    try {
      const result = await api<ImagePreview>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image/preview`,
        {
          method: 'POST',
          body: toSceneImagePreviewPayload(form, {
            prompt: previewPrompt,
            outfitId: previewOutfitId,
          }),
          signal: controller.signal,
        },
      );
      if (!isCurrent()) return;
      const photo = new Image();
      photo.src = `data:${result.mediaType};base64,${result.dataBase64}`;
      await photo.decode().catch(() => { throw new Error('返回的样图无法解码。'); });
      if (!isCurrent()) return;
      setPreview({ serviceId: targetServiceId, snapshotKey: requestKey, sequence: seq, result });
      setNoticeKind('preview');
      setNotice(`已用当前草稿生成 ${result.width}×${result.height} 的样图。`);
    } catch (reason) {
      if (isCurrent()) setPreviewError(failureText(reason));
    } finally {
      if (previewAbortRef.current === controller) previewAbortRef.current = null;
      if (!isStale(token) && previewSeq.current === seq) setPreviewBusy(false);
    }
  };

  const cancelPreview = () => {
    previewSeq.current += 1;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewBusy(false);
    setNoticeKind('preview');
    setNotice('已取消本次试生图。');
  };

  const missingSelectedService = form.serviceId !== '' && !selectedService;
  const hasAvailableService = services.some(service => service.enabled);
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


  const activePreview = previewValid ? preview.result : null;
  const count = savedForm ? (Object.keys(form) as (keyof ImageForm)[]).filter(key => JSON.stringify(form[key]) !== JSON.stringify(savedForm[key])).length : 0;
  const dirty = count > 0;
  const state: ConfigDraftState = { dirty, count, busy, discard: () => draftStateRef.current.discard() };
  const unset = view?.settings === null && !dirty;
  const status = unset ? 'off' : dirty ? 'dirty' : !form.serviceId ? 'off' : !selectedService ? 'error' : !selectedService.enabled ? 'off' : 'ok';
  const statusText = unset ? '未设置' : dirty ? '有改动未保存' : !form.serviceId ? '未设置' : !selectedService ? '原服务已删除' : !selectedService.enabled ? '服务已停用' : '生效中';
  useEffect(() => {
    if (loading) { onSummaryStatus?.({ status: 'none', label: '正在读取…' }); return; }
    if (!savedForm && error) { onSummaryStatus?.({ status: 'error', label: '读取失败' }); return; }
    onSummaryStatus?.({ status, label: statusText });
  }, [status, statusText, loading, Boolean(savedForm), Boolean(error), onSummaryStatus]);
  if (loading || (!savedForm && error)) return <MediaStateRow label="生图" loading={loading} error={error} onRetry={() => setReadRetry(value => value + 1)}/>;

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

  return <>
    <MediaRow id="image" label="生图" value={unset || !form.serviceId ? '未选择' : !selectedService ? '原服务已删除，请重新选择' : `${selectedService.name} · ${(form.modelPath || '未设置模型').replace(/\.safetensors$/, '')}`} status={status} statusText={statusText} keys={!unset && selectedService ? [
      {label:'尺寸', value:`${form.width}×${form.height}`, group:'参数'},
      {label:'步数', value:`${form.steps} 步 · CFG ${form.cfg}`, group:'参数'},
      {label:'采样', value:`${form.sampler} / ${form.scheduler}`, group:'参数'},
    ] : []}/>
    <MediaSheet id="image" active={active} state={state} footer={<RoleSaveActions count={count} pause={pausedWrite} busy={busy} invalid={validateImageForm(form).length > 0} error={error} onSave={() => void save()}/>}>
    {group => <div className="nd-image">
    <input
      ref={uploadInputRef}
      type="file"
      accept="image/png,image/jpeg,image/webp"
      hidden
      onChange={handleUploadChange}
    />

    <MediaGroup title="服务" group={group}><Field label="生图服务" hint="切换服务时会带入它的默认模型。">
      <div className="nd-image-service-row">
        <Select value={form.serviceId} disabled={busy} onChange={event => selectService(event.target.value)}>
          {services.length === 0 && <option value="">还没有生图服务</option>}
          {services.length > 0 && form.serviceId === '' && <option value="">请选择生图服务</option>}
          {missingSelectedService && <option value={form.serviceId} disabled>{T34.option}</option>}
          {services.map(service => <option key={service.serviceId} value={service.serviceId} disabled={!service.enabled}>
            {service.name}{service.enabled ? '' : T33.optionSuffix}
          </option>)}
        </Select>
        {onOpenImageSettings && <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenImageSettings(
            !hasAvailableService ? { createNew: true } : selectedService
              ? { serviceId: selectedService.serviceId }
              : undefined,
          )}
        >
          {hasAvailableService ? T25.manage : T25.add}
        </Button>}
      </div>
      {missingSelectedService && <p role="alert" className="nd-appearance-hint nd-image-warn">当前所选生图服务已不存在，请重新选择或前往设置新建。</p>}
      {disabledSelectedService && <p role="alert" className="nd-appearance-hint nd-image-warn">{T33.selectedNote}</p>}
    </Field>

    <Field label="生成方式"><Select value={form.modelType} disabled={busy} onChange={e => patch({ modelType: e.target.value as ImageForm['modelType'] })}>
      <option value="text2img">文生图</option><option value="img2img">图生图</option>
    </Select></Field>
    <Field label="ComfyUI 工作流" hint={form.workflow ? '可以另选一个 API 格式的 JSON 文件来替换当前工作流。' :
      form.modelType === 'img2img' ? '请导入 API 格式的 JSON 文件，并让选定的图片输出连接到一个 LoadImage 参考图节点。' : '当前使用内置的 MOSS-Image 工作流。'}>
      <Input type="file" accept=".json,application/json" disabled={busy} onChange={async e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        const token = roleToken.current;
        try {
          const workflow = JSON.parse(await file.text());
          if (isStale(token)) return;
          if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow) || !Object.keys(workflow).length ||
            !Object.values(workflow).every(node => node && typeof node === 'object' && 'class_type' in node && 'inputs' in node)) throw Error('请选择 ComfyUI 导出的 API 格式工作流 JSON。');
          patch({ workflow, outputNodeId: null }); setError('');
        } catch (reason) { if (!isStale(token)) setError(reason instanceof Error ? reason.message : String(reason)); }
      }}/>
    </Field>
    {form.workflow && <><Field label="输出节点 ID" hint="留空使用首个 SaveImage。">
      <Input value={form.outputNodeId ?? ''} disabled={busy} onChange={e => patch({ outputNodeId: e.target.value.trim() || null })}/></Field>
      <Button size="sm" disabled={busy} onClick={() => patch({ workflow: null, outputNodeId: null })}>清除工作流</Button></>}
    <ImageModelPicker
      label="模型名称或目录"
      testAnnouncedExternally
      hint="可以从列表选取模型，自定义工作流也可以填写本地模型目录。"
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

    </MediaGroup><MediaGroup title="提示词" group={group}><section className="nd-image-section" aria-label="基础锚点提示词">
      <div className="nd-image-section-head">
        <div className="nd-image-section-title">
          <h3>基础锚点提示词</h3>
          <p className="nd-appearance-hint">{form.modelType === 'text2img'
            ? '文生图统一使用细线、柔和渐层的日系动画插画画风。这里填写角色的默认外貌，如脸型、瞳色和发型。剧情中剪发、扎发等变化会体现在当时的画面里。'
            : '记下角色在不同画面里都保留的特征，如脸型、发色、瞳色和画风。'}</p>
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
        placeholder={form.modelType === 'text2img' ? '填写默认外貌，或从角色立绘提取' : '可填写外貌与画风，或用对话模型参考立绘生成'}
        onChange={event => patch({ basePrompt: event.target.value })}
      />
      {anchorNotes.base && <p className="nd-image-source-note">{anchorNotes.base}</p>}
    </section>

    {form.modelType === 'img2img' ? <OutfitReferences key={roleId} roleId={roleId} outfits={outfits} guardWrite={guardWrite}
      onChanged={() => invalidatePreview(true)} /> : <section className="nd-image-section" aria-label="服饰锚点提示词">
      <div className="nd-image-section-title">
        <h3>服饰锚点提示词</h3>
        <p className="nd-appearance-hint">填写这套衣服的默认款式与配色。聊天中按出镜人物分别取当时的穿着；动作、表情、构图和光照随镜头变化。</p>
      </div>
      {outfits.length === 0 ? (
        <p className="nd-appearance-hint">可以先到「外观」添加服饰，再回来为它写提示词。</p>
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
                          : '还没有立绘，可以上传参考图'}
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
    </section>}

      <Field label="负向提示词" hint={form.modelType === 'text2img'
        ? '每次生图都会使用。适合填写水印、模糊等通用问题；发型和穿着留给剧情决定。'
        : '可以留空，也可以写下希望画面避开的细节。'}>
        <Input
          value={form.negativePrompt}
          maxLength={2000}
          placeholder="nsfw, worst quality, bad anatomy, watermark, jpeg artifact"
          onChange={event => patch({ negativePrompt: event.target.value })}
        />
      </Field>

    </MediaGroup><MediaGroup title="参数" group={group}><div className="nd-image-grid">
        <Field label="宽度"><Input type="number" min={256} max={2048} step={16} value={form.width} onChange={event => patch({ width: Number(event.target.value) })} /></Field>
        <Field label="高度"><Input type="number" min={256} max={2048} step={16} value={form.height} onChange={event => patch({ height: Number(event.target.value) })} /></Field>
        <Field label="步数"><Input type="number" min={1} max={150} value={form.steps} onChange={event => patch({ steps: Number(event.target.value) })} /></Field>
        <Field label="CFG"><Input type="number" min={0} max={30} step={0.5} value={form.cfg} onChange={event => patch({ cfg: Number(event.target.value) })} /></Field>
        <Field label="采样器"><Input value={form.sampler} onChange={event => patch({ sampler: event.target.value })} /></Field>
        <Field label="调度器"><Input value={form.scheduler} onChange={event => patch({ scheduler: event.target.value })} /></Field>
        <Field label="种子">
          <Input
            type="number"
            min={0}
            value={form.seed === null ? '' : form.seed}
            placeholder="留空则每次随机"
            onChange={event => patch({ seed: event.target.value === '' ? null : Number(event.target.value) })}
          />
        </Field>
        <Field label="自动生成过场图"><Select value={form.autoGenerateEnabled ? 'on' : 'off'} disabled={busy} onChange={e => patch({ autoGenerateEnabled: e.target.value === 'on' })}>
          <option value="off">关闭</option><option value="on">开启</option></Select></Field>
        {form.autoGenerateEnabled && <Field label="同一窗口冷却时间（分钟）" hint="0 表示不限制间隔。">
          <Input type="number" min={0} max={10080} step={1} value={form.autoCooldownMinutes} disabled={busy} onChange={e => patch({autoCooldownMinutes: Number(e.target.value)})}/>
        </Field>}
      </div>
    </MediaGroup><MediaGroup title="试生图" group={group}><div className="nd-image-preview">
      {previewBusy || previewError || activePreview ? <figure className="nd-image-figure">
        {previewBusy ? <PhotoDevelopment state="pending" pendingLabel={`相纸显影中（${previewElapsed}s）…`} />
          : previewError ? <PhotoDevelopment state="failed" failureLabel="样图没有生成" reason={previewError} onRetry={() => void runPreview()} />
            : activePreview ? <>
              <div className="photo-preview-frame">
                <img src={`data:${activePreview.mediaType};base64,${activePreview.dataBase64}`} alt="测试生图结果" />
                <PhotoDevelopment key={preview?.sequence} state="developed" />
              </div>
              <figcaption title={activePreview.prompt}>{activePreview.prompt}</figcaption>
            </> : null}
      </figure> : null}
      <div className="nd-image-preview-controls">
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
        <Field label="试生图参考服饰">
          <Select
            value={previewOutfitId}
            onChange={event => {
              invalidatePreview(false);
              setPreviewOutfitId(event.target.value);
            }}
          >
            <option value="">{form.modelType === 'img2img' ? '请选择已上传参考图的服饰' : '不带服饰提示词'}</option>
            {outfits.map(outfit => <option key={outfit.outfitId} value={outfit.outfitId}>{outfit.name}</option>)}
          </Select>
        </Field>
        <div className="nd-image-actions"><Button variant="ghost" busy={previewBusy} disabled={busy} onClick={() => void runPreview()}>
          {previewBusy ? `正在出图（${previewElapsed}s）…` : '测试生图'}
        </Button>
        {previewBusy && <Button variant="ghost" onClick={cancelPreview}>取消</Button>}</div>
      </div>
    </div>

    </MediaGroup>
    {(notice || error) && <p role={error ? 'alert' : 'status'} className={`nd-appearance-hint${error ? ' nd-image-warn' : ''}`}>{error || notice}</p>}
  </div>}
    </MediaSheet>
  </>;
}
