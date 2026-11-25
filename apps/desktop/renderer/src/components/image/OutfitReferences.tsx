import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { describeImageFailure } from '../../image-config';
import type { Outfit } from '../../types';
import { Button, ErrorNote, Field, Input } from '../../ui';

type Entry = { outfitId: string; assetId: string };
function describeRefError(reason: unknown): string {
  if (reason instanceof ApiError) return describeImageFailure(reason.code, reason.message);
  return reason instanceof Error ? reason.message : String(reason);
}
export function OutfitReferences({ roleId, outfits, guardWrite, onChanged }: {
  roleId: string; outfits: Outfit[]; guardWrite: <T>(action: () => Promise<T>, verb?: string) => Promise<T>;
  onChanged: () => void;
}) {
  const [refs, setRefs] = useState<Entry[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revision, refresh] = useState(0);
  const alive = useRef(false);
  const pending = useRef(false);
  const route = '/v1/roles/' + encodeURIComponent(roleId) + '/scene-image';
  const url = (outfitId: string) => route + '/outfits/' + encodeURIComponent(outfitId) + '/reference';
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    void api<{items: Entry[]}>(route + '/references', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setRefs(result.items); setError(''); }
    }).catch(reason => { if (!controller.signal.aborted) setError(describeRefError(reason)); });
    return () => controller.abort();
  }, [route, revision]);
  async function update(outfitId: string, file?: File) {
    if (pending.current) return;
    if (file && file.size > 8 * 1024 * 1024) { setError('服饰参考图上限为 8 MiB。'); return; }
    pending.current = true; setBusy(outfitId); setError('');
    try {
      await guardWrite(async () => {
        if (!alive.current) return;
        if (file) {
          const data = new FormData(); data.append('image', file);
          await api(url(outfitId), { method: 'PUT', body: data });
        } else await api(url(outfitId), { method: 'DELETE' });
      }, file ? '保存服饰参考图' : '移除服饰参考图');
      if (alive.current) { refresh(value => value + 1); onChanged(); }
    } catch (reason) { if (alive.current) setError(describeRefError(reason)); }
    finally { pending.current = false; if (alive.current) setBusy(''); }
  }
  return <section className="nd-image-section" aria-label="服饰参考图">
    <h3>服饰参考图</h3><p className="nd-appearance-hint">每套服饰可配一张参考图，用来生成有角色出场的画面。</p>
    {error && <ErrorNote message={error} onRetry={() => refresh(value => value + 1)} />}
    {!outfits.length && <p className="nd-appearance-hint">在「外观」添加服饰后，就可以在这里上传参考图。</p>}
    {outfits.length > 0 && <div className="nd-image-outfits">{outfits.map(outfit => {
      const current = refs.find(item => item.outfitId === outfit.outfitId);
      return <div key={outfit.outfitId} className="nd-image-outfit-card">
        {current && <div className="nd-image-outfit-thumb"><img src={url(outfit.outfitId) + '?v=' + encodeURIComponent(current.assetId)} alt={outfit.name + '的参考图'} /></div>}
        <div className="nd-image-outfit-body"><Field label={outfit.name + '的参考图'}><Input type="file" accept="image/png,image/jpeg,image/webp" disabled={!!busy} onChange={e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (file) void update(outfit.outfitId, file);
        }}/></Field>
        {current && <Button size="sm" disabled={!!busy} onClick={() => void update(outfit.outfitId)}>移除参考图</Button>}</div>
      </div>;
    })}</div>}
  </section>;
}
