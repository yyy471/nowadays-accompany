import { useEffect, useRef, useState } from 'react';
import { api, apiUpload } from '../../api';
import type { Outfit } from '../../types';
import { appearanceAssetUrl } from '../../types';
import { Button, Field, LoadingNote, Select } from '../../ui';

type Props = {
  roleId: string;
  currentOutfitId?: string;
  onChanged?: () => void;
};

type FolderGroup = {
  name: string;
  home?: File;
  sprites: File[];
};

const folderAttributes = {
  webkitdirectory: '',
  directory: '',
} as unknown as Record<string, string>;

export function AppearancePanel({ roleId, currentOutfitId, onChanged }: Props) {
  const [items, setItems] = useState<Outfit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('');
  const folderInput = useRef<HTMLInputElement>(null);
  const spriteInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const result = await api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`);
      setItems(result.items);
      setError('');
      setSelected(previous => result.items.some(item => item.outfitId === previous) ? previous : (result.items[0]?.outfitId ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setItems([]); setSelected(''); setError(''); setNotice(''); setLoading(true);
    void api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`).then(result => {
      if (!active) return;
      setItems(result.items);
      setSelected(result.items[0]?.outfitId ?? '');
      setLoading(false);
    }).catch(e => {
      if (active) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); }
    });
    return () => { active = false; };
  }, [roleId]);

  const importFolder = async (files: FileList | null) => {
    if (!files || files.length === 0 || busy) return;
    const groups = groupFolderFiles([...files]);
    if (groups.length === 0) {
      setNotice('没有找到 outfits/<服饰名>/home.* 或 sprites/ 图片。');
      return;
    }
    setBusy(true); setNotice(''); setError('');
    const results: string[] = [];
    try {
      for (const group of groups) {
        const form = new FormData();
        form.append('name', group.name);
        if (group.home) form.append('home', group.home, group.home.name);
        for (const sprite of group.sprites) form.append('sprites', sprite, sprite.name);
        try {
          await apiUpload<Outfit>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`, form);
          results.push(`已导入「${group.name}」`);
        } catch (e) {
          results.push(`「${group.name}」${e instanceof Error ? e.message : String(e)}`);
        }
      }
      setNotice(results.join('；'));
      await load();
      onChanged?.();
    } finally {
      setBusy(false);
      if (folderInput.current) folderInput.current.value = '';
    }
  };

  const uploadSprite = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy) return;
    if (!selected) { setNotice('请先选择一套已有服饰。'); return; }
    setBusy(true); setNotice(''); setError('');
    try {
      const form = new FormData();
      form.append('sprite', file, file.name);
      await apiUpload(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits/${encodeURIComponent(selected)}/sprites`, form);
      setNotice(`已添加差分「${file.name.replace(/\.[^.]+$/, '')}」`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (spriteInput.current) spriteInput.current.value = '';
    }
  };

  return <div className="nd-appearance">
    <p className="nd-appearance-hint">选择包含 <code>outfits</code> 目录的角色文件夹整套导入。每套服饰的 <code>home.*</code> 为主页立绘，<code>sprites/</code> 下为对话差分；同一角色的服饰名不能重复，已有服饰可继续补差分。</p>
    <div className="nd-appearance-actions">
      <input ref={folderInput} type="file" multiple accept="image/png,image/jpeg,image/webp" {...folderAttributes} className="nd-visually-hidden" onChange={event => void importFolder(event.target.files)} />
      <Button disabled={busy} onClick={() => folderInput.current?.click()}>{busy ? '正在导入…' : '导入整套服饰'}</Button>
      {currentOutfitId ? <span className="nd-appearance-current">当前穿着：{items.find(item => item.outfitId === currentOutfitId)?.name ?? '未知服饰'}</span> : null}
    </div>
    {loading ? <LoadingNote label="正在读取衣柜…" /> : items.length === 0 ? <p className="nd-appearance-empty">这个角色还没有导入服饰。</p> : <ul className="nd-outfit-list">
      {items.map(outfit => <li key={outfit.outfitId} className={'nd-outfit' + (outfit.outfitId === selected ? ' selected' : '') + (outfit.outfitId === currentOutfitId ? ' current' : '')}>
        <button type="button" className="nd-outfit-card" aria-pressed={outfit.outfitId === selected} onClick={() => setSelected(outfit.outfitId)}>
          <span className="nd-outfit-thumb">{outfit.home ? <img src={appearanceAssetUrl(roleId, outfit.home.assetId)} alt="" /> : <span>无主页图</span>}</span>
          <span className="nd-outfit-meta"><b>{outfit.name}</b><small>{outfit.description ?? '未填写用途'} · {outfit.sprites.length} 张差分</small></span>
        </button>
        {outfit.sprites.length > 0 ? <p className="nd-outfit-sprites">{outfit.sprites.map(sprite => sprite.displayName).join('、')}</p> : null}
      </li>)}
    </ul>}
    <div className="nd-sprite-upload">
      <Field label="补一张差分到已有服饰"><Select value={selected} disabled={busy || items.length === 0} onChange={event => setSelected(event.target.value)}>
        {items.length === 0 ? <option value="">暂无服饰</option> : items.map(outfit => <option key={outfit.outfitId} value={outfit.outfitId}>{outfit.name}</option>)}
      </Select></Field>
      <input ref={spriteInput} type="file" accept="image/png,image/jpeg,image/webp" className="nd-visually-hidden" onChange={event => void uploadSprite(event.target.files)} />
      <Button disabled={busy || !selected} onClick={() => spriteInput.current?.click()}>上传差分图片</Button>
    </div>
    {notice ? <p className="nd-appearance-notice" role="status">{notice}</p> : null}
    {error ? <p className="nd-appearance-error" role="alert">{error}</p> : null}
  </div>;
}

function groupFolderFiles(files: File[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/').filter(Boolean);
    const outfits = parts.indexOf('outfits');
    if (outfits < 0 || parts.length < outfits + 3) continue;
    const name = parts[outfits + 1];
    if (!name) continue;
    const rest = parts.slice(outfits + 2);
    const group = groups.get(name) ?? { name, sprites: [] };
    if (rest.length === 1 && /^home\.[^.]+$/i.test(rest[0])) {
      group.home = file;
    } else if (rest[0] === 'sprites' && rest.length === 2) {
      group.sprites.push(file);
    }
    groups.set(name, group);
  }
  return [...groups.values()].filter(group => group.home !== undefined || group.sprites.length > 0);
}
