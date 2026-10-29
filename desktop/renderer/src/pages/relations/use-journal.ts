import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { errorMessage } from '../../hooks';
import type { AccountPolicyResponse, ArtifactItem, ArtifactRef, ConversationsResponse, EffectiveResponse, ExtensionEffectiveResponse, ExtensionsResponse } from '../../types';
import { buildPolicyPatch, catalogKeys, draftFromPolicy, policyDraftDirty, setScopeSwitch } from '../../lib/extensions-policy';
import { journalDraft, journalPages, journalPolicyEqual, journalReply, journalScope, journalSnapshotKey, type JournalSnapshot, type JournalDraft, type JournalBinding, type JournalPage, type JournalResource, type JournalEffective } from '../../lib/relationship-journal';
import { useDraftRegistration } from '../../lib/use-draft-registration';
import { hashRevision } from '../../lib/drafts/registry';
import { useDraftProtection } from '../../components/DraftProtectionProvider';

async function readSnapshot(accountId:string,publicItems:ArtifactItem[],catalogCurrent:Record<string,string>):Promise<JournalSnapshot>{
  const base='/accounts/'+encodeURIComponent(accountId);
  const [bindings,artifacts,extensions,policy,candidates]=await Promise.all([
    api<{bindings:JournalBinding[]}>(base+'/role-bindings'),api<{artifacts:ArtifactItem[]}>(base+'/artifacts'),api<ExtensionsResponse>(base+'/extensions'),api<AccountPolicyResponse>(base+'/policy'),
    api<ConversationsResponse>('/conversations?accountId='+encodeURIComponent(accountId)).catch(()=>({ok:true as const,conversations:[]}))
  ]);
  return {accountId,readAt:performance.now(),current:catalogCurrent,bindings:bindings.bindings.filter(b=>b.accountId===accountId),artifacts:[...publicItems,...artifacts.artifacts],extensions:extensions.extensions,policy:policy.policy,candidates:candidates.conversations.filter(c=>c.accountId===accountId)};
}
function roleEqual(a:ArtifactRef|null|undefined,b:ArtifactRef|null|undefined):boolean{return JSON.stringify(a??null)===JSON.stringify(b??null);}

