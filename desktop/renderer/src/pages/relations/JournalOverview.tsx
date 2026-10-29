import { useState, type CSSProperties } from 'react';
import { ControlButton, Icon, Input, Select } from '../../ui';
import { useThemePreset } from '../../ui/presets';
import type { AccountSummary, SlotsResponse } from '../../types';
import { journalDraft, journalIssues, journalPages, journalResources, journalRole, journalSwitch, journalVerdict, type JournalDraft, type JournalEffective, type JournalPage, type JournalSnapshot } from '../../lib/relationship-journal';
import { homeConnection } from '../../lib/home-presentation';
import clerk from '../../assets/relationship-journal/clerk.svg';

export function JournalOverview({ snapshots, drafts, accounts, accountId, slots, effective, onGo, onClose, onAll }: {
  snapshots: Record<string, JournalSnapshot>; drafts: Record<string, JournalDraft>; accounts: AccountSummary[]; accountId: string;
  slots?: SlotsResponse; effective: Record<string, JournalEffective>; onGo: (id:string,page:JournalPage)=>void; onClose:()=>void; onAll:()=>Promise<void>;
}) {
  const {preset}=useThemePreset();
  const [all,setAll]=useState(false),[q,setQ]=useState(''),[filter,setFilter]=useState('all'),[resource,setResource]=useState('');
  const [reading,setReading]=useState('');
  const resourceId=(id:string,r:{key:string;accountPrivate?:boolean})=>(r.accountPrivate?id+'|':'')+r.key;
  const roleId=(id:string,ref:{source:string;id:string})=>(ref.source==='private'?id+'|':'')+'role:'+ref.source+':'+ref.id;
  const ids=all?accounts.map(a=>a.accountId):[accountId];
  const rows=ids.flatMap(id=>{
    const s=snapshots[id];if(!s)return [];
    const d=drafts[id]??journalDraft(s),resources=journalResources(s,d);
    return journalPages(s,d).filter(p=>p.type==='conv').map(p=>{
      const items=resources.map(r=>({r,sw:journalSwitch(s,d,p,r),issues:journalIssues(s,d,p,r,effective[id+'/'+p.key])})).filter(x=>x.sw.value==='on'||x.sw.own==='off');
      const own=items.filter(x=>x.sw.own!=='inherit').length;
      const verdict=journalVerdict(s,d,p,slots,effective[id+'/'+p.key]);
      const reasons=[...new Set([...verdict.reasons,...items.flatMap(x=>x.issues)])];
      return {id,p,d,items,own,verdict,reasons,role:journalRole(s,d,p),key:id+'/'+p.key};
    });
  });
  const matches=rows.filter(x=>{
    const search=[x.id,x.p.name,x.role?.name,x.role?.ref.id,...x.items.map(y=>y.r.name)].join(' ').toLowerCase();
    return q.trim().toLowerCase().split(/\s+/).every(w=>search.includes(w))&&(!resource||(x.role&&roleId(x.id,x.role.ref)===resource)||x.items.some(y=>resourceId(x.id,y.r)===resource&&y.sw.value==='on'));
  });
  const filters=[['all','全部'],['bad','待处理'],['own',preset==='nightwave'?'有直播':'自己写了'],['follow',preset==='nightwave'?'全转播':'全跟随'],['silent','未就绪']];
  const pass=(x:typeof rows[number],f:string)=>f==='bad'?x.reasons.length>0:f==='own'?x.own>0:f==='follow'?x.own===0:f==='silent'?!x.verdict.ok:true;
  const shown=matches.filter(x=>pass(x,filter));
  const choices=new Map<string,string>();
  rows.forEach(x=>{if(x.role)choices.set(roleId(x.id,x.role.ref),'角色卡 · '+x.role.name+(x.role.ref.source==='private'?' · QQ '+x.id:''));x.items.forEach(y=>choices.set(resourceId(x.id,y.r),(y.r.section==='plugins'?'插件 · ':'Skill · ')+y.r.name+(y.r.accountPrivate?' · QQ '+x.id:'')));});
  const read=shown.find(x=>x.key===reading)??shown[0];
  const night=preset==='nightwave';
  return <section className={'ov'+(night?' spec':'')} aria-label="关系总览">
    <header className="ov-h"><div className="ov-ti"><h1>{night?'全频扫描':'摊开全本'}<small>关系总览</small></h1></div>
      <div className="seg" role="group" aria-label="总览账号范围"><ControlButton aria-pressed={!all} onClick={()=>setAll(false)}>当前 QQ</ControlButton><ControlButton aria-pressed={all} onClick={()=>{setAll(true);void onAll();}}>全部 QQ</ControlButton></div>
      <div className="ov-q"><Icon name="search"/><Input aria-label="搜索会话或角色" placeholder="会话、QQ、角色卡…" value={q} onChange={e=>setQ(e.target.value)}/></div>
      <ControlButton className="wj-action" onClick={onClose}>回到当前页</ControlButton>
    </header>
    <div className="ov-cz"><span className="cz-k">名册 <b>{rows.length}</b> 个会话</span><span className="cap">{all&&ids.some(id=>!snapshots[id])?'部分账号尚未读取。':'状态由已读取快照计算；打开会话可核对运行条件。'}</span></div>
    <aside className="ov-rail"><div className="rl-f">{filters.map(([id,label])=><ControlButton key={id} className="fl" aria-pressed={filter===id} onClick={()=>setFilter(id!)}>{label}<b>{matches.filter(x=>pass(x,id!)).length}</b></ControlButton>)}</div>
      <label className="wj-resource-filter">查看资源用在哪里<Select aria-label="按角色卡、插件或 Skill 筛选" value={resource} onChange={e=>setResource(e.target.value)}><option value="">全部资源</option>{[...choices].map(([key,name])=><option key={key} value={key}>{name}</option>)}</Select></label>
      {night&&read?<div className="spx-read"><p className="r-k">调谐读数 · QQ {read.id}</p><p className="r-f"><b>{read.p.freq.toFixed(1)}</b><small>页签频率</small></p><h3 className="r-n">{read.p.name}</h3><p>{read.role?.name??'尚未绑定角色卡'}</p><ul className="r-why">{read.reasons.map(r=><li key={r}>{r}</li>)}</ul><ControlButton className="wj-action" onClick={()=>onGo(read.id,read.p)}>调到这台</ControlButton></div>:<p className="cap rl-tip">账号之间各记各的。资源筛选显示当前策略引用，包含未保存的修改。</p>}
    </aside>
    <div className={night?'spx-stack':'ov-wall'}>
      {!shown.length?<p className="cap">没有符合条件的会话。可回到当前页添加名册。</p>:null}
      {ids.map((id,i)=>{
        const s=snapshots[id];if(!s)return <p className="cap" key={id}>QQ {id} · 尚未读取</p>;
        const list=shown.filter(x=>x.id===id),a=accounts.find(a=>a.accountId===id),connected=homeConnection(id,slots).connected;
        if(!list.length)return null;
        return night?<section key={id} className={'spx sparse c-'+['blue','rose','sage'][i%3]+(id===accountId?' cur':'')} aria-label={'QQ '+id+' 的频谱'}>
          <header className="spx-h"><span className="ob-spine"><b>{i+1}</b><i/></span><h3>{a?.nickname??id}</h3><span className="cap">QQ {id} · {connected?'已连接':'未连接'}</span><span className="spx-st"><b>{list.length}</b> 台</span></header>
          <div className="spx-scope"><div className="spx-row">{list.map((x,j)=><ControlButton key={x.key} className={'col cv k-'+x.p.kind+(x.reasons.length?' bad':'')+(x.verdict.ok?' live':' mute')+(read?.key===x.key?' rd':'')} style={{'--i':j} as CSSProperties} onFocus={()=>setReading(x.key)} onPointerEnter={()=>setReading(x.key)} onClick={()=>onGo(id,x.p)} aria-label={x.p.name+'，'+(x.role?.name??'未绑角色')+'，'+x.reasons.join('、')}>
            <span className={'c-led'+(x.reasons.length?' on sev-2':'')}/><span className="c-bar">{x.items.map(y=><i key={y.r.key} className={'sg m-'+(y.sw.own==='on'?'ink':y.sw.own==='off'?'peeled':'carbon')+(y.issues.length?' bad':'')}/>)}{!x.items.length?<i className="sg m-floor"/>:null}</span><span className="c-axis"><b>{x.p.freq.toFixed(1)}</b></span><span className="c-fall"><i style={{'--v':x.own?1:0} as CSSProperties}/><i style={{'--v':x.own?0:1} as CSSProperties}/></span><span className="c-nm">{x.p.name}</span>
          </ControlButton>)}</div></div>
        </section>:<section key={id} className={'ov-book c-'+['blue','rose','sage'][i%3]} aria-label={'QQ '+id+' 的关系'}>
          <header className="ob-h"><span className="ob-spine"><b>{i+1}</b><i/></span><div className="ob-t"><h3>{a?.nickname??id}</h3><p className="cap">QQ {id} · {connected?'已连接':'未连接'}</p></div><p className="ob-stats"><span><b>{list.length}</b>页会话</span><span><b>{list.filter(x=>x.own).length}</b>页自己写了</span></p></header>
          {(['group','private'] as const).map(kind=><section key={kind} className="ob-kind"><header className="ok-h"><h4>{kind==='group'?'群聊':'私聊'} <small>{list.filter(x=>x.p.kind===kind).length} 页</small></h4></header><div className="ob-grid">{list.filter(x=>x.p.kind===kind).map(x=><ControlButton key={x.key} className={'th k-'+kind+(x.reasons.length?' bad':'')+(x.verdict.ok?' live':' mute')+(x.own?' own':' follow')} onClick={()=>onGo(id,x.p)}>
            <span className="th-top"><span className="th-no">第 {x.p.no} 页</span><span className="th-own">{x.own?'自己写了 '+x.own+' 处':'全跟随'}</span></span><span className={'th-pic'+(!x.role?' none':'')}>{x.role?<img src={clerk} alt="角色示意插画"/>:<Icon name="user"/>}</span><span className="th-nm">{x.p.name}</span><span className="th-who">{x.role?.name??'还没请人'}</span><span className="th-items">{x.items.slice(0,12).map(y=><i key={y.r.key} className={'it m-'+(y.sw.own==='on'?'ink':y.sw.own==='off'?'peeled':'carbon')+' ty-'+(y.r.section==='plugins'?'plugin':'skill')}/>)}</span><span className="th-foot"><span className="th-why">{x.reasons[0]??'条件已核对'}</span><span className="th-stamp">{x.verdict.ok?'可回复':'待处理'}</span></span>
          </ControlButton>)}</div></section>)}
        </section>;
      })}
    </div>
  </section>;
}
