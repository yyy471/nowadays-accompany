import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { errorText } from '../../lib/error-text';
import { Button, Field, Input, Modal, Select, StatusDot } from '../../ui';
import {
  canApplyTransfer,
  candidatesForBinding,
  transferCapabilityLabel,
  transferRelationMeta,
  type TransferApplyResult,
  type TransferChoice,
  type TransferPreview
} from './role-transfer';
import { useWrite } from './write-runner';
import '../../styles/role-transfer-workspace.css';

type TransferCatalogs = {
  resources: Array<{ resourceId: string; kind: string; name: string }>;
  voiceServices: Array<{ serviceId: string; name: string }>;
  imageServices: Array<{ serviceId: string; name: string }>;
};

export type TransferExportResult = {
  roleId: string;
  digest: string;
  timelineFingerprint: string;
  file: string;
};

export async function exportRolePackage(roleId: string, file: string): Promise<TransferExportResult> {
  const response = await api<{ result: TransferExportResult }>(
    `/v1/roles/${encodeURIComponent(roleId)}/transfer/export`,
    { method: 'POST', body: { file } }
  );
  return response.result;
}

const OUTCOME_LABELS: Record<TransferApplyResult['outcome'], string> = {
  published: '已导入角色包',
  'kept-local': '已保留本机时间线',
  unchanged: '本机已是最新无需变更'
};

type RoleTransferModalProps = TransferCatalogs & {
  open: boolean;
  onClose: () => void;
  onImported?: () => void | Promise<void>;
  onActivityChanged?: () => void;
};

