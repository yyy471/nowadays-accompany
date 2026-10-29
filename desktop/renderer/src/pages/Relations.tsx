import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent } from 'react';
import { AccountsPage } from './Accounts';
import { ExtensionsPage } from './Extensions';
import { Button, ControlButton, Empty, ErrorNote, Field, Icon, Input, LoadingNote, Modal, Select, UiThemeScope, useConfirm, useMotionPolicy } from '../ui';
import { useThemePreset, useThemeTransitionStrategy } from '../ui/presets';
import { relationshipJournalThemeTransition } from '../ui/relationship-journal-transition';
import { useDraftProtection } from '../components/DraftProtectionProvider';
import type { ArtifactItem, ArtifactRef, SlotsResponse } from '../types';
import { homeConnection } from '../lib/home-presentation';
import { switchOriginLabel } from '../lib/extensions-policy';
import { journalChain, journalIssues, journalReply, journalResources, journalRole, journalSwitch, journalVerdict, type JournalResource } from '../lib/relationship-journal';
import { layoutJournalTabs } from '../lib/relationship-journal-layout';
import { useJournal } from './relations/use-journal';
import { JournalOverview } from './relations/JournalOverview';
import clerk from '../assets/relationship-journal/clerk.svg';
import host from '../assets/relationship-journal/host.svg';
import post from '../assets/relationship-journal/post.svg';
import keeper from '../assets/relationship-journal/keeper.svg';
import garden from '../assets/relationship-journal/garden.svg';
import announcer from '../assets/relationship-journal/announcer.svg';
import '../ui/relationship-journal.css';
import '../ui/relationship-journal-integration.css';
import '../ui/relationship-journal-transition.css';

type Props=ComponentProps<typeof AccountsPage>&{slots?:SlotsResponse;slotsError?:string};
const portraits=[clerk,host,post,keeper,garden,announcer];
const noArtifacts:ArtifactItem[]=[];
const noCurrent:Record<string,string>={};
function look(id:string){return portraits[[...id].reduce((n,c)=>n+c.charCodeAt(0),0)%portraits.length];}
function Twin({day,night}:{day:string;night:string}){return <span className="tl"><span className="d">{day}</span><span className="n">{night}</span></span>;}
const frequency=(n:number)=>((n-87)/21*100)+'%';
function JournalLayers({chain,source,value,open}:{chain:ReturnType<typeof journalChain>;source:string;value:'on'|'off';open:boolean}){
  const winner=source==='account'?0:source==='kind'?1:source==='conversation'?2:-1;
  return <ol className="strata" aria-hidden={!open}>{chain.map((l,i)=><li key={l.label} style={{'--i':i} as CSSProperties} className={'st v-'+l.own+(i===winner?' win':l.own==='inherit'?' pass':'')}><span className="sl">{l.label}</span><span className="sv">{l.own==='on'?'开':l.own==='off'?'关':'跟随'}</span><span className="sb">{i===winner?'当前来源':l.own==='inherit'?'跟随 ↑':'被覆盖'}</span></li>)}{source==='default'?<li className="st win" style={{'--i':chain.length} as CSSProperties}><span className="sl">定义默认</span><span className="sv">{value==='on'?'开':'关'}</span><span className="sb">当前来源</span></li>:null}</ol>;
}

