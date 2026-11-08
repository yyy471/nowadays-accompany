import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from './api';
import type { RoleDetail, RoleListItem } from './types';
import { Button, ControlButton, Field, Icon, Input, Modal, Textarea, UiThemeScope, useMotionPolicy } from './ui';
import { useThemePreset, useThemeTransitionStrategy } from './ui/presets';
import { relationshipJournalThemeTransition } from './ui/relationship-journal-transition';
import clerk from './assets/relationship-journal/clerk.svg';

type Props = { roles: RoleListItem[]; detail?: RoleDetail; status: string; error: string; currentId: string; onSelect: (id: string) => void; onRefresh: (id?: string) => Promise<void> };
type Draft = { name: string; definition: string; revision: number; payload: Record<string, unknown> };
type Binding = { capability: string; resourceId: string; modelName: string | null; enabled: boolean };
type Resource = { resourceId: string; kind: string; name: string; enabled: boolean };

export function Relations({ roles, detail, status, error, currentId, onSelect, onRefresh }: Props) {
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  useThemeTransitionStrategy(relationshipJournalThemeTransition);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [definition, setDefinition] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [bookMotion, setBookMotion] = useState('');
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [capabilityError, setCapabilityError] = useState('');
  const [overview, setOverview] = useState(false);
  const [xray, setXray] = useState(false);
  const [selectedBinding, setSelectedBinding] = useState<Binding>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    let active = true;
    setBindings([]); setResources([]); setCapabilityError('');
    if (!currentId) return;
    Promise.all([api<{items: Binding[]}>(`/v1/roles/${encodeURIComponent(currentId)}/bindings`), api<{items: Resource[]}>('/v1/resources')]).then(([bound, available]) => {
      if (active) { setBindings(bound.items); setResources(available.items); }
    }).catch(e => { if (active) setCapabilityError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [currentId]);
  const current = roles.find(r => r.roleId === currentId);
  const draft = currentId ? drafts[currentId] : undefined;
  const choose = (id: string) => {
    if (busy || id === currentId) return;
    clearTimeout(timer.current);
    if (motion.reduced) { onSelect(id); return; }
    setBookMotion('closing');
    timer.current = setTimeout(() => {
      onSelect(id); setBookMotion('opening');
      timer.current = setTimeout(() => setBookMotion(''), 480);
    }, 300);
  };
  const edit = () => {
    if (!detail) return;
    setDrafts(previous => ({ ...previous, [currentId]: previous[currentId] || { name: detail.displayName, definition: detail.definition.text, revision: detail.definitionRevision, payload: detail.definition.payload } }));
    setMessage(''); setEditing(true);
  };
  const save = async () => {
    if (!draft || busy) return;
    setBusy(true); setMessage('');
    try {
      await api(`/v1/roles/${encodeURIComponent(currentId)}/definition`, { method: 'PATCH', body: { displayName: draft.name.trim(), definition: { text: draft.definition.trim(), payload: draft.payload }, expectedRevision: draft.revision } });
      setDrafts(previous => { const next = { ...previous }; delete next[currentId]; return next; });
      setEditing(false); await onRefresh(currentId); setMessage('已保存');
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const create = async () => {
    if (busy || !name.trim() || !definition.trim()) return;
    setBusy(true); setMessage('');
    try {
      const role = await api<RoleDetail>('/v1/roles', { method: 'POST', body: { displayName: name.trim(), definition: { text: definition.trim() } } });
      setCreating(false); setName(''); setDefinition(''); await onRefresh(role.roleId);
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const night = preset === 'nightwave';
  return <UiThemeScope theme="xiacheng" preset={preset} motion={motion.reduced ? 'reduced' : 'full'} className="wj-journal">
    <div className="wj-body">
      {(error || message) && <div className={'wj-notice' + (error ? ' error' : '')} role="status">{error || message}</div>}
      <div className="stage">
        <section className="shelf" aria-label="选择角色"><div className="shelf-row">{roles.map((role, i) =>
          <ControlButton key={role.roleId} className={'spine c-'+['blue','rose','sage'][i%3]+' st-online'+(currentId===role.roleId?' cur':'')} aria-pressed={currentId===role.roleId} title={role.displayName} disabled={busy} onClick={() => choose(role.roleId)}>
            <span className="sp-top"><span className="led"/><b>{String.fromCharCode(65+i%26)}</b></span><span className="sp-name">{role.displayName}</span><span className="sp-grille"/><span className="sp-band">{role.status === 'ready' ? '就绪' : '待处理'}</span>
          </ControlButton>)}</div><div className="shelf-plank"/><p className="shelf-cap">{current?.displayName || '角色书架'} · {roles.length} 位角色</p></section>
        <nav className="strip" aria-label="角色页签"><div className="glass"/><div className="ticks" aria-hidden="true">{Array.from({length:41}, (_,i) => <span key={i}><i className={'tk'+(i%4===1?' maj':'')} style={{left:`${i*2.5}%`}}/>{i%4===1 && <span className="fq" style={{left:`${i*2.5}%`}}>{(87.5+i*.5).toFixed(0)}</span>}</span>)}</div>
          <div className="stations">{roles.map((role,i) => <ControlButton key={role.roleId} className={'stn t-conv k-private'+(currentId===role.roleId?' cur':'')} style={{left:`${Math.min(90,10+i*80/Math.max(1,roles.length-1))}%`} as CSSProperties} aria-current={currentId===role.roleId?'page':undefined} onClick={() => choose(role.roleId)}><span className="no">{i+1}</span><span className="nm">{role.displayName}</span><i className="dot"/></ControlButton>)}</div>
          {current && <i className="needle" style={{left:`${Math.min(90,10+roles.findIndex(r=>r.roleId===currentId)*80/Math.max(1,roles.length-1))}%`}}/>}<span className="edge"/>
        </nav>
        <div className="tools"><ControlButton className="tool ov-tool" aria-pressed={overview} onClick={() => setOverview(value => !value)}><span className="ov-ico" aria-hidden="true"><i/><i/><i/><i/><i/><i/></span><span>{night?'全频扫描':'摊开全本'}<small>关系总览 · 全部角色</small></span></ControlButton><ControlButton className="tool" aria-pressed={xray} onClick={() => setXray(value => !value)}><Icon name="overview"/><span>{night?'信号来路':'掀开透光'}<small>查看能力状态</small></span></ControlButton></div>
        <section className={'book cover-blue '+bookMotion+(xray?' xray':'')} aria-label="当前关系页">
          {overview ? <section className={'ov entering'+(night?' spec':'')} aria-label="关系总览">
            <header className="ov-h"><div className="ov-ti"><h1>{night?'全频扫描':'摊开全本'}<small>关系总览</small></h1></div><ControlButton className="wj-action" onClick={() => setOverview(false)}>回到当前页</ControlButton></header>
            <div className="ov-cz"><span className="cz-k">名册 <b>{roles.length}</b> 位角色</span></div>
            <div className="ov-wall"><section className="ov-book c-blue"><header className="ob-h"><div className="ob-t"><h3>角色名册</h3><p className="cap">选择角色，翻到对应的一页</p></div></header><div className="ob-grid">{roles.map((role,i)=><ControlButton key={role.roleId} className="th k-private live" onClick={()=>{choose(role.roleId);setOverview(false);}}><span className="th-top"><span className="th-no">第 {i+1} 页</span></span><span className="th-pic"><img src={clerk} alt="角色示意插画"/></span><span className="th-nm">{role.displayName}</span><span className="th-foot"><span className="th-stamp">{role.status === 'ready'?'已就绪':'待处理'}</span></span></ControlButton>)}</div></section></div>
          </section> : <div className="spread"><article className="leaf left">
            <header className="lh"><p className="kicker">{night ? '角色电台' : '这一页 · 角色'}</p><h1>{current?.displayName || '关系手账'}</h1><p className="meta">{current ? (current.status === 'ready' ? '角色资料已连接' : current.initError || '角色尚未就绪') : '还没有角色'}</p></header>
            <div className="who"><figure className="portrait"><span className="tape"/><span className="ph"><img src={clerk} alt="装饰性角色示意插画"/></span><span className="rim"/><span className="mic"><Icon name="radio"/></span></figure>
              <div className="who-txt"><p className="k">{night ? '本台主持人' : '贴在页首的人'}</p><p className="role-n">{current?.displayName || '还没请人来'}</p><p className="role-s">{detail ? `角色设定 · 第 ${detail.definitionRevision} 版` : '创建角色后，可以在这里维护她的资料。'}</p><div className="row"><Button className="wj-action entry" disabled={!detail || busy} onClick={edit}>编辑资料</Button></div></div></div>
            <section className="brief"><p className="k">她的近况</p><p>{status || '暂时没有近况记录'}</p></section>
            <section className="brief"><p className="k">{night?'手边接入的设备':'这一页带着'}</p><div className="b-ok">{bindings.length ? bindings.map(binding => <ControlButton key={binding.capability+binding.resourceId} className="b-chip" onClick={() => setSelectedBinding(binding)}>{resources.find(resource=>resource.resourceId===binding.resourceId)?.name || '资源'}{!binding.enabled?' · 已停用':''}</ControlButton>) : <span className="cap">{capabilityError || '暂时没有绑定能力'}</span>}</div></section>
          </article><div className="gutter" aria-hidden="true"/><article className="leaf right">
            <header className="rh"><div><p className="kicker">{night?'接入调音台的设备':'带着什么本事'}</p><h2>{night?'本台推子':'贴在这一页的贴纸'}</h2></div><p className="sum"><b>{bindings.filter(binding=>binding.enabled).length}</b> 项已启用</p></header>
            <p className="legend">{xray?'显示角色绑定和资源本身的状态。':'查看当前角色绑定的模型、MCP 与 Skill。'}</p>
            <div className="cells">{bindings.map(binding=>{const resource=resources.find(item=>item.resourceId===binding.resourceId); const enabled=binding.enabled && resource?.enabled;return <div key={binding.capability+binding.resourceId} className={'cell ty-skill m-'+(enabled?'ink':'peeled')}><ControlButton className="face" onClick={()=>setSelectedBinding(binding)}><span className="glyph"><Icon name="activity"/></span><span className="ct"><b className="nm">{resource?.name || '资源不可用'}</b><span className="tag">{binding.capability}</span><span className="how">{binding.enabled?'角色已启用':'角色已停用'}</span><span className="under">{resource?.enabled?'资源已启用':'资源已停用或不可用'}</span></span><span className="led"/><span className="fader"><i className="knob"/></span><span className="okmark"/></ControlButton>{xray&&<ol className="strata" aria-label="能力状态"><li className="st win"><span className="sl">角色绑定</span><span className="sv">{binding.enabled?'开启':'关闭'}</span></li><li className="st"><span className="sl">资源</span><span className="sv">{resource?.enabled?'开启':'关闭'}</span></li></ol>}</div>})}{!bindings.length&&<p className="cap">{capabilityError || '当前角色还没有绑定能力。'}</p>}</div>
            <footer className="rf"><span className="cap">{draft ? '资料有未保存的修改' : detail ? '与已读取资料一致' : ''}</span><Button className="wj-action commit" disabled={!detail || busy} onClick={edit}>编辑资料</Button></footer>
          </article></div>}<span className="ribbon" aria-hidden="true"/>
        </section>
      </div>
      <div className="wj-bottom"><ControlButton className="link" onClick={() => { setMessage(''); setCreating(true); }}>＋ 添加角色</ControlButton><span className="cap">角色示意插画 · 页签仅用于选择角色</span></div>
    </div>
    <Modal open={editing} title="编辑角色资料" onClose={() => setEditing(false)} closeDisabled={busy}>
      {draft && <><Field label="名字"><Input value={draft.name} maxLength={200} onChange={e=>setDrafts(previous=>({...previous,[currentId]:{...draft,name:e.target.value}}))}/></Field>
      <Field label="角色设定"><Textarea rows={8} value={draft.definition} onChange={e=>setDrafts(previous=>({...previous,[currentId]:{...draft,definition:e.target.value}}))}/></Field>
      {message && <p role="alert">{message}</p>}<Button disabled={busy || !draft.name.trim() || !draft.definition.trim()} onClick={() => void save()}>保存修改</Button></>}
    </Modal>
    <Modal open={creating} title="添加角色" onClose={() => setCreating(false)} closeDisabled={busy}>
      <Field label="名字"><Input value={name} maxLength={200} onChange={e=>setName(e.target.value)}/></Field><Field label="角色设定"><Textarea rows={8} value={definition} onChange={e=>setDefinition(e.target.value)}/></Field>
      {message && <p role="alert">{message}</p>}<Button disabled={busy || !name.trim() || !definition.trim()} onClick={() => void create()}>创建角色</Button>
    </Modal>
    <Modal open={!!selectedBinding} title="能力详情" onClose={() => setSelectedBinding(undefined)}>
      {selectedBinding && <><p>{resources.find(resource=>resource.resourceId===selectedBinding.resourceId)?.name || '资源不可用'}</p><p>角色绑定：{selectedBinding.enabled?'已启用':'已停用'}</p><p>资源状态：{resources.find(resource=>resource.resourceId===selectedBinding.resourceId)?.enabled?'已启用':'已停用或不可用'}</p>{selectedBinding.modelName&&<p>模型：{selectedBinding.modelName}</p>}</>}
    </Modal>
  </UiThemeScope>;
}
