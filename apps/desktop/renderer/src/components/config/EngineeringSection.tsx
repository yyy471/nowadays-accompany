import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { AsyncBoundary, Button, Field, Input, Select, Switch } from '../../ui';
import { memberInputs, memberStatus, moveMember, type EngineeringMember, type EngineeringSettings } from './engineering-settings';
import { ServiceSheet, ServiceSheetActions } from './ServiceParts';
import { useSheet } from './sheet/sheet-context';
import { useWrite } from './write-runner';
import '../../styles/engineering-settings.css';

const endpoint = '/v1/engineering/settings';
const addSheet = 'engineering:add';
const readinessLabels = {
  ready: '已就绪', disabled: '工程已关闭', unbound: '主角色尚未启用工程席位，重新打开工程可启用席位', empty: '工程池没有可用成员', exhausted: '成员正在维护或冷却',
};
type ModelOption = { resourceId: string; name: string; config: Record<string, unknown> };
type Patch = Partial<Pick<EngineeringSettings, 'enabled' | 'mode'>> & { members?: EngineeringMember[] };

export function EngineeringSection({ models, catalogError, catalogReady, onAddService }: {
  models: ModelOption[]; catalogError: string; catalogReady: boolean; onAddService: () => void;
}) {
  const [snapshot, setSnapshot] = useState<{ settings: EngineeringSettings; received: number } | null>(null);
  const [readError, setReadError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [resourceId, setResourceId] = useState('');
  const [modelName, setModelName] = useState('');
  const [saving, setSaving] = useState(false);
  const version = useRef(0);
  const writing = useRef(false);
  const sheet = useSheet();
  const write = useWrite();
  const settings = snapshot?.settings;
  const adding = sheet.sheet?.id === addSheet;
  const blocked = write.busy || write.resuming;
  const update = (value: EngineeringSettings) => {
    const received = Date.now();
    setNow(received);
    setSnapshot({ settings: value, received });
    setReadError('');
  };

  // 分区卸载即停止轮询。迟到的 GET 不能覆盖 PUT 的回执，纸笺字段只随用户输入改变。
  useEffect(() => {
    const request = new AbortController();
    let timer: number;
    const read = async () => {
      const current = version.current;
      try {
        if (!document.hidden && !writing.current) {
          const result = await api<EngineeringSettings>(endpoint, { signal: request.signal });
          if (!request.signal.aborted && current === version.current) update(result);
        }
      } catch (error) {
        if (!request.signal.aborted && current === version.current) setReadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!request.signal.aborted) timer = window.setTimeout(read, 5000);
      }
    };
    void read();
    return () => { request.abort(); window.clearTimeout(timer); };
  }, [refresh]);

  const cooling = settings?.members.some(member => member.state === 'cooldown');
  useEffect(() => {
    if (!cooling) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [cooling]);

  const save = async (patch: Patch, receipt: string) => {
    const finish = write.beginWrite();
    if (!finish) return;
    writing.current = true;
    version.current++;
    setSaving(true);
    setWriteError('');
    try {
      update(await api<EngineeringSettings>(endpoint, { method: 'PUT', body: patch }));
      if (adding) sheet.closeNow(undefined, receipt);
      else write.reportResult(receipt);
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    } finally {
      writing.current = false;
      setSaving(false);
      finish();
    }
  };
  const resetForm = () => { setResourceId(''); setModelName(''); setWriteError(''); };
  const selected = models.find(item => item.resourceId === resourceId);
  const trimmedName = modelName.trim();
  const duplicate = settings?.members.some(item => item.resourceId === resourceId && item.modelName === trimmedName);
  const invalid = !selected ? '请选择模型服务' : !trimmedName ? '请填写模型名' : duplicate ? '这个服务和型号已在池中' : '';
  const count = Number(!!resourceId) + Number(!!trimmedName);
  const elapsed = snapshot ? Math.max(0, Math.floor((now - snapshot.received) / 1000)) : 0;
  return <div className="config-prose nd-usage-page engineering-settings">
    <header className="config-sec-head nd-usage-head"><h2 tabIndex={-1}>工程</h2></header>
    <AsyncBoundary hasData={!!settings} error={readError} loading={!settings && !readError} onRetry={() => setRefresh(value => value + 1)}>
      {settings && <>
        {!adding && writeError && <p role="alert">{writeError}</p>}
        <section className="nd-usage-section" aria-label="工程开关">
          <Switch label="启用工程" checked={settings.enabled} disabled={blocked}
            onCheckedChange={enabled => void save({ enabled }, enabled ? '已启用工程' : '已关闭工程')}/>
          <p className="nd-usage-caption" role="status">{readinessLabels[settings.readiness]}</p>
        </section>
        <section className="nd-usage-section" aria-label="工程模型消耗池">
          <div className="engineering-pool-heading"><h3>工程模型消耗池</h3>
            <div className="engineering-pool-actions">
              <Button size="sm" disabled={blocked || !models.length} onClick={event => {
                resetForm();
                sheet.open({ id: addSheet, title: '添加工程模型', shape: 'compact', anchor: event.currentTarget });
              }}>添加成员</Button>
              <Button size="sm" variant="entry" disabled={blocked} onClick={onAddService}>去模型页添加服务</Button>
            </div>
          </div>
          {catalogError && <p role="alert">{catalogError}</p>}
          {!catalogError && catalogReady && !models.length && <p className="nd-usage-caption">还没有启用的模型服务</p>}
          {settings.members.length === 0 ? <p className="nd-usage-empty">尚未添加工程模型</p> :
            <ol className="engineering-pool-list">{settings.members.map((member, index) => {
              const name = `${member.resourceName ?? member.resourceId} · ${member.modelName}`;
              return <li key={JSON.stringify([member.resourceId, member.modelName])}>
                <div><strong>{name}</strong><span className="nd-usage-caption">{memberStatus(member, elapsed)}</span></div>
                <div className="engineering-pool-actions" role="group" aria-label={name}>
                  <Switch label="参与调度" checked={member.enabled} disabled={blocked}
                    onCheckedChange={enabled => void save({ members: memberInputs(settings.members).map((item, i) => i === index ? { ...item, enabled } : item) }, '已更新成员状态')}/>
                  <Button size="sm" aria-label={`上移 ${name}`} disabled={blocked || index === 0} onClick={() => void save({ members: moveMember(settings.members, index, -1) }, '已更新成员顺序')}>上移</Button>
                  <Button size="sm" aria-label={`下移 ${name}`} disabled={blocked || index === settings.members.length - 1} onClick={() => void save({ members: moveMember(settings.members, index, 1) }, '已更新成员顺序')}>下移</Button>
                  <Button size="sm" variant="ghost" aria-label={`移除 ${name}`} disabled={blocked} onClick={() => void save({ members: memberInputs(settings.members.filter((_, i) => i !== index)) }, '已移除池成员')}>移除</Button>
                </div>
              </li>;
            })}</ol>}
        </section>
        <section className="nd-usage-section" aria-label="调度模式">
          <Field label="调度模式"><Select value={settings.mode} disabled={blocked}
            onChange={event => void save({ mode: event.target.value as EngineeringSettings['mode'] }, '已更新工程调度模式')}>
            <option value="priority">优先级降级</option><option value="round_robin">按任务轮询</option>
          </Select></Field>
        </section>
        <p className="nd-usage-caption">共享主角色已启用的 Skill 与常规外部 MCP</p>
        <ServiceSheet id={addSheet} active={adding} count={count} busy={saving} onDiscard={resetForm}
          footer={<ServiceSheetActions creating count={count} busy={saving} error={writeError} invalid={invalid} onSubmit={() => {
            if (!invalid) void save({ members: [...memberInputs(settings.members), { resourceId, modelName: trimmedName, enabled: true }] }, '已添加工程模型');
          }}/>}>
          {() => <div className="config-grp-fields"><Field label="模型服务"><Select value={resourceId} disabled={saving} onChange={event => {
            const resource = models.find(item => item.resourceId === event.target.value);
            setResourceId(event.target.value);
            setModelName(typeof resource?.config.modelName === 'string' ? resource.config.modelName : '');
          }}><option value="">请选择模型服务</option>{models.map(item => <option key={item.resourceId} value={item.resourceId}>{item.name}</option>)}</Select></Field>
          <Field label="模型名"><Input value={modelName} maxLength={200} disabled={saving} onChange={event => setModelName(event.target.value)}/></Field></div>}
        </ServiceSheet>
      </>}
    </AsyncBoundary>
  </div>;
}
