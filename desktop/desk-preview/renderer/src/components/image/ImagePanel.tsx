import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Button, Field, Input, LoadingNote, Select, Textarea } from '../../ui';
import {
  createImageForm,
  describeImageFailure,
  describeImageSummary,
  summarizeImageProbe,
  toImagePayload,
  validateImageForm,
  withOutfitPrompt,
  type ImageForm,
  type ImagePreview,
  type ImageProbeResult,
  type ImageSettingsViewPayload,
} from '../../image-config.js';

type Props = {
  roleId: string;
  onChanged?: () => void;
};

interface ServiceItem {
  serviceId: string;
  name: string;
  enabled: boolean;
  config: { baseUrl: string };
  credential: { status: string; resolvable: boolean };
}

interface OutfitItem {
  outfitId: string;
  name: string;
}

const DEFAULT_PREVIEW_PROMPT = '半身肖像，柔和自然光，背景简洁，细节清晰';

function failureText(reason: unknown): string {
  if (reason instanceof ApiError) return describeImageFailure(reason.code, reason.message);
  return reason instanceof Error ? reason.message : String(reason);
}

export function ImagePanel({ roleId, onChanged }: Props) {
  const [view, setView] = useState<ImageSettingsViewPayload | null>(null);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [outfits, setOutfits] = useState<OutfitItem[]>([]);
  const [form, setForm] = useState<ImageForm>(() => createImageForm(null));
  const [probe, setProbe] = useState<ImageProbeResult | null>(null);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [previewPrompt, setPreviewPrompt] = useState(DEFAULT_PREVIEW_PROMPT);
  const [previewOutfitId, setPreviewOutfitId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('本机 ComfyUI');
  const [newBaseUrl, setNewBaseUrl] = useState('http://127.0.0.1:8188');
  const [newSecret, setNewSecret] = useState('');

  // 角色切换令牌：晚到的响应不写进另一个角色的页面状态。
  const roleToken = useRef(0);
  const lastRole = useRef(roleId);
  if (lastRole.current !== roleId) {
    lastRole.current = roleId;
    roleToken.current += 1;
  }
  const mounted = useRef(true);
  const isStale = (token: number) => !mounted.current || roleToken.current !== token;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const token = roleToken.current;
    setLoading(true); setError(''); setNotice(''); setView(null);
    setProbe(null); setPreview(null); setForm(createImageForm(null));
    if (!roleId) { setLoading(false); return; }
    Promise.all([
      api<ImageSettingsViewPayload>(`/v1/roles/${encodeURIComponent(roleId)}/scene-image`),
      api<{ items: ServiceItem[] }>('/v1/image-services'),
      api<{ items: OutfitItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`),
    ]).then(([config, available, wardrobe]) => {
      if (isStale(token)) return;
      setView(config);
      setServices(available.items);
      setOutfits(wardrobe.items);
      const next = createImageForm(config.settings);
      if (next.serviceId === '' && available.items.length > 0) {
        next.serviceId = available.items[0]!.serviceId;
      }
      setForm(next);
      setLoading(false);
    }).catch(reason => {
      if (isStale(token)) return;
      setError(failureText(reason));
      setLoading(false);
    });
    // isStale 依赖 ref，不需要进依赖数组。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId]);

  const patch = (next: Partial<ImageForm>) => setForm(previous => ({ ...previous, ...next }));

  const save = async () => {
    if (busy) return;
    const issues = validateImageForm(form);
    if (issues.length > 0) { setError(issues[0]!.message); return; }
    const token = roleToken.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await api<ImageSettingsViewPayload>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image`,
        { method: 'PUT', body: toImagePayload(form) },
      );
      if (isStale(token)) return;
      setView(saved);
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
    if (!form.serviceId) { setError('先选择或新建一个生图服务'); return; }
    const token = roleToken.current;
    setProbeBusy(true); setError(''); setNotice('');
    try {
      const result = await api<ImageProbeResult>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image/probe`,
        { method: 'POST', body: { serviceId: form.serviceId } },
      );
      if (isStale(token)) return;
      setProbe(result);
      setNotice(result.probe.workflowReady ? '服务可用。' : '服务能连上，但工作流还缺节点。');
    } catch (reason) {
      if (!isStale(token)) setError(failureText(reason));
    } finally {
      if (!isStale(token)) setProbeBusy(false);
    }
  };

  const runPreview = async () => {
    if (previewBusy) return;
    const token = roleToken.current;
    setPreviewBusy(true); setError(''); setNotice('');
    try {
      const result = await api<ImagePreview>(
        `/v1/roles/${encodeURIComponent(roleId)}/scene-image/preview`,
        { method: 'POST', body: { prompt: previewPrompt.trim(), ...(previewOutfitId ? { outfitId: previewOutfitId } : {}) } },
      );
      if (isStale(token)) return;
      setPreview(result);
      setNotice(`已生成测试样图（${result.width}×${result.height}）。`);
    } catch (reason) {
      if (!isStale(token)) setError(failureText(reason));
    } finally {
      if (!isStale(token)) setPreviewBusy(false);
    }
  };

  const createService = async () => {
    if (busy) return;
    if (!newName.trim() || !newBaseUrl.trim()) { setError('填写服务名称和地址'); return; }
    const token = roleToken.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const created = await api<{ service: ServiceItem }>('/v1/image-services', {
        method: 'POST',
        body: {
          name: newName.trim(),
          config: { protocol: 'comfyui', baseUrl: newBaseUrl.trim() },
          ...(newSecret.trim() ? { secret: newSecret.trim() } : {}),
        },
      });
      if (isStale(token)) return;
      setServices(previous => [...previous, created.service]);
      patch({ serviceId: created.service.serviceId });
      setNewSecret('');
      setCreating(false);
      setNotice('已保存生图服务，接着填模型目录并测试连接。');
    } catch (reason) {
      if (!isStale(token)) setError(failureText(reason));
    } finally {
      if (!isStale(token)) setBusy(false);
    }
  };

  if (loading) return <LoadingNote label="正在读取生图配置…" />;

  const summary = describeImageSummary(view);
  const probeText = summarizeImageProbe(probe?.probe);

  return <div className="nd-image">
    <p className="nd-appearance-hint">{summary}</p>

    <Field label="生图服务" hint="ComfyUI 地址在全局维护，同一地址可以跑不同模型。">
      <div className="nd-image-service-row">
        <Select value={form.serviceId} disabled={busy} onChange={event => patch({ serviceId: event.target.value })}>
          {services.length === 0 && <option value="">还没有生图服务</option>}
          {services.map(service => <option key={service.serviceId} value={service.serviceId}>
            {service.name}{service.enabled ? '' : '（已停用）'}
          </option>)}
        </Select>
        <Button variant="ghost" size="sm" onClick={() => setCreating(value => !value)}>
          {creating ? '收起' : '新建服务'}
        </Button>
      </div>
    </Field>

    {creating && <div className="nd-image-new-service">
      <Field label="名称"><Input value={newName} maxLength={200} onChange={event => setNewName(event.target.value)} /></Field>
      <Field label="地址" hint="ComfyUI 默认 http://127.0.0.1:8188。"><Input value={newBaseUrl} onChange={event => setNewBaseUrl(event.target.value)} /></Field>
      <Field label="令牌（可选）" hint="只在反向代理要求认证时填写。"><Input type="password" value={newSecret} onChange={event => setNewSecret(event.target.value)} /></Field>
      <Button disabled={busy || !newName.trim() || !newBaseUrl.trim()} onClick={() => void createService()}>保存服务</Button>
    </div>}

    <Field label="模型目录" hint="MOSS-Image 的本地目录，需含 transformer／text_encoder／tokenizer／vae。">
      <Input value={form.modelPath} maxLength={2000} placeholder="/models/MOSS-Image-Base" onChange={event => patch({ modelPath: event.target.value })} />
    </Field>
    <Field label="基础锚点提示词" hint="脸型、发型、发色、瞳色等跨场景保持稳定的特征。">
      <Textarea rows={3} value={form.basePrompt} maxLength={2000} onChange={event => patch({ basePrompt: event.target.value })} />
    </Field>
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
          onChange={event => setForm(previous => withOutfitPrompt(previous, outfit.outfitId, event.target.value))}
        />
      </Field>)}
    </div>}

    <div className="nd-image-actions">
      <Button variant="ghost" disabled={probeBusy || !form.serviceId} onClick={() => void runProbe()}>
        {probeBusy ? '正在测试…' : '测试连接'}
      </Button>
      <Button disabled={busy} onClick={() => void save()}>{busy ? '正在保存…' : '保存配置'}</Button>
    </div>
    {probeText && <p className={`nd-appearance-hint${probe?.probe.workflowReady === false ? ' nd-image-warn' : ''}`}>{probeText}</p>}

    <div className="nd-image-preview">
      <p className="nd-appearance-hint">测试生图：用当前保存的配置真出一张，不写入过场图历史。</p>
      <Field label="测试画面描述">
        <Input value={previewPrompt} maxLength={2000} onChange={event => setPreviewPrompt(event.target.value)} />
      </Field>
      <Field label="带哪套服饰" hint="只影响这次测试的提示词。">
        <Select value={previewOutfitId} onChange={event => setPreviewOutfitId(event.target.value)}>
          <option value="">不带服饰提示词</option>
          {outfits.map(outfit => <option key={outfit.outfitId} value={outfit.outfitId}>{outfit.name}</option>)}
        </Select>
      </Field>
      <Button variant="ghost" disabled={previewBusy} onClick={() => void runPreview()}>
        {previewBusy ? '正在出图…' : '测试生图'}
      </Button>
      {preview && <figure className="nd-image-figure">
        <img src={`data:${preview.mediaType};base64,${preview.dataBase64}`} alt="测试生图结果" />
        <figcaption>{preview.prompt}</figcaption>
      </figure>}
    </div>

    {(notice || error) && <p role={error ? 'alert' : 'status'} className="nd-appearance-hint">{error || notice}</p>}
  </div>;
}
