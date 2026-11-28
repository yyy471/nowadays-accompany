import { errorText } from '../../lib/error-text';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Button, Field, Input, Select, StatusDot, Switch } from '../../ui';
import {
  embeddingStatusLabel,
  toEmbeddingDraft,
  validateEmbeddingDraft,
  type MemoryEmbeddingSettings,
} from './memory-embedding';

const endpoint = '/v1/memory/embedding-settings';

const emptyDraft = { enabled: false, resourceId: '', modelName: '' };

/** 本机设置中的「记忆语义检索（可选）」：默认关闭，关闭时只用 FTS5。 */
export function MemoryEmbeddingGroup({ active, models }: {
  active: boolean;
  models: Array<{ resourceId: string; name: string }>;
}) {
  const [settings, setSettings] = useState<MemoryEmbeddingSettings | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  // 分区可见时静默读取；隐藏即中止，避免跨页迟到回包覆盖草稿。
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setReadError('');
    void api<{ settings: MemoryEmbeddingSettings }>(endpoint, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setSettings(result.settings);
        setDraft(toEmbeddingDraft(result.settings));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setReadError(errorText(reason));
      });
    return () => controller.abort();
  }, [active]);

  const status = embeddingStatusLabel(settings);
  const enabledModelIds = useMemo(() => models.map(item => item.resourceId), [models]);
  const validation = validateEmbeddingDraft(draft, enabledModelIds);
  const baseline = settings ? toEmbeddingDraft(settings) : null;
  const dirty = baseline !== null && (
    draft.enabled !== baseline.enabled
    || draft.resourceId !== baseline.resourceId
    || draft.modelName !== baseline.modelName
  );
  const canSave = settings !== null && !saving && validation.ok && (dirty || draft.enabled);

  const save = async () => {
    if (!validation.ok) { setWriteError(validation.message); return; }
    setSaving(true);
    setWriteError('');
    setNotice('');
    try {
      const result = await api<{ settings: MemoryEmbeddingSettings }>(endpoint, {
        method: 'PUT',
        body: validation.payload,
      });
      setSettings(result.settings);
      setDraft(toEmbeddingDraft(result.settings));
      setNotice('已保存记忆语义检索设置');
    } catch (reason) {
      setWriteError(errorText(reason));
    } finally {
      setSaving(false);
    }
  };

  return <div className="config-grp" id="config-local-memory-embedding">
    <div className="config-grp-label"><b>记忆语义检索</b><span className="nd-usage-caption">可选 · 默认关闭</span></div>
    <div className="config-grp-fields">
      <p className="nd-usage-caption">未开启时默认仅使用本地 FTS5 全文检索（零额外依赖）；开启后将结合所选模型的 <code>/embeddings</code> 接口做混合语义召回，不可用时自动退回 FTS5。</p>
      <StatusDot status={status.tone} label={status.label}/>
      <Switch label="启用可选语义向量召回（FTS5 + Embedding RRF）" checked={draft.enabled} disabled={saving || settings === null}
        onCheckedChange={(enabled) => { setNotice(''); setDraft(previous => ({ ...previous, enabled })); }}/>
      {draft.enabled && <>
        <Field label="向量模型服务">
          <Select value={draft.resourceId} disabled={saving} onChange={event => { setNotice(''); setDraft(previous => ({ ...previous, resourceId: event.target.value })); }}>
            <option value="">请选择模型服务</option>
            {models.map(item => <option key={item.resourceId} value={item.resourceId}>{item.name}</option>)}
          </Select>
        </Field>
        {models.length === 0 && <p className="nd-usage-caption">还没有启用的模型服务，请先在「模型」页添加并启用。</p>}
        <Field label="Embedding 型号">
          <Input value={draft.modelName} maxLength={200} disabled={saving} placeholder="例如 text-embedding-3-small 或 bge-m3"
            onChange={event => { setNotice(''); setDraft(previous => ({ ...previous, modelName: event.target.value })); }}/>
        </Field>
      </>}
      <div>
        <Button size="sm" busy={saving} disabled={!canSave} onClick={() => void save()}>保存</Button>
        {draft.enabled && !validation.ok && <p className="nd-usage-caption" role="alert">{validation.message}</p>}
        {readError && <p role="alert">{readError}</p>}
        {writeError && <p role="alert">{writeError}</p>}
        {notice && <p className="nd-usage-caption" role="status">{notice}</p>}
      </div>
    </div>
  </div>;
}
