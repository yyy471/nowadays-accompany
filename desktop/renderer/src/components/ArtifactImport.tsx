import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../hooks';
import type { ArtifactImportPreview } from '../types';
import { Button, CancelButton, ConfirmButton, ErrorNote, Modal } from '../ui';
import { useDraftRegistration } from '../lib/use-draft-registration';

const KIND_LABELS: Record<'plugin' | 'role-card' | 'worldbook', string> = { plugin: '插件', 'role-card': '角色卡', worldbook: '世界书' };
const FORMAT_LABELS: Record<string, string> = {
  'tavern-v1': '酒馆角色卡 V1（JSON/PNG）',
  'tavern-v2': '酒馆角色卡 V2（JSON/PNG）',
  native: '原生世界书 manifest',
  'tavern-array': '酒馆世界书（数组格式）',
  'tavern-object': '酒馆世界书（对象格式）',
  directory: 'manifest 制品目录'
};

export function ArtifactImport({ refresh, disabled = false, locked = false, onImported }: { refresh: () => Promise<void>; disabled?: boolean; locked?: boolean; onImported?: (kind: 'plugin' | 'role-card' | 'worldbook') => void }) {
  const bridge = window.nowadays ?? window.accompany;
  const available = Boolean(bridge?.openArtifactsDirectory && bridge.previewArtifactImport && bridge.commitArtifactImport);
  const mounted = useRef(true);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const active = useRef(false);
  const previewRef = useRef<ArtifactImportPreview | undefined>(undefined);
  const [busy, setBusy] = useState<'directory' | 'preview' | 'tavern-preview' | 'worldbook-preview' | 'commit'>();
  const [preview, setPreview] = useState<ArtifactImportPreview>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; previewRef.current = undefined; };
  }, []);
  useDraftRegistration({ id: 'artifacts-import', owner: 'page', label: '资源导入', dirty: false, busy: Boolean(busy), revision: 0, discard: () => {} });

  const start = (operation: 'directory' | 'preview' | 'tavern-preview' | 'worldbook-preview' | 'commit'): boolean => {
    if (!mounted.current || lockedRef.current || active.current || disabled || !available) return false;
    active.current = true; setBusy(operation); setError(undefined); setNotice(undefined);
    return true;
  };
  const finish = (): void => {
    active.current = false;
    if (mounted.current) setBusy(undefined);
  };
  const closePreview = (): void => {
    if (active.current || lockedRef.current || !mounted.current) return;
    previewRef.current = undefined; setPreview(undefined); setError(undefined);
  };
  const choose = async (mode: 'directory' | 'tavern-card' | 'worldbook'): Promise<void> => {
    const operation = mode === 'directory' ? 'preview' : mode === 'tavern-card' ? 'tavern-preview' : 'worldbook-preview';
    if (previewRef.current || !start(operation)) return;
    try {
      const result = await bridge!.previewArtifactImport!(mode);
      if (!mounted.current) return;
      previewRef.current = result; setPreview(result);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally { finish(); }
  };
  const openDirectory = async (): Promise<void> => {
    if (!start('directory')) return;
    try { await bridge!.openArtifactsDirectory!(); }
    catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { finish(); }
  };
  const commit = async (): Promise<void> => {
    const selected = previewRef.current;
    if (!selected || !start('commit')) return;
    // Consume this preview before awaiting IPC so double clicks cannot submit it twice.
    previewRef.current = undefined;
    try {
      const result = await bridge!.commitArtifactImport!(selected.token);
      if (!mounted.current) return;
      setPreview(undefined);
      setNotice(`已导入${KIND_LABELS[result.kind]} ${result.id} · ${result.revision}。${result.kind === 'worldbook' ? '尚未在任何会话启用；请在会话世界书设置中选择固定版本。' : '尚未部署，可在资源列表中选择部署。'}`);
      onImported?.(result.kind);
      try { await refresh(); }
      catch (cause) { if (mounted.current) setError(`资源已导入，但列表刷新失败：${errorMessage(cause)}。请刷新资源列表。`); }
    } catch (cause) {
      if (mounted.current) { setPreview(undefined); setError(`${errorMessage(cause)} 请重新选择资源并预览后重试。`); }
    } finally { finish(); }
  };

  return (
    <div className="page-stack">
      <div className="banner-actions">
        <Button icon="package" variant="primary" disabled={!available || disabled || locked || Boolean(busy) || Boolean(preview)} busy={busy === 'preview'} onClick={() => void choose('directory')}>导入资源</Button>
        <Button icon="user" disabled={!available || disabled || locked || Boolean(busy) || Boolean(preview)} busy={busy === 'tavern-preview'} onClick={() => void choose('tavern-card')}>导入酒馆角色卡</Button>
        <Button icon="package" disabled={!available || disabled || locked || Boolean(busy) || Boolean(preview)} busy={busy === 'worldbook-preview'} onClick={() => void choose('worldbook')}>导入世界书 JSON</Button>
        <Button icon="folder" disabled={!available || disabled || locked || Boolean(busy)} busy={busy === 'directory'} onClick={() => void openDirectory()}>打开资源目录</Button>
      </div>
      <p className="field-hint">“导入资源”选择包含 manifest.json 的单个角色卡或插件版本目录；“导入酒馆角色卡”选择 JSON/PNG 文件并转换为角色卡制品；“导入世界书 JSON”接受原生世界书或酒馆世界书 JSON。重复版本不会覆盖。导入不会自动部署或更改账号绑定。</p>
      <p className="field-hint">导入会保留原始文件（世界书原文归档）；first_mes 不会自动发送，世界书默认关闭，可在绑定会话中单独启用。请在确认前阅读文本预览和转换说明。</p>
      {!available ? <p className="field-hint">导入资源和打开受控目录需要桌面版。请在桌面版资源库中操作。</p> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice ? <div className="notice" role="status">{notice}</div> : null}
      <Modal open={Boolean(preview)} title="确认导入资源" closeDisabled={locked || Boolean(busy)} onClose={closePreview}>
        {preview ? <div className="ui-modal-content">
          <dl className="detail-list">
            <div><dt>类型</dt><dd>{KIND_LABELS[preview.kind]}</dd></div>
            <div><dt>来源格式</dt><dd>{FORMAT_LABELS[preview.sourceFormat ?? 'directory'] ?? preview.sourceFormat ?? 'manifest 制品目录'}</dd></div>
            <div><dt>名称</dt><dd>{preview.name ?? preview.id}</dd></div>
            <div><dt>ID</dt><dd className="mono">{preview.id}</dd></div>
            <div><dt>版本</dt><dd className="mono">{preview.revision}</dd></div>
            <div><dt>文件</dt><dd>{preview.fileCount} 个 · {preview.totalBytes.toLocaleString()} 字节</dd></div>
            <div><dt>目标目录</dt><dd><code className="path-inline">{preview.targetPath}</code></dd></div>
            {preview.contentLength !== undefined ? <div><dt>角色文本</dt><dd>{preview.contentLength.toLocaleString()} 字符</dd></div> : null}
          </dl>
          {preview.contentPreview !== undefined ? <div>
            <h3>角色文本预览</h3>
            <pre className="snippet snippet-tall">{preview.contentPreview.slice(0, 2000)}</pre>
            {(preview.contentLength ?? preview.contentPreview.length) > Math.min(preview.contentPreview.length, 2000) ? <p className="field-hint">此处仅展示前 {Math.min(preview.contentPreview.length, 2000).toLocaleString()} 字符，完整文本将随角色卡导入。</p> : null}
          </div> : null}
          {preview.warnings?.length ? <div className="notice notice-warn"><strong>转换说明</strong><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
          {preview.kind === 'worldbook' ? <p>世界书会以不可变版本保存，原文另存归档；不会自动启用，也不会改变任何会话。请在会话世界书设置中明确选择该固定版本。</p>
            : preview.sourceFormat ? <p>原始 JSON/PNG 文件会保留在导入制品中；first_mes 不会自动发送，世界书默认关闭，须在绑定会话中单独启用。</p> : null}
          <p>{preview.kind === 'worldbook' ? '确认后只导入到公用资源目录，不部署、不绑定；取消不会写入。' : '确认后只导入到公用资源目录，不会部署到账号。你可以在资源列表中另行部署；取消不会导入。'}</p>
          <div className="form-submit">
            <CancelButton disabled={locked || Boolean(busy)} onClick={closePreview}>取消</CancelButton>
            <ConfirmButton busy={busy === 'commit'} disabled={disabled || locked || Boolean(busy)} onClick={() => void commit()}>确认导入</ConfirmButton>
          </div>
        </div> : null}
      </Modal>
    </div>
  );
}