const noCurrent:Record<string,string>={};
export function useJournal(accountIds:string[],publicItems:ArtifactItem[],locked:boolean,catalogCurrent=noCurrent){
  const {requestTransition}=useDraftProtection();
  const [accountId,setAccountId]=useState(accountIds[0]??'');
  const [snapshots,setSnapshots]=useState<Record<string,JournalSnapshot>>({});
  const [drafts,setDrafts]=useState<Record<string,JournalDraft>>({});
  const [selection,setSelection]=useState<Record<string,string>>({});
  const [effective,setEffective]=useState<Record<string,JournalEffective>>({});
  const [loading,setLoading]=useState(false),[busy,setBusy]=useState<string>(),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>();
  const [unknown,setUnknown]=useState<{accountId:string;kind:'extensions'|'roles'|'reply';draft:JournalDraft;target?:JournalPage;enabled?:boolean}>();
  const alive=useRef(true),request=useRef(0),lock=useRef(locked),active=useRef(accountId),saving=useRef(false);
  lock.current=locked;active.current=accountId;
  const current=useRef({snapshots,drafts,unknown});current.current={snapshots,drafts,unknown};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current++;};},[]);
  useEffect(()=>{if(!accountIds.includes(accountId))setAccountId(accountIds[0]??'');},[accountIds.join('|'),accountId]);
  const snapshot=snapshots[accountId],draft=drafts[accountId];
  const pages=snapshot?journalPages(snapshot,draft):[];
  const page=pages.find(p=>p.key===selection[accountId])??pages.find(p=>p.type==='conv')??pages[0];
  const extensionDirty=!!snapshot&&policyDraftDirty(draft?.extensions,draftFromPolicy(snapshot.extensions));
  const roleDirty=Object.keys(draft?.roles??{}).length>0;
  useDraftRegistration({id:'relationship-journal',owner:'page',accountId:accountId||undefined,label:unknown?'关系页：保存结果待核对':'关系页的角色与能力设置',dirty:Object.entries(drafts).some(([id,d])=>Object.keys(d.roles).length>0||policyDraftDirty(d.extensions,snapshots[id]?draftFromPolicy(snapshots[id]!.extensions):undefined))||!!unknown,busy:!!busy,revision:hashRevision({drafts,unknown}),discard:()=>{setDrafts(Object.fromEntries(Object.entries(current.current.snapshots).map(([id,s])=>[id,journalDraft(s)])));setUnknown(undefined);},enabled:true});
  const load=useCallback(async(id:string,reset=true)=>{
    const ticket=++request.current;
    if(!id)return;
    setLoading(true);setError(undefined);
    try{const s=await readSnapshot(id,publicItems,catalogCurrent);if(!alive.current||ticket!==request.current)return;
      setSnapshots(v=>({...v,[id]:s}));if(reset)setDrafts(v=>({...v,[id]:journalDraft(s)}));
    }catch(e){if(alive.current&&ticket===request.current)setError(errorMessage(e));}
    finally{if(alive.current&&ticket===request.current)setLoading(false);}
  },[publicItems,catalogCurrent]);
  const publicRef=useRef({items:publicItems,current:catalogCurrent});publicRef.current={items:publicItems,current:catalogCurrent};
  useEffect(()=>{if(accountId)void load(accountId);},[accountId]);
  // 公共制品刷新只补充只读清单，不覆盖已编辑的策略。
  useEffect(()=>{setSnapshots(v=>Object.fromEntries(Object.entries(v).map(([id,s])=>[id,{...s,current:catalogCurrent,artifacts:[...publicItems,...s.artifacts.filter(a=>a.ref.source==='private')]}])));},[publicItems,catalogCurrent]);
  useEffect(()=>{
    if(!snapshot||!page||page.type!=='conv')return;
    let cancelled=false;const id=accountId,key=id+'/'+page.key,snapshotKey=journalSnapshotKey(snapshot);
    const query='?kind='+page.kind+'&peerId='+encodeURIComponent(page.peerId!);
    Promise.all([api<ExtensionEffectiveResponse>('/accounts/'+encodeURIComponent(id)+'/extensions/effective'+query),api<EffectiveResponse>('/accounts/'+encodeURIComponent(id)+'/effective'+query)])
      .then(([ext,caps])=>{if(cancelled||!alive.current)return;const chat=caps.effective.capabilities.find(c=>c.capability==='chat');setEffective(v=>({...v,[key]:{snapshotKey,extensions:ext.effective,agentEnabled:caps.effective.agentEnabled,chatAvailable:chat?.enabled??false,chatReason:chat?.reason}}));})
      .catch(e=>{if(!cancelled&&alive.current)setError('运行条件读取失败：'+errorMessage(e));});
    return()=>{cancelled=true;};
  },[accountId,page?.key,snapshot?.extensions.revision,snapshot?.policy,snapshot?.bindings]);
  const chooseAccount=async(id:string)=>{if(id===active.current)return true;if(lock.current||saving.current)return false;const result=await requestTransition({scope:{kind:'ids',ids:['relationship-journal']},actionLabel:'切换 QQ 账号'});if(result.ok&&alive.current&&!lock.current){setAccountId(id);setError(undefined);setNotice(undefined);return true;}return false;};
  const choosePage=(key:string,targetAccountId=active.current)=>{if(!lock.current&&!saving.current)setSelection(v=>({...v,[targetAccountId]:key}));};
  const edit=(resource:JournalResource,value:'on'|'off'|'inherit')=>{if(!page||!snapshot||!draft||lock.current||saving.current||unknown)return;setDrafts(v=>({...v,[accountId]:{...draft,extensions:setScopeSwitch(draft.extensions,journalScope(page),resource.section,resource.id,value)}}));setNotice('修改尚未保存。');};
  const bind=(ref:ArtifactRef|null)=>{if(!page||page.type!=='conv'||!snapshot||!draft||lock.current||saving.current||unknown)return;const saved=snapshot.bindings.find(b=>b.kind===page.kind&&b.peerId===page.peerId);const roles={...draft.roles};if(roleEqual(ref,saved?.roleCard))delete roles[page.key];else roles[page.key]=ref;setDrafts(v=>({...v,[accountId]:{...draft,roles}}));};
  const saveExtensions=async()=>{
    const id=active.current,s=current.current.snapshots[id],d=current.current.drafts[id];if(!s||!d||lock.current||saving.current||current.current.unknown)return;
    saving.current=true;setBusy('extensions');setError(undefined);setNotice(undefined);
    const sent=structuredClone(d);
    try{const r=await api<ExtensionsResponse>('/accounts/'+encodeURIComponent(id)+'/extensions/policy',{method:'PUT',body:JSON.stringify({expectedRevision:s.extensions.revision,expectedProfileRevision:s.extensions.profileRevision,patch:buildPolicyPatch(sent.extensions,s.extensions,catalogKeys(s.extensions.catalog))})});
      if(!alive.current)return;setSnapshots(v=>({...v,[id]:{...v[id]!,extensions:r.extensions}}));setDrafts(v=>({...v,[id]:{...v[id]!,extensions:draftFromPolicy(r.extensions)}}));setNotice('能力设置已保存；角色绑定单独提交。');
    }catch(e){if(!alive.current)return;if(e instanceof ApiError&&(e.status===0||e.status>=500)){setUnknown({accountId:id,kind:'extensions',draft:sent});setError('能力保存结果未知，请先核对，未自动重复提交。');}else setError((e instanceof ApiError&&e.code==='extension_conflict'?'配置已在别处变化，草稿保留。请重新读取后比较。':'能力设置未保存：')+errorMessage(e));}
    finally{saving.current=false;if(alive.current)setBusy(undefined);}
  };
  const saveRoles=async()=>{
    const id=active.current,s=current.current.snapshots[id],d=current.current.drafts[id];if(!s||!d||lock.current||saving.current||current.current.unknown)return;
    saving.current=true;setBusy('roles');setError(undefined);setNotice(undefined);let count=0;
    try{
      const latest=await api<{bindings:JournalBinding[]}>('/accounts/'+encodeURIComponent(id)+'/role-bindings');
      for(const [key,ref] of Object.entries(d.roles)){
        const [kind,peerId]=key.split('/');const before=s.bindings.find(b=>b.kind===kind&&b.peerId===peerId),now=latest.bindings.find(b=>b.kind===kind&&b.peerId===peerId);
        if((before?.revision??null)!==(now?.revision??null))throw new Error('角色绑定已在别处改变，草稿保留，请重新读取后比较。');
        const r=await api<{binding:JournalBinding|null}>('/accounts/'+encodeURIComponent(id)+'/role-bindings/'+kind+'/'+encodeURIComponent(peerId!),{method:ref?'PUT':'DELETE',...(ref?{body:JSON.stringify({roleCard:ref})}:{})});
        count++;if(!alive.current)return;
        setSnapshots(v=>({...v,[id]:{...v[id]!,bindings:[...v[id]!.bindings.filter(b=>b.kind!==kind||b.peerId!==peerId),...(r.binding?[{...r.binding,state:'ready' as const,needsRefresh:true}]:[])]}}));
        setDrafts(v=>{const roles={...v[id]!.roles};delete roles[key];return {...v,[id]:{...v[id]!,roles}};});
      }
      if(alive.current)setNotice(`已保存 ${count} 处角色绑定；能力设置单独提交。`);
      try{const [policy,bindings]=await Promise.all([api<AccountPolicyResponse>('/accounts/'+encodeURIComponent(id)+'/policy'),api<{bindings:JournalBinding[]}>('/accounts/'+encodeURIComponent(id)+'/role-bindings')]);
        if(alive.current)setSnapshots(v=>({...v,[id]:{...v[id]!,policy:policy.policy,bindings:bindings.bindings.filter(b=>b.accountId===id)}}));
      }catch(e){if(alive.current)setError('角色已保存，运行条件刷新失败，请重新读取核对：'+errorMessage(e));}
    }catch(e){if(!alive.current)return;if(e instanceof ApiError&&(e.status===0||e.status>=500))setUnknown({accountId:id,kind:'roles',draft:structuredClone(d)});setError(`${count?`已保存 ${count} 处，其余未确认。`:''}${errorMessage(e)}${e instanceof ApiError&&(e.status===0||e.status>=500)?' 结果未知，请核对后再操作。':''}`);}
    finally{saving.current=false;if(alive.current)setBusy(undefined);}
  };
  const verify=async()=>{
    const u=current.current.unknown;if(!u||saving.current||lock.current)return;saving.current=true;setBusy('verify');
    try{const s=await readSnapshot(u.accountId,publicRef.current.items,publicRef.current.current);if(!alive.current)return;
      const matches=u.kind==='extensions'?journalPolicyEqual(u.draft.extensions,draftFromPolicy(s.extensions)):u.kind==='reply'?!!u.target&&journalReply(s,u.target)===u.enabled:Object.entries(u.draft.roles).every(([key,ref])=>roleEqual(ref,s.bindings.find(b=>b.kind+'/'+b.peerId===key)?.roleCard));
      setSnapshots(v=>({...v,[u.accountId]:s}));
      if(matches){setDrafts(v=>({...v,[u.accountId]:{...v[u.accountId]!,...(u.kind==='extensions'?{extensions:draftFromPolicy(s.extensions)}:u.kind==='roles'?{roles:{}}:{})}}));setUnknown(undefined);setError(undefined);setNotice('已核对：服务器显示保存结果。');}
      else setError('服务器当前状态与提交内容不一致，结果仍待核对；草稿保留，未重复提交。');
    }catch(e){if(alive.current)setError('核对失败：'+errorMessage(e));}finally{saving.current=false;if(alive.current)setBusy(undefined);}
  };
  const setReply=async(enabled:boolean,target=page)=>{
    if(!target||lock.current||saving.current||unknown)return false;
    const id=active.current;saving.current=true;setBusy('reply');setError(undefined);
    try{const r=await api<AccountPolicyResponse>('/accounts/'+encodeURIComponent(id)+'/agent',{method:'POST',body:JSON.stringify({enabled,...(target.kind?{kind:target.kind}:{}),...(target.peerId?{peerId:target.peerId}:{})})});if(alive.current){setSnapshots(v=>({...v,[id]:{...v[id]!,policy:r.policy}}));setNotice(enabled?'回复策略已开启；仍需满足角色、连接和模型条件。':'回复策略已暂停，角色绑定保留。');}return true;}catch(e){if(alive.current){if(e instanceof ApiError&&(e.status===0||e.status>=500))setUnknown({accountId:id,kind:'reply',draft:structuredClone(current.current.drafts[id]!),target,enabled});setError('回复策略未确认：'+errorMessage(e));}return false;}finally{saving.current=false;if(alive.current)setBusy(undefined);}
  };
  const add=async(kind:'group'|'private',peerId:string)=>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(peerId))throw new Error('请输入有效的 QQ / 群号（最多64字符）');
    const p:JournalPage={key:kind+'/'+peerId,type:'conv',kind,peerId,name:peerId,no:0,freq:0};if(!await setReply(false,p))throw new Error('会话未确认加入，请核对页面提示。');choosePage(p.key);
  };
  const reload=async()=>{if(saving.current||lock.current)return;const r=await requestTransition({scope:{kind:'ids',ids:['relationship-journal']},actionLabel:'重新读取关系设置'});if(r.ok){setUnknown(undefined);await load(active.current);}};
  const prefetch=async()=>{for(const id of accountIds.slice(0,32)){if(current.current.snapshots[id])continue;try{const s=await readSnapshot(id,publicRef.current.items,publicRef.current.current);if(!alive.current)return;setSnapshots(v=>v[id]?v:{...v,[id]:s});setDrafts(v=>v[id]?v:{...v,[id]:journalDraft(s)});}catch{if(alive.current)setError('部分账号总览未能读取，请切换到对应账号重试。');}}};
  const validEffective=Object.fromEntries(Object.entries(effective).filter(([key,value])=>{const s=snapshots[key.split('/')[0]!];return s&&value.snapshotKey===journalSnapshotKey(s);}));
  return {accountId,snapshots,drafts,snapshot,draft,pages,page,effective:validEffective,loading,busy,error,notice,unknown,extensionDirty,roleDirty,chooseAccount,choosePage,edit,bind,saveExtensions,saveRoles,setReply,add,reload,prefetch,verify,setNotice};
}
