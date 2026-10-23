import { Input, ControlButton, ConfirmButton, CancelButton, useConfirm } from '../ui';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorMessage, usePoll } from '../hooks';
import type { InjectionRuntimeResponse, InjectionSettingsResponse, SnowLumaRuntimeStatus } from '../types';
import { Button, Card, ErrorNote, Field, Icon, Tag } from '../ui';

type Step = 1 | 2 | 3;
type FormDraft = { runtimeDir: string; baseUrl: string; password: string };
type ConnectionTestResponse = { ok: true; runtime: SnowLumaRuntimeStatus; processCount: number };

const OFFICIAL_RELEASES = 'https://github.com/SnowLuma/SnowLuma/releases';
const LICENSE_URL = 'https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE';
const EULA_URL = 'https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md';
const PRIVACY_URL = 'https://github.com/SnowLuma/SnowLuma/blob/main/PRIVACY.md';

function localManagementUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return undefined;
    if (url.username || url.password || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function SnowLumaSetup({
  onDirtyChange,
  onBusyChange
}: {
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const confirm = useConfirm();
  const settings = usePoll<InjectionSettingsResponse>('/injection/settings');
  const runtime = usePoll<InjectionRuntimeResponse>('/injection/runtime', 8000);
  const [form, setForm] = useState<FormDraft>({ runtimeDir: '', baseUrl: '', password: '' });
  const [busy, setBusy] = useState<string>();
  const [step, setStep] = useState<Step>(1);
  const [editing, setEditing] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [verified, setVerified] = useState<{ at: number; processCount: number; runtimeDataBefore?: InjectionRuntimeResponse }>();
  const initialized = useRef(false);
  const settingsLoaded = settings.data !== undefined;
  const saved = settings.data?.settings;
  const status = runtime.data?.runtime;
  const configured = Boolean(status?.configured || saved?.runtimeDir);
  const dirty = form.password.length > 0 ||
    form.runtimeDir.trim() !== (saved?.runtimeDir ?? '') ||
    form.baseUrl.trim() !== (saved?.baseUrl ?? '');
  const isBusy = Boolean(busy);

  useEffect(() => {
    if (!saved || initialized.current) return;
    initialized.current = true;
    setForm({ runtimeDir: saved.runtimeDir ?? '', baseUrl: saved.baseUrl ?? '', password: '' });
  }, [saved]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange?.(isBusy), [isBusy, onBusyChange]);
  useEffect(() => {
    if (verified && runtime.data && runtime.data !== verified.runtimeDataBefore && (!runtime.data.runtime.running || !runtime.data.runtime.authenticated)) {
      setVerified(undefined);
      setNotice(undefined);
    }
  }, [verified, runtime.data]);

  const update = (patch: Partial<FormDraft>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setError(undefined);
    setNotice(undefined);
    setVerified(undefined);
  };

  const save = async (): Promise<void> => {
    if (!settingsLoaded) return;
    const runtimeDir = form.runtimeDir.trim();
    if (!runtimeDir) {
      setError('请填写 SnowLuma runtime 目录。');
      setNotice(undefined);
      return;
    }
    const baseUrl = form.baseUrl.trim();
    setBusy('save');
    setError(undefined);
    setNotice(undefined);
    setVerified(undefined);
    try {
      await api('/injection/settings', {
        method: 'PUT',
        body: JSON.stringify({
          runtimeDir,
          ...(baseUrl ? { baseUrl } : {}),
          ...(form.password ? { password: form.password } : {})
        })
      });
      setForm({ runtimeDir, baseUrl, password: '' });
      setNotice('连接设置已保存。接下来验证现有 SnowLuma 服务。');
      await Promise.all([settings.refresh(), runtime.refresh()]);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(undefined);
    }
  };

  const verifyConnection = async (): Promise<void> => {
    if (dirty || !configured) return;
    const runtimeDataBefore = runtime.data;
    setBusy('test');
    setError(undefined);
    setNotice(undefined);
    setVerified(undefined);
    try {
      const result = await api<ConnectionTestResponse>('/injection/connection/test', { method: 'POST', body: JSON.stringify({}) });
      if (!result.ok) throw new Error('SnowLuma 连接验证失败。');
      setVerified({ at: Date.now(), processCount: result.processCount, runtimeDataBefore });
      setNotice(`连接已验证，可读取 ${result.processCount} 个 QQ 进程。验证不会注入或启动 QQ。`);
      await runtime.refresh();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(undefined);
    }
  };

  const clearPassword = async (): Promise<void> => {
    if (!await confirm({title: '清除管理密码？', description: '清除后需要重新填写才能验证 SnowLuma 连接。', confirmLabel: '清除密码', tone: 'danger'})) return;
    setBusy('clear');
    setError(undefined);
    setNotice(undefined);
    setVerified(undefined);
    try {
      await api('/injection/password', { method: 'DELETE' });
      setNotice('已清除 SnowLuma 管理密码。');
      await Promise.all([settings.refresh(), runtime.refresh()]);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(undefined);
    }
  };

  const chooseDirectory = async (): Promise<void> => {
    const chooser = (window as unknown as { nowadays?: { chooseRuntimeDirectory?: () => Promise<string | null> } }).nowadays?.chooseRuntimeDirectory;
    if (typeof chooser !== 'function') return;
    setBusy('directory');
    setError(undefined);
    try {
      const directory = await chooser();
      if (directory) update({ runtimeDir: directory });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(undefined);
    }
  };

  const managementUrl = localManagementUrl(status?.baseUrl ?? saved?.baseUrl ?? form.baseUrl);
  const pickerAvailable = typeof (window as unknown as { nowadays?: { chooseRuntimeDirectory?: unknown } }).nowadays?.chooseRuntimeDirectory === 'function';
  const currentVerification = Boolean(verified && status?.running && status.authenticated);
  const statusTags = status ? (
    <div className="chip-row">
      <Tag tone={status.running ? 'ok' : 'idle'}>{status.running ? '管理服务在线' : '管理服务未运行'}</Tag>
      <Tag tone={status.compatible ? 'ok' : 'bad'}>{status.version ?? '版本未知'} / 支持 {status.supportedVersion}</Tag>
      <Tag tone={status.authenticated ? 'ok' : 'warn'}>{status.authenticated ? '已验证密码' : '尚未验证'}</Tag>
      <Tag tone={status.autoLoadKnown ? status.autoLoadEnabled ? 'bad' : 'ok' : 'warn'}>{status.autoLoadKnown ? status.autoLoadEnabled ? '自动注入已开启' : '自动注入已关闭' : '自动注入状态未知'}</Tag>
      {status.consentRequired ? <Tag tone="warn">尚未完成官方协议确认</Tag> : null}
      {status.owner === 'external' && status.running ? <Tag tone="idle">复用现有服务</Tag> : null}
    </div>
  ) : <p className="muted" role="status">正在读取 SnowLuma 状态…</p>;

  const connectionForm = (
    <Card title={configured ? '连接设置' : '连接已有 SnowLuma'} subtitle="填写已初始化的目录和 WebUI 密码；密码由本机凭据库保护，界面不会回显。">
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Field label="SnowLuma runtime 目录" hint="选择已安装并初始化的 SnowLuma 目录，应用不会下载或启动它。">
          <div className="runtime-directory-input">
            <Input value={form.runtimeDir} disabled={isBusy || !settingsLoaded} onChange={(event) => update({ runtimeDir: event.target.value })} placeholder="选择 SnowLuma runtime 目录" />
            {pickerAvailable ? <Button type="button" variant="ghost" disabled={isBusy || !settingsLoaded} busy={busy === 'directory'} onClick={() => void chooseDirectory()}>浏览…</Button> : null}
          </div>
        </Field>
        <Field label="WebUI 管理密码" hint={status?.passwordConfigured ? '已保存；留空表示不修改。' : '填写你在 SnowLuma 官方界面设置的密码。'}>
          <Input type="password" autoComplete="new-password" value={form.password} disabled={isBusy || !settingsLoaded} onChange={(event) => update({ password: event.target.value })} placeholder={status?.passwordConfigured ? '已保存（留空不修改）' : '输入 SnowLuma WebUI 密码'} />
        </Field>
        <details className="inline-details">
          <summary>高级连接选项</summary>
          <Field label="管理地址" hint="留空时从 SnowLuma 配置自动读取；仅支持本机回环地址。">
            <Input value={form.baseUrl} disabled={isBusy || !settingsLoaded} onChange={(event) => update({ baseUrl: event.target.value })} placeholder="自动读取本地 WebUI 地址" />
          </Field>
        </details>
        <div className="form-submit">
          {status?.passwordConfigured ? <Button type="button" variant="ghost" busy={busy === 'clear'} disabled={isBusy || !settingsLoaded} onClick={() => void clearPassword()}>清除已保存密码</Button> : null}
          {configured && !dirty ? <Button type="button" variant="ghost" busy={busy === 'test'} disabled={isBusy} onClick={() => void verifyConnection()}>验证连接</Button> : null}
          <ConfirmButton type="submit" variant="primary" busy={busy === 'save'} disabled={isBusy || !settingsLoaded || !dirty}>保存连接设置</ConfirmButton>
        </div>
      </form>
      {!settingsLoaded && !settings.error ? <p className="muted" role="status">正在读取已保存的连接设置…</p> : null}
      {settings.error ? <ErrorNote message={`无法读取连接设置：${settings.error}`} onRetry={() => void settings.refresh()} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      {notice && (!verified || currentVerification) ? <div className="notice notice-ok" role="status">{notice}</div> : null}
      {dirty ? <p className="field-hint">你正在编辑未保存的草稿。保存之前不会验证已保存的连接。</p> : null}
      {currentVerification && verified ? <p className="field-hint">上次验证成功：{new Date(verified.at).toLocaleTimeString('zh-CN')} · {verified.processCount} 个 QQ 进程</p> : null}
      {runtime.error ? <ErrorNote message={runtime.error} onRetry={() => void runtime.refresh()} /> : null}
    </Card>
  );

  return (
    <div className="snowluma-setup page-stack">
      {status?.error ? <ErrorNote message={status.error} /> : null}
      {configured && !editing && !showGuide ? (
        <Card title="SnowLuma 已配置" subtitle="由你手动启动；点击“注入并监听”后才开始注入和监听。nowadays 不下载或启动 SnowLuma，也不自动注入 QQ。" actions={<Button size="sm" variant="ghost" icon="refresh" busy={busy === 'test'} disabled={isBusy || dirty} onClick={() => void verifyConnection()}>验证连接</Button>}>
          {statusTags}
          {managementUrl ? <p><a href={managementUrl} target="_blank" rel="noreferrer">打开 SnowLuma 管理页面</a></p> : null}
          {dirty ? <p className="field-hint">当前有未保存修改，请进入编辑并保存后再验证。</p> : null}
          <div className="form-submit"><Button type="button" variant="default" disabled={isBusy} onClick={() => { setEditing(true); setError(undefined); setNotice(undefined); }}>修改连接设置</Button><Button type="button" variant="ghost" disabled={isBusy} onClick={() => { setStep(1); setShowGuide(true); setError(undefined); }}>查看首次准备说明</Button></div>
          {error ? <ErrorNote message={error} /> : null}
          {notice && (!verified || currentVerification) ? <div className="notice notice-ok" role="status">{notice}</div> : null}
          {currentVerification && verified ? <p className="field-hint">上次验证成功：{new Date(verified.at).toLocaleTimeString('zh-CN')} · {verified.processCount} 个 QQ 进程</p> : null}
          {runtime.error ? <ErrorNote message={runtime.error} onRetry={() => void runtime.refresh()} /> : null}
        </Card>
      ) : configured && editing ? (
        <>
          <div className="settings-section-heading"><h2>修改 SnowLuma 连接</h2><p>修改后保存，再验证已保存的连接。取消不会清除现有配置。</p></div>
          {connectionForm}
          <div className="form-submit"><CancelButton type="button" variant="ghost" disabled={isBusy} onClick={() => { setEditing(false); setForm({ runtimeDir: saved?.runtimeDir ?? '', baseUrl: saved?.baseUrl ?? '', password: '' }); setError(undefined); setNotice(undefined); }}>取消修改</CancelButton></div>
          {managementUrl ? <p><a href={managementUrl} target="_blank" rel="noreferrer">打开 SnowLuma 管理页面</a></p> : null}
        </>
      ) : (
        <Card title="首次连接 SnowLuma" subtitle="按顺序准备并连接一个已运行的本地服务。协议确认、初始化和启动都由你在 SnowLuma 官方界面完成。">
          <nav className="snowluma-stepper" aria-label="SnowLuma首次连接步骤">
            {([1, 2, 3] as const).map((value) => (
              <ControlButton key={value} type="button" className={`snowluma-step${step === value ? ' active' : ''}`} aria-current={step === value ? 'step' : undefined} disabled={isBusy} onClick={() => setStep(value)}>
                <span>{value}</span><strong>{value === 1 ? '官方准备' : value === 2 ? '官方初始化' : '连接已有服务'}</strong>
              </ControlButton>
            ))}
          </nav>
          {step === 1 ? (
            <div className="snowluma-step-content">
              <h3>从 SnowLuma 官方渠道获取</h3>
              <p>当前集成支持 SnowLuma 1.14.x。请在官方发行页选择兼容版本并自行下载、解压；不要直接选择尚未确认兼容的最新版。nowadays 不会替你下载或安装 SnowLuma。</p>
              <p className="snowluma-links"><a href={OFFICIAL_RELEASES} target="_blank" rel="noreferrer">打开官方 Releases</a><a href={EULA_URL} target="_blank" rel="noreferrer">阅读发行包 EULA</a><a href={LICENSE_URL} target="_blank" rel="noreferrer">阅读源码 License</a><a href={PRIVACY_URL} target="_blank" rel="noreferrer">阅读隐私说明</a></p>
              <div className="settings-note"><Icon name="shield" size={15} /><span>请先阅读 SnowLuma 的发行包条款与隐私说明，再决定是否继续使用。</span></div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="snowluma-step-content">
              <h3>在官方入口完成初始化</h3>
              <ol>
                <li>手动启动 SnowLuma 1.14.x，并在它自己的官方界面完成协议确认。</li>
                <li>设置 WebUI 管理密码，并将 `hookAutoLoad` 设为 `false`，避免客户端自行注入。</li>
                <li>确认 SnowLuma 管理服务已经运行。nowadays 不会替你接受协议、修改配置或启动服务。</li>
              </ol>
              {managementUrl ? <p><a href={managementUrl} target="_blank" rel="noreferrer">打开本机 SnowLuma 管理页面</a></p> : <p className="muted">连接后可从这里打开已识别的本机管理页面。</p>}
            </div>
          ) : null}
          {step === 3 ? <div className="snowluma-step-content">{connectionForm}</div> : null}
          {error ? <ErrorNote message={error} /> : null}
          {notice && (!verified || currentVerification) ? <div className="notice notice-ok" role="status">{notice}</div> : null}
          <div className="form-submit">
            <Button type="button" variant="ghost" disabled={isBusy || step === 1} onClick={() => setStep((current) => (current === 3 ? 2 : 1))}>上一步</Button>
            {step < 3 ? <Button type="button" variant="primary" disabled={isBusy} onClick={() => setStep((current) => (current === 1 ? 2 : 3))}>下一步</Button> : null}
            {configured && showGuide ? <Button type="button" variant="ghost" disabled={isBusy} onClick={() => setShowGuide(false)}>返回连接状态</Button> : null}
          </div>
        </Card>
      )}
      {status && !configured ? statusTags : null}
      {status?.consentRequired ? <div className="notice"><Icon name="shield" size={16} /><span>SnowLuma 尚未确认协议。请回到官方界面完成后再连接；应用不会代为确认。</span></div> : null}
    </div>
  );
}