/** 「导入角色包」向导：选择文件 → 预检 → 停止角色 / 绑定映射 / 时间线选择 → 应用。 */
export function RoleTransferModal({ open, onClose, onImported, onActivityChanged, resources, voiceServices, imageServices }: RoleTransferModalProps) {
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [choice, setChoice] = useState<TransferChoice | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<'idle' | 'preflight' | 'apply' | 'stop'>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<TransferApplyResult | null>(null);
  const sequence = useRef(0);
  const busy = phase !== 'idle';

  useEffect(() => {
    if (!open) return;
    sequence.current += 1;
    setFile('');
    setPreview(null);
    setChoice(null);
    setMapping({});
    setPhase('idle');
    setError('');
    setResult(null);
  }, [open]);

  const pickImportFile = async () => {
    const picker = window.nowadaysDesk?.chooseRoleImportFile;
    if (!picker) return;
    try {
      const picked = await picker();
      if (!picked) return;
      setFile(picked);
      setPreview(null);
      setChoice(null);
      setMapping({});
      setResult(null);
      setError('');
    } catch {
      setError('无法打开文件选择窗口。');
    }
  };

  const runPreflight = async (nextMapping: Record<string, string> = mapping) => {
    const target = file.trim();
    if (!target) {
      setError('请先选择或填写角色包文件路径。');
      return;
    }
    const current = ++sequence.current;
    setPhase('preflight');
    setError('');
    try {
      const body: { file: string; mapping?: Record<string, string> } = { file: target };
      if (Object.keys(nextMapping).length > 0) body.mapping = nextMapping;
      const response = await api<{ preview: TransferPreview }>('/v1/role-transfers/preflight', { method: 'POST', body });
      if (current !== sequence.current) return;
      setPreview(response.preview);
      if (!response.preview.requiresChoice) setChoice(null);
    } catch (reason) {
      if (current !== sequence.current) return;
      setPreview(null);
      setError(errorText(reason));
    } finally {
      if (current === sequence.current) setPhase('idle');
    }
  };

  const changeMapping = (key: string, value: string) => {
    const next = { ...mapping };
    if (value) next[key] = value;
    else delete next[key];
    setMapping(next);
    void runPreflight(next);
  };

  const stopRole = async () => {
    if (!preview) return;
    setPhase('stop');
    setError('');
    try {
      await api(`/v1/roles/${encodeURIComponent(preview.roleId)}/activity/stop`, { method: 'POST' });
      onActivityChanged?.();
      await runPreflight();
    } catch (reason) {
      setError(errorText(reason));
      setPhase('idle');
    }
  };

  const apply = async () => {
    const gate = canApplyTransfer(preview, choice);
    if (!preview || !gate.allowed) {
      setError(gate.reason);
      return;
    }
    setPhase('apply');
    setError('');
    try {
      const body: { file: string; token: string; mapping?: Record<string, string>; choice?: TransferChoice } = {
        file: file.trim(),
        token: preview.token
      };
      if (Object.keys(mapping).length > 0) body.mapping = mapping;
      if (choice) body.choice = choice;
      const response = await api<{ result: TransferApplyResult }>('/v1/role-transfers/apply', { method: 'POST', body });
      setResult(response.result);
      void onImported?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPhase('idle');
    }
  };

  const gate = canApplyTransfer(preview, choice);
  const relation = preview ? transferRelationMeta(preview.relation) : null;
  const running = Boolean(preview?.localActivityState && preview.localActivityState !== 'stopped');

  return <Modal open={open} title="导入角色包" description="先预检，再确认时间线与资源映射。" className="role-transfer-modal"
    closeDisabled={busy} onClose={onClose}>
    {result ? <div className="role-transfer-receipt" role="status">
      <strong>{OUTCOME_LABELS[result.outcome]}</strong>
      <p>{result.outcome === 'unchanged' ? '本机已经是角色包中的最新进度。' : '角色列表与活动状态已经刷新，可以继续在角色配置中检查。'}</p>
    </div> : <div className="role-transfer-body">
      <section className="role-transfer-section">
        <h3>角色包文件</h3>
        <div className="role-transfer-file">
          <Field label="文件路径"><Input value={file} disabled={busy} placeholder="选择或填写 .json 角色包路径"
            onChange={event => { setFile(event.target.value); setPreview(null); setChoice(null); setMapping({}); setResult(null); }} /></Field>
          <div className="role-transfer-file-actions">
            {window.nowadaysDesk?.chooseRoleImportFile && <Button size="sm" variant="ghost" icon="upload" disabled={busy} onClick={() => void pickImportFile()}>选择文件</Button>}
            <Button size="sm" disabled={busy || !file.trim()} onClick={() => void runPreflight()}>预检角色包</Button>
          </div>
        </div>
      </section>

      {error && <p className="role-transfer-error" role="alert">{error}</p>}

      {preview && relation && <>
        <section className="role-transfer-section">
          <h3>预检结果</h3>
          <strong>{preview.displayName || preview.roleId}</strong>
          <div className="role-transfer-relation">
            <StatusDot status={relation.tone} label={relation.label} />
            <p>{relation.detail}</p>
          </div>
          <p className="role-transfer-notice">{preview.registered ? '本机已登记该角色。' : '本机尚未登记该角色，导入后会新建。'}</p>
        </section>

        {running && <section className="role-transfer-section" aria-live="polite">
          <h3>目标角色正在运行</h3>
          <p className="role-transfer-notice">导入会改写角色数据，请先停止该角色的活动；停止不会丢失已保存的对话与记忆。</p>
          <div className="role-transfer-file-actions">
            <Button size="sm" variant="danger" busy={phase === 'stop'} disabled={busy && phase !== 'stop'} onClick={() => void stopRole()}>停止该角色</Button>
          </div>
        </section>}

        {preview.bindings.length > 0 && <section className="role-transfer-section">
          <h3>绑定映射</h3>
          <p className="role-transfer-notice">仍有 {preview.unresolved.length} 项未映射。选择本机资源后会自动重新预检；也可以先不映射，导入后在角色配置中手动补上。</p>
          <div className="role-transfer-bindings">
            {preview.bindings.map(binding => {
              const candidates = candidatesForBinding(binding, { resources, voiceServices, imageServices });
              return <div className="role-transfer-binding" key={binding.key}>
                <div>
                  <strong>{transferCapabilityLabel(binding.capability)}</strong>
                  <small title={binding.sourceResourceId}>{binding.modelName || binding.sourceResourceId}</small>
                </div>
                <Select aria-label={`${transferCapabilityLabel(binding.capability)}的映射`} value={mapping[binding.key] ?? ''}
                  disabled={busy} onChange={event => changeMapping(binding.key, event.target.value)}>
                  <option value="">暂不映射（导入后手配）</option>
                  {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                </Select>
              </div>;
            })}
          </div>
        </section>}

        {preview.requiresChoice && <section className="role-transfer-section">
          <h3>时间线选择</h3>
          <div className="role-transfer-choice" role="radiogroup" aria-label="选择要保留的时间线">
            <button type="button" role="radio" aria-checked={choice === 'local'} disabled={busy} onClick={() => setChoice('local')}>
              <strong>保留本机时间线</strong>
              <small>保留本机现有对话与记忆，不写入本次角色包内容。</small>
            </button>
            <button type="button" role="radio" aria-checked={choice === 'package'} disabled={busy} onClick={() => setChoice('package')}>
              <strong>采用角色包时间线</strong>
              <small>以角色包中的进度为准，本机这段分化进度会被替换。</small>
            </button>
          </div>
        </section>}
      </>}
    </div>}
    <footer className="ui-dialog-actions">
      {result ? <Button variant="primary" onClick={onClose}>完成</Button> : <>
        {!gate.allowed && preview && <span className="role-transfer-notice" role="status">{gate.reason}</span>}
        <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
        <Button variant="primary" busy={phase === 'apply'} disabled={!gate.allowed} onClick={() => void apply()}>确认导入</Button>
      </>}
    </footer>
  </Modal>;
}

export type RoleExportTarget = { roleId: string; displayName?: string | null };

/** 无桌面文件选择器时的回退：直接输入保存路径后调用导出接口。 */
export function RoleExportModal({ open, role, onClose }: { open: boolean; role: RoleExportTarget | null; onClose: () => void }) {
  const write = useWrite();
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setFile('');
    setBusy(false);
    setError('');
  }, [open]);

  if (!role) return null;
  const targetRole = role;
  const roleName = targetRole.displayName || targetRole.roleId;
  const picker = window.nowadaysDesk?.chooseRoleExportFile;

  const pickFile = async () => {
    if (!picker) return;
    try {
      const picked = await picker(`${roleName}.json`);
      if (picked) setFile(picked);
    } catch {
      setError('无法打开文件选择窗口。');
    }
  };

  const save = async () => {
    const target = file.trim();
    if (!target) {
      setError('请填写角色包保存路径。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await exportRolePackage(targetRole.roleId, target);
      write.reportResult('已导出角色包');
      onClose();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return <Modal open={open} title="导出角色包" description={`为「${roleName}」选择保存位置。`}
    className="role-transfer-modal" closeDisabled={busy} onClose={onClose}>
    <div className="role-transfer-body">
      <section className="role-transfer-section">
        <h3>保存位置</h3>
        <div className="role-transfer-file">
          <Field label="文件路径"><Input value={file} disabled={busy} placeholder="填写角色包要保存到的 .json 路径"
            onChange={event => setFile(event.target.value)} /></Field>
          <div className="role-transfer-file-actions">
            {picker && <Button size="sm" variant="ghost" icon="folder" disabled={busy} onClick={() => void pickFile()}>选择文件</Button>}
            {!picker && <p className="role-transfer-notice">当前环境没有桌面文件选择器，请直接填写保存路径。</p>}
          </div>
        </div>
      </section>
      {error && <p className="role-transfer-error" role="alert">{error}</p>}
    </div>
    <footer className="ui-dialog-actions">
      <Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" busy={busy} disabled={!file.trim()} onClick={() => void save()}>导出</Button>
    </footer>
  </Modal>;
}