/** 原版 HTML 的 DOM / 材质迁入 React；身份、草稿与持久化交给现有控制面。 */
export function RelationsPage(props:Props){
  const {preset}=useThemePreset(),motion=useMotionPolicy(),confirm=useConfirm();
  useThemeTransitionStrategy(relationshipJournalThemeTransition);
  const {requestTransition}=useDraftProtection();
  const accounts=props.accounts?.accounts??[];
  const j=useJournal(accounts.map(a=>a.accountId),props.artifacts?.artifacts??noArtifacts,!!props.locked,props.artifacts?.current??noCurrent);
  const [overview,setOverview]=useState(false),[xray,setXray]=useState(false),[sheet,setSheet]=useState(false),[index,setIndex]=useState(false);
  const [dense,setDense]=useState(false);
  const [details,setDetails]=useState(false),[extensionEditor,setExtensionEditor]=useState(false),[rolePicker,setRolePicker]=useState(false),[adding,setAdding]=useState(false);
  const [selectedResource,setSelectedResource]=useState<string>(),[roleChoice,setRoleChoice]=useState(''),[addKind,setAddKind]=useState<'group'|'private'>('group'),[peer,setPeer]=useState(''),[addError,setAddError]=useState<string>();
  const root=useRef<HTMLDivElement>(null),strip=useRef<HTMLElement>(null),needle=useRef<HTMLElement>(null);
  const disabled=!!props.locked||!!j.busy||!!j.unknown||j.loading;
  const s=j.snapshot,d=j.draft,p=j.page;
  const a=accounts.find(a=>a.accountId===j.accountId);
  const connectionSlots=props.slotsError?undefined:props.slots;
  const resources=s&&d?journalResources(s,d):[];
  const ef=p?j.effective[j.accountId+'/'+p.key]:undefined;
  const role=s&&d&&p?journalRole(s,d,p):undefined;
  const verdict=s&&d&&p?journalVerdict(s,d,p,connectionSlots,ef):undefined;
  const items=s&&d&&p?resources.map(r=>({r,sw:journalSwitch(s,d,p,r),issues:journalIssues(s,d,p,r,ef)})):[];
  const visible=items.filter(x=>x.sw.value==='on'||x.sw.own==='off');
  const resource=resources.find(r=>r.key===selectedResource);
  const roleCards=(s?.artifacts??[]).filter(x=>x.manifest.kind==='role-card');
  const roleNames=new Map<string,string>();roleCards.forEach(x=>roleNames.set(x.ref.source+':'+x.ref.id,x.manifest.name??x.ref.id));
  useEffect(()=>{if(props.focusDisplay||props.focusBinding)setDetails(true);},[props.focusDisplay,props.focusBinding]);
  // 按当前 strip 和页签真实尺寸排布；极密集时把余下会话留在完整名册中。
  useLayoutEffect(()=>{
    const el=strip.current;if(!el)return;
    const tabs=[...el.querySelectorAll<HTMLButtonElement>('.stn')];
    const reset=()=>tabs.forEach(tab=>{
      tab.style.translate='';
      tab.style.removeProperty('--wj-tab-width');
      delete tab.dataset.wjPacked;
      delete tab.dataset.wjLayoutHidden;
    });
    const fan=()=>{
      reset();
      const width=el.clientWidth;
      const isDense=j.pages.length>12||j.pages.length*78>width;
      setDense(isDense);
      if(!width||!tabs.length)return;
      const activeIndex=Math.max(0,j.pages.findIndex(page=>page.key===p?.key));
      const structural=j.pages.map((page,index)=>page.type==='account'||page.type==='kind'?index:-1).filter(index=>index>=0);
      const layout=layoutJournalTabs({
        stripWidth:width,
        centers:tabs.map(tab=>width*parseFloat(tab.style.left)/100),
        widths:tabs.map(tab=>tab.offsetWidth),
        minWidths:tabs.map((tab,index)=>tab.classList.contains('t-account')||tab.classList.contains('t-kind')
          ? index===activeIndex?54:44
          : index===activeIndex?56:12),
        activeIndex,
        priorityIndices:structural,
        gap:4
      });
      layout.placements.forEach(placement=>{
        const tab=tabs[placement.index];if(!tab)return;
        if(placement.hidden)tab.dataset.wjLayoutHidden='';
        if(Math.abs(placement.width-tab.offsetWidth)>.5){
          tab.dataset.wjPacked='';
          tab.style.setProperty('--wj-tab-width',`${placement.width}px`);
        }
        const originalCenter=width*parseFloat(tab.style.left)/100;
        tab.style.translate=`${placement.center-originalCenter}px 0`;
      });
      if(needle.current)needle.current.style.left=`${layout.needleCenter}px`;
    };
    const observer=new ResizeObserver(fan);observer.observe(el);fan();
    return()=>{observer.disconnect();reset();if(needle.current)needle.current.style.left='';};
  },[j.accountId,j.pages.length,p?.key,preset,dense]);
  // 页签采用 roving tabindex；聚焦和滚动只跟随用户导航，切主题不触发。
  const tabKey=(e:KeyboardEvent<HTMLButtonElement>,i:number)=>{
    if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;
    const next=e.key==='ArrowRight'?i+1:e.key==='ArrowLeft'?i-1:e.key==='Home'?0:j.pages.length-1;
    e.preventDefault();const n=(next+j.pages.length)%j.pages.length;j.choosePage(j.pages[n]!.key);
    requestAnimationFrame(()=>strip.current?.querySelector<HTMLButtonElement>('.stn.cur')?.focus());
  };
  const openEditor=async(which:'details'|'extensions')=>{
    const result=await requestTransition({scope:{kind:'ids',ids:['relationship-journal']},actionLabel:which==='details'?'打开资料与世界书':'打开插件与授权管理'});
    if(result.ok){if(which==='details')setDetails(true);else setExtensionEditor(true);}
  };
  const closeEditor=async()=>{
    const result=await requestTransition({scope:{kind:'page'},actionLabel:'关闭详细管理'});
    if(result.ok){setDetails(false);setExtensionEditor(false);await j.reload();}
  };
  const clearRole=async()=>{if(disabled||!role)return;if(await confirm({title:'移除本会话角色卡',description:'保存后该会话停止自动回复。角色卡与会话不会从资源库中删除。',confirmLabel:'记入解除草稿',cancelLabel:'保留角色',tone:'danger'}))j.bind(null);};
  const openRole=()=>{setRoleChoice(role?JSON.stringify(role.ref):'');setRolePicker(true);};
  const editingResource=(r:JournalResource)=>{setSelectedResource(r.key);setSheet(true);};
  if(props.accountsLoading&&!props.accounts)return <LoadingNote label="正在读取 QQ 账号…"/>;
  if(props.accountsError&&!props.accounts)return <ErrorNote message={props.accountsError} onRetry={()=>void props.refresh()}/>;
  if(!accounts.length)return <Empty title="还没有 QQ 账号" description="先在接入管理中连接账号，再为它建立会话名册。" action={<Button onClick={props.onGoSlots}>打开接入管理</Button>}/>;
  return <UiThemeScope theme="xiacheng" preset={preset} motion={motion.reduced?'reduced':'full'} className="wj-journal">
    <div ref={root} className="wj-body" aria-busy={j.loading||!!j.busy}>
      {(props.accountsError||props.artifactsError||props.slotsError||j.error||j.notice)?<div className={'wj-notice'+(j.error?' error':'')} role={j.error?'alert':'status'}><span>{j.error??props.accountsError??props.artifactsError??props.slotsError??j.notice}</span>{j.unknown?<Button size="sm" disabled={!!j.busy||props.locked} onClick={()=>void j.verify()}>核对保存结果</Button>:<ControlButton onClick={()=>void j.reload()} disabled={!!j.busy||props.locked}>重新读取</ControlButton>}</div>:null}
      <div className="stage">
        <section className="shelf" aria-label="选择当前 QQ 账号"><div className="shelf-row">{accounts.map((account,i)=>{const connection=homeConnection(account.accountId,connectionSlots);return <ControlButton key={account.accountId} className={'spine c-'+['blue','rose','sage'][i%3]+' st-'+(connection.connected?'online':'offline')+(j.accountId===account.accountId?' cur':'')} aria-pressed={j.accountId===account.accountId} title={(account.nickname??account.accountId)+' · QQ '+account.accountId+' · '+connection.label} aria-label={'切换 QQ '+account.accountId} disabled={!!j.busy||props.locked} onClick={()=>void j.chooseAccount(account.accountId)}><span className="sp-top"><span className="led"/><b>{String.fromCharCode(65+i%26)}</b></span><span className="sp-name">{account.nickname??account.accountId}</span><span className="sp-grille"/><span className="sp-band">{connection.connected?'在线':'未连'}</span></ControlButton>;})}</div><div className="shelf-plank"/><p className="shelf-cap">{a?.nickname??'当前账号'} · <span className="mono">QQ {j.accountId}</span></p></section>
        <nav ref={strip} className={'strip'+(dense?' dense':'')} aria-label="会话页签与分类"><div className="glass"/><div className="ticks" aria-hidden="true">{Array.from({length:41},(_,i)=>87.5+i*.5).map(f=><span key={f}><i className={'tk'+(f%2===0?' maj':'')} style={{left:frequency(f)}}/>{f%2===0?<span className="fq" style={{left:frequency(f)}}>{f}</span>:null}</span>)}</div><div className="stations">{j.pages.map((page,i)=><ControlButton key={page.key} className={'stn t-'+page.type+' k-'+(page.kind??'acc')+(p?.key===page.key?' cur':'')+(dense&&page.type==='conv'&&p?.key!==page.key?' mini':'')} style={{left:frequency(page.freq)}} title={page.name} tabIndex={p?.key===page.key?0:-1} aria-current={p?.key===page.key?'page':undefined} aria-label={page.name+'，第 '+page.no+' 页'} disabled={!!j.busy||props.locked} onKeyDown={e=>tabKey(e,i)} onClick={()=>j.choosePage(page.key)}><span className="no"><Twin day={String(page.no)} night={page.freq.toFixed(1)}/></span><span className="nm">{page.name}</span><i className="dot"/>{dense&&page.type==='conv'?<span className="pop" aria-hidden="true"><b>{page.no}</b> {page.name}</span>:null}</ControlButton>)}</div>{p?<i ref={needle} className="needle" style={{left:frequency(p.freq)}}/>:null}<span className="edge"/></nav>
        <div className="tools" role="toolbar" aria-label="关系视图"><ControlButton className="tool ov-tool" aria-pressed={overview} onClick={()=>setOverview(v=>!v)}><span className="ov-ico" aria-hidden="true"><i/><i/><i/><i/><i/><i/></span><span><Twin day="摊开全本" night="全频扫描"/><small>关系总览 · 全部会话</small></span></ControlButton><ControlButton className="tool" aria-pressed={xray} onClick={()=>setXray(v=>!v)}><Icon name="overview"/><span><Twin day="掀开透光" night="信号来路"/><small>查看继承层级</small></span></ControlButton></div>
        <section className={'book cover-'+['blue','rose','sage'][Math.max(0,accounts.findIndex(x=>x.accountId===j.accountId))%3]+(xray?' xray':'')} aria-label="当前关系页">
          {overview?<JournalOverview accounts={accounts} accountId={j.accountId} snapshots={j.snapshots} drafts={j.drafts} effective={j.effective} slots={connectionSlots} onClose={()=>setOverview(false)} onAll={j.prefetch} onGo={(id,page)=>{void(async()=>{if(await j.chooseAccount(id)){j.choosePage(page.key,id);setOverview(false);}})();}}/>:s&&d&&p?<>
            <div className="spread"><article className="leaf left" aria-label="身份与回复条件"><header className="lh"><p className="kicker"><Twin day={'第 '+p.no+' 页 · '+(p.type==='account'?'扉页':p.type==='kind'?'分类页':p.kind==='group'?'群聊':'私聊')} night={p.freq.toFixed(1)+' · '+(p.type==='account'?'总台':p.type==='kind'?'分台':'会话电台')}/></p><h1>{p.name}</h1><p className="meta">{a?.nickname??j.accountId} · QQ <span className="mono">{j.accountId}</span> · {homeConnection(j.accountId,connectionSlots).label}</p></header>
              {p.type==='conv'?<><div className="who"><figure className={'portrait'+(!role?' empty':'')}><span className="tape"/>{role?<><span className="ph"><img src={look(role.ref.id)} alt="装饰性角色示意插画，非角色卡头像"/></span><span className="rim"/><span className="mic"><Icon name="radio"/></span></>:<span className="ph-empty"><Icon name="user" size={32}/><b><Twin day="还没请人来" night="空麦克风"/></b><small>本会话尚未绑定角色</small></span>}</figure><div className="who-txt"><p className="k"><Twin day="贴在页首的人" night="本台主持人"/></p><p className={'role-n'+(!role?' none':'')}>{role?.name??'没有角色卡'}</p><p className="role-s">{role?<><span className={'src s-'+role.ref.source}>{role.ref.source==='public'?'公共角色卡':'账号私有角色卡'}</span><br/><span className="mono">{role.ref.revision?'固定版本':'跟随当前版本'} · {role.revision?.slice(0,12)??'待核对'}</span></>:'角色逐个会话显式绑定，不从上层继承。'}</p><div className="row"><Button className="wj-action entry" disabled={disabled} onClick={openRole}>{role?'换一位':'请一位角色'}</Button>{role?<Button className="wj-action ghost" disabled={disabled} onClick={()=>void clearRole()}>请走</Button>:null}</div>{Object.hasOwn(d.roles,p.key)?<p className="cap">本页角色修改尚未保存</p>:null}</div></div>
              <section className="brief"><p className="k"><Twin day="这一页带着" night="手边接入的设备"/></p><div className="b-ok">{visible.filter(x=>x.sw.value==='on').slice(0,8).map(x=><ControlButton key={x.r.key} className="b-chip" onClick={()=>editingResource(x.r)}>{x.r.name}{x.issues.length?' · 待处理':''}</ControlButton>)}{!visible.some(x=>x.sw.value==='on')?<span className="cap">暂时没有启用的插件或 Skill</span>:null}</div></section>
              <div className={'verdict '+(verdict?.ok?'ok':'no')} role="status"><div className="stamp"><span className="lamp"/><b>{verdict?.ok?'可回复':'待就绪'}</b><small>{verdict?.ok?'READY':'OFF AIR'}</small></div><p>{verdict?.ok?'角色、QQ、回复策略与对话模型条件已核对。':verdict?.reasons.join('；')}<br/>{Object.hasOwn(d.roles,p.key)?'以上含角色草稿；保存后生效。':''}</p></div></>:<><p className="explain"><Twin day={p.type==='account'?'写在扉页上的，会复写到后面每一页；哪一页自己写了，就以那一页的实墨为准。':'这一页继承账号通用设置，并传给后面的同类会话；单个会话可以继续覆盖。'} night={p.type==='account'?'总台的设置转播到群聊分台、私聊分台和每个会话电台；每个电台也可以自行覆盖。':'分台承接总台的信号，再传给同类会话电台；每个电台可以自行直播。'}/></p><figure className="portrait empty barred"><span className="ph-empty"><Icon name="user" size={32}/><b>这里不请人</b><small>角色卡逐个会话绑定，不设默认角色</small></span></figure><p className="pages-note">后面的页：{j.pages.filter(q=>q.type==='conv'&&(p.type==='account'||q.kind===p.kind)).slice(0,10).map(q=><ControlButton key={q.key} className="link" onClick={()=>j.choosePage(q.key)}>{q.name}</ControlButton>)}</p></>}
              <div className="wj-left-actions"><Button className="wj-action compact" disabled={disabled} onClick={()=>void j.setReply(!journalReply(s,p))}>{journalReply(s,p)?'暂停此范围回复':'开启此范围回复'}</Button><span className="cap">回复开关立即保存</span><ControlButton className="link" disabled={!!j.busy||props.locked} onClick={()=>void openEditor('details')}>资料与世界书</ControlButton></div>
            </article><div className="gutter" aria-hidden="true"/><article className="leaf right" aria-label="插件和 Skill 策略"><header className="rh"><div><p className="kicker"><Twin day="带着什么本事" night="接入调音台的设备"/></p><h2><Twin day="贴在这一页的贴纸" night="本台推子"/></h2></div><p className="sum"><b>{visible.filter(x=>x.sw.value==='on').length}</b> 项开启 · {visible.filter(x=>x.issues.length).length} 项待处理</p></header><p className="legend"><Twin day="实墨＝本页设置　复写印＝继承　红笔＝尚不可用" night="ON AIR＝本台设置　转播＝继承　故障灯＝尚不可用"/></p>
              <div className="cells">{visible.map(x=><div key={x.r.key} className={'cell ty-'+(x.r.section==='plugins'?'plugin':'skill')+' m-'+(x.sw.own==='on'?'ink':x.sw.own==='off'?'peeled':'carbon')+(x.issues.length?' bad':'')}><ControlButton className="face" onClick={()=>editingResource(x.r)} aria-label={x.r.name+'，'+(x.sw.value==='on'?'开启':'关闭')+'，'+switchOriginLabel(x.sw.source)}><span className="glyph"><Icon name={x.r.section==='plugins'?'artifacts':'activity'}/></span><span className="ct"><b className="nm">{x.r.name}</b><span className="tag">{x.r.section==='plugins'?'插件':'Skill'}</span><span className={'src s-'+(x.r.source.includes('私有')?'private':'public')}>{x.r.source}</span><span className="how">{x.sw.own==='inherit'?'继承 · '+switchOriginLabel(x.sw.source):x.sw.own==='on'?'本页开启':'本页关闭'}</span><span className="under">{xray?journalChain(s,d,p,x.r).map(l=>l.label+' '+(l.own==='inherit'?'跟随':l.value==='on'?'开':'关')).join(' → '):(x.issues[0]??(x.sw.value==='on'?'策略已开启':'在本页暂停使用'))}</span></span><span className="led" aria-hidden="true"/><span className="fader" aria-hidden="true"><i className="knob"/></span><span className="okmark" aria-hidden="true"/></ControlButton><JournalLayers chain={journalChain(s,d,p,x.r)} source={x.sw.source} value={x.sw.value} open={xray}/>{x.issues.length?<svg className="loop" viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M14 40C4 24 30 7 98 5c62-2 98 8 96 26-2 19-44 27-100 27C40 58 6 50 7 33 8 21 26 12 58 9"/></svg>:null}</div>)}<ControlButton className="wj-add-cell" onClick={()=>{setSelectedResource(undefined);setSheet(true);}}><Icon name="plus"/><span><Twin day="从封底选一张" night="接入一台设备"/></span></ControlButton></div>
              <footer className="rf"><ControlButton className="wj-action sheet-wj-action" aria-expanded={sheet} onClick={()=>{setSelectedResource(undefined);setSheet(true);}}><Twin day="封底贴纸" night="设备架"/><span className="cnt">{resources.length}</span></ControlButton><div className="draft"><span className="cap">{j.busy?'提交中…':j.extensionDirty||j.roleDirty?'有改动尚未落款':'与已读取配置一致'}</span>{j.roleDirty?<Button className="wj-action commit" disabled={disabled} onClick={()=>void j.saveRoles()}>保存角色</Button>:null}<Button className="wj-action commit" disabled={disabled||!j.extensionDirty} onClick={()=>void j.saveExtensions()}>保存能力</Button></div></footer>
            </article></div><span className="ribbon" aria-hidden="true"/>
          </>:<div className="wj-state">{j.loading?<LoadingNote label="正在读取本账号的关系设置…"/>:<ErrorNote message={j.error??'关系数据暂不可用'} onRetry={()=>void j.reload()}/>}</div>}
        </section>
      </div>
      <div className="wj-bottom"><ControlButton className="link" onClick={()=>setIndex(true)}>会话名册 · {j.pages.filter(p=>p.type==='conv').length}</ControlButton><ControlButton className="link" disabled={disabled} onClick={()=>{setPeer('');setAddError(undefined);setAdding(true);}}>＋ 加入群聊／私聊</ControlButton><ControlButton className="link" disabled={!!j.busy||props.locked} onClick={()=>void openEditor('extensions')}>插件、工具授权与 Skill 管理</ControlButton><span className="cap">角色示意插画 · 频率仅为页签编号</span></div>
    </div>
    <Modal open={sheet} title={resource?resource.name:preset==='nightwave'?'设备架':'封底贴纸'} onClose={()=>setSheet(false)} className="wj-modal"><p>当前范围：QQ {j.accountId} · {p?.name}。选择只修改这一层，保存能力后生效。</p>{resource&&s&&d&&p?<><p>{resource.source} · {resource.section==='plugins'?'插件':'Skill'}</p><Field label="本层设置"><Select disabled={disabled} value={journalSwitch(s,d,p,resource).own} onChange={e=>j.edit(resource,e.target.value as 'on'|'off'|'inherit')}><option value="inherit">继承上层（账号通用时使用默认值）</option><option value="on">本层开启</option><option value="off">本层关闭</option></Select></Field><ol>{journalChain(s,d,p,resource).map(l=><li key={l.label}>{l.label}：{l.own==='inherit'?'继承':l.own==='on'?'开启':'关闭'} → {l.value==='on'?'开':'关'}</li>)}</ol><p>当前结果：{journalSwitch(s,d,p,resource).value==='on'?'开启':'关闭'} · {switchOriginLabel(journalSwitch(s,d,p,resource).source)}</p>{journalIssues(s,d,p,resource,ef).map(reason=><p className="wj-issue" key={reason}>{reason}</p>)}<Button onClick={()=>setSelectedResource(undefined)}>返回全部资源</Button></>:<div className="wj-picker-list">{resources.map(r=><ControlButton key={r.key} className="wj-picker-row" onClick={()=>setSelectedResource(r.key)}><Icon name={r.section==='plugins'?'artifacts':'activity'}/><span><b>{r.name}</b><small>{r.source} · {r.section==='plugins'?'插件':'Skill'}</small></span></ControlButton>)}{!resources.length?<p>没有可用资源，请先在插件与 Skill 管理中安装或创建。</p>:null}</div>}</Modal>
    <Modal open={rolePicker} title="请一位角色" description="角色仅绑定当前会话。选择后先记为草稿，再保存角色。" onClose={()=>setRolePicker(false)} className="wj-modal"><Field label="角色卡与版本"><Select value={roleChoice} onChange={e=>setRoleChoice(e.target.value)} disabled={disabled}><option value="">请选择角色卡</option>{[...roleNames].map(([key,name])=>{const [source,id]=key.split(':');return <option key={'follow:'+key} value={JSON.stringify({source,id})}>{name} · {source==='public'?'公共':'私有'} · 跟随当前版本</option>;})}{roleCards.map(c=><option key={JSON.stringify(c.ref)} value={JSON.stringify(c.ref)}>{c.manifest.name??c.ref.id} · 固定 {c.ref.revision.slice(0,12)}</option>)}</Select></Field><Button disabled={disabled||!roleChoice} onClick={()=>{j.bind(JSON.parse(roleChoice) as ArtifactRef);setRolePicker(false);}}>记入本页</Button><Button onClick={props.onGoArtifacts}>管理角色卡资源</Button></Modal>
    <Modal open={index} title="会话名册" onClose={()=>setIndex(false)} className="wj-modal"><p>这里只列已明确配置的会话；历史记录不会自动加入。</p><div className="wj-picker-list">{j.pages.map(page=><ControlButton className="wj-picker-row" key={page.key} onClick={()=>{j.choosePage(page.key);setOverview(false);setIndex(false);}}><span>第 {page.no} 页</span><b>{page.name}</b></ControlButton>)}</div></Modal>
    <Modal open={adding} title="加入会话名册" description="加入时自动回复保持暂停；随后为这个会话绑定角色并设置策略。" onClose={()=>setAdding(false)} closeDisabled={!!j.busy} className="wj-modal"><Field label="会话类型"><Select value={addKind} disabled={disabled} onChange={e=>setAddKind(e.target.value as 'group'|'private')}><option value="group">群聊</option><option value="private">私聊</option></Select></Field><Field label={addKind==='group'?'群号':'对方 QQ 号'} error={addError}><Input value={peer} disabled={disabled} maxLength={64} onChange={e=>setPeer(e.target.value.trim())}/></Field>{s?.candidates.length?<Field label="或从本账号已见会话中选择"><Select value="" onChange={e=>{const [kind,id]=e.target.value.split('/');if(kind&&id){setAddKind(kind as 'group'|'private');setPeer(id);}}}><option value="">请选择已见会话</option>{s.candidates.map(c=><option key={c.kind+'/'+c.peerId} value={c.kind+'/'+c.peerId}>{c.kind==='group'?'群聊':'私聊'} {c.peerId}</option>)}</Select></Field>:null}<Button disabled={disabled||!peer} busy={j.busy==='reply'} onClick={()=>{void j.add(addKind,peer).then(()=>setAdding(false)).catch(e=>setAddError(String(e.message)));}}>加入并暂停回复</Button></Modal>
    <Modal open={details} title="账号资料、角色绑定与世界书" onClose={()=>void closeEditor()} closeDisabled={props.locked} className="wj-legacy-modal"><AccountsPage {...props} accounts={props.accounts?{...props.accounts,accounts:accounts.filter(x=>x.accountId===(props.focusDisplay?.accountId??props.focusBinding?.accountId??j.accountId))}:undefined}/></Modal>
    <Modal open={extensionEditor} title={'QQ '+j.accountId+' · 插件、授权与 Skill'} onClose={()=>void closeEditor()} closeDisabled={props.locked} className="wj-legacy-modal"><ExtensionsPage {...props} accounts={props.accounts?{...props.accounts,accounts:accounts.filter(x=>x.accountId===j.accountId)}:undefined}/></Modal>
  </UiThemeScope>;
}
