import type { AccountPolicy, ArtifactItem, ArtifactRef, ConversationRef, ExtensionEffectiveDto, ExtensionPolicyDto, SlotsResponse } from '../types';
import { resolveEffectiveExtensions } from '../../../../src/extensions/effective.js';
import { resolvePluginSwitch } from '../../../../src/extensions/policy.js';
import { draftFromPolicy, rawSwitchValue, resolveDraftSwitch, defaultSwitchValue, type ExtensionPolicyDraft, type ExtensionScope } from './extensions-policy';
import { homeConnection } from './home-presentation';
import { extensionIssueLabel } from './labels';

export interface JournalBinding extends ConversationRef {
  roleCard: ArtifactRef; revision: string; state: 'ready' | 'missing'; cardName?: string; resolvedRevision?: string;
  worldbook?:{enabled?:boolean};effectiveWorldbook?:{state:string;error?:string};
  needsRefresh?:boolean;
}
export interface JournalSnapshot {
  accountId: string; extensions: ExtensionPolicyDto; policy: AccountPolicy;
  bindings: JournalBinding[]; artifacts: ArtifactItem[]; candidates: ConversationRef[];
  current?:Record<string,string>;
  readAt?:number;
}
export interface JournalDraft {
  extensions: ExtensionPolicyDraft;
  roles: Record<string, ArtifactRef | null>;
}
export interface JournalPage { key: string; type: 'account' | 'kind' | 'conv'; kind?: 'group' | 'private'; peerId?: string; name: string; no: number; freq: number }
export interface JournalResource { key: string; id: string; section: 'plugins' | 'skills'; name: string; source: string; missing?: boolean; accountPrivate?:boolean }
export interface JournalEffective { extensions: ExtensionEffectiveDto; agentEnabled: boolean; chatAvailable: boolean; chatReason?: string; snapshotKey?:string }
export function journalSnapshotKey(s:JournalSnapshot):string{return JSON.stringify([s.readAt,s.extensions.revision,s.policy,s.bindings.map(b=>[b.kind,b.peerId,b.revision])]);}
/** 核对保存结果时忽略字段顺序、空作用域与已移除的 inherit，不依赖 JSON 对象的插入顺序。 */
export function journalPolicyEqual(a:ExtensionPolicyDraft,b:ExtensionPolicyDraft):boolean{
  const normalize=(v:unknown):unknown=>Array.isArray(v)?[...v].sort():v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,normalize(x)]).filter(([,x])=>x!=='inherit'&&x!==undefined&&!(x&&typeof x==='object'&&!Array.isArray(x)&&!Object.keys(x).length))):v;
  return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
}
export const journalKey = (c: Pick<ConversationRef,'kind'|'peerId'>): string => `${c.kind}/${c.peerId}`;
export function journalScope(page: JournalPage): ExtensionScope {
  return page.type === 'account' ? {level:'defaults'} : page.type === 'kind' ? {level:'kind',kind:page.kind!} : {level:'conversation',kind:page.kind!,peerId:page.peerId!};
}
export function journalDraft(snapshot: JournalSnapshot): JournalDraft { return {extensions:draftFromPolicy(snapshot.extensions),roles:{}}; }
/** 只把显式配置的会话列入名册；历史记录单独作为候选，不自动开启回复。 */
export function journalPages(snapshot: JournalSnapshot, draft?: JournalDraft): JournalPage[] {
  const keys=new Set<string>(snapshot.bindings.filter(b=>b.accountId===snapshot.accountId).map(journalKey));
  for(const key of [...Object.keys(snapshot.policy.byConversation),...Object.keys(snapshot.extensions.byConversation),...Object.keys(draft?.roles??{})])if(/^(group|private)\/[A-Za-z0-9._-]{1,64}$/.test(key))keys.add(key);
  const result:JournalPage[]=[{key:'acc',type:'account',name:'账号通用',no:1,freq:87.8},{key:'k:group',type:'kind',kind:'group',name:'群聊分类',no:2,freq:90.4}];
  for(const kind of ['group','private'] as const){
    if(kind==='private')result.push({key:'k:private',type:'kind',kind,name:'私聊分类',no:result.length+1,freq:100.2});
    const peers=[...keys].filter(k=>k.startsWith(kind+'/')).sort();
    peers.slice(0,500).forEach((key,i)=>{const peerId=key.slice(kind.length+1);result.push({key,type:'conv',kind,peerId,name:`${kind==='group'?'群聊':'私聊'} ${peerId}`,no:result.length+1,freq:Math.round(((kind==='group'?91:101)+(kind==='group'?7:6)*i/Math.max(1,peers.length-1))*10)/10});});
  }
  return result;
}
export function journalRole(snapshot: JournalSnapshot,draft: JournalDraft,page: JournalPage): {ref:ArtifactRef;name:string;state:'ready'|'missing'|'pending';revision?:string}|undefined {
  if(page.type!=='conv')return;
  const binding=snapshot.bindings.find(b=>journalKey(b)===page.key);
  const own=Object.hasOwn(draft.roles,page.key);
  const ref=own?draft.roles[page.key]:binding?.roleCard;
  if(!ref)return;
  const candidates=snapshot.artifacts.filter(a=>a.manifest.kind==='role-card'&&a.ref.source===ref.source&&a.ref.id===ref.id);
  if(!own&&binding?.needsRefresh)return {ref,name:candidates.find(a=>a.ref.revision===ref.revision)?.manifest.name??ref.id,state:'pending'};
  const revision=ref.revision??(!own?binding?.resolvedRevision:undefined)??(ref.source==='public'?snapshot.current?.['role-card:'+ref.id]:undefined);
  if(own&&ref.source==='private'&&!ref.revision)return {ref,name:candidates[0]?.manifest.name??ref.id,state:'pending'};
  const item=revision?candidates.find(a=>a.ref.revision===revision):undefined;
  return {ref,name:item?.manifest.name??binding?.cardName??ref.id,state:item&&(own||binding?.state==='ready')?'ready':'missing',revision};
}
export function journalResources(snapshot: JournalSnapshot,draft: JournalDraft): JournalResource[] {
  const result:JournalResource[]=[...snapshot.extensions.catalog.plugins.map(p=>({key:'plugins:'+p.key,id:p.key,section:'plugins' as const,accountPrivate:p.source==='private',name:p.name??p.id,source:p.source==='public'?'公共插件':'账号私有插件'})),...snapshot.extensions.catalog.skills.map(s=>({key:'skills:'+s.id,id:s.id,section:'skills' as const,accountPrivate:s.source==='private'||s.pluginKey?.startsWith('private/'),name:s.name,source:s.source==='plugin'?'插件提供':s.source==='private'?(s.overrides?'私有覆盖公共':'账号私有'):'公共 Skill'}))];
  for(const scope of [draft.extensions.defaults,...Object.values(draft.extensions.byKind),...Object.values(draft.extensions.byConversation)])for(const section of ['plugins','skills'] as const)for(const id of Object.keys(scope?.[section]??{}))if(!result.some(r=>r.section===section&&r.id===id))result.push({key:section+':'+id,id,section,name:id,source:'引用已缺失',missing:true,accountPrivate:true});
  return result;
}
export function journalSwitch(snapshot: JournalSnapshot,draft: JournalDraft,page: JournalPage,resource:JournalResource){
  const scope=journalScope(page),fallback=defaultSwitchValue(resource.section,snapshot.extensions.catalog,resource.id);
  const conv=scope.level==='defaults'?undefined:{kind:scope.kind,peerId:scope.level==='conversation'?scope.peerId:'journal-kind-preview'};
  const resolved=resolveDraftSwitch(draft.extensions,conv,resource.section,resource.id,fallback);
  return {...resolved,own:rawSwitchValue(draft.extensions,scope,resource.section,resource.id)};
}
export function journalChain(s:JournalSnapshot,d:JournalDraft,p:JournalPage,r:JournalResource){
  const layers:JournalPage[]=[{...p,type:'account',key:'acc',kind:undefined,peerId:undefined,name:'账号'}];
  if(p.kind)layers.push({...p,type:'kind',key:'k:'+p.kind,peerId:undefined,name:p.kind==='group'?'群聊分类':'私聊分类'});
  if(p.type==='conv')layers.push({...p,name:'本会话'});
  return layers.map(page=>({label:page.name,...journalSwitch(s,d,page,r)}));
}
/** 草稿预览复用核心同一纯解析器；实际运行能力来自服务端快照，不虚构工具就绪。 */
export function journalIssues(snapshot: JournalSnapshot,draft:JournalDraft,page:JournalPage,resource:JournalResource,effective?:JournalEffective):string[]{
  if(journalSwitch(snapshot,draft,page,resource).value==='off')return [];
  if(resource.missing)return ['引用的资源不存在或尚未安装'];
  const conversation={accountId:snapshot.accountId,kind:page.kind??'private',peerId:page.peerId??'journal-scope-preview'};
  const extensions=page.type==='account'?{...draft.extensions,byKind:{},byConversation:{}}:page.type==='kind'?{...draft.extensions,byConversation:{}}:draft.extensions;
  const view=resolveEffectiveExtensions({accountId:snapshot.accountId,conversation,catalog:snapshot.extensions.catalog,authorizedTools:draft.extensions.authorizedTools,extensions});
  if(resource.section==='skills'){
    const entry=view.skills.find(s=>s.skill.id===resource.id);
    const reasons=(entry?.issues??[]).filter(i=>!(page.type==='account'&&i.code==='kind_scope')&&!(page.type!=='conv'&&i.code==='peer_scope')).map(i=>extensionIssueLabel(i.code,i.detail));
    const dependencies=snapshot.extensions.catalog.skills.find(s=>s.id===resource.id)?.requires??[];
    const saved=effective?.extensions.skills.find(s=>s.skill.id===resource.id);
    if(saved)for(const issue of saved.issues.filter(i=>i.code==='requires_unavailable'||i.code==='capability_unavailable'))reasons.push(extensionIssueLabel(issue.code,issue.detail));
    if(dependencies.length&&!effective)reasons.push('能力状态尚未核对');
    return [...new Set(reasons)];
  }
  const plugin=resolvePluginSwitch({extensions},conversation,resource.id);
  if(plugin.value==='off')return [];
  const ready=snapshot.extensions.runtime.plugins.find(p=>p.pluginKey===resource.id);
  return !snapshot.extensions.runtime.synced?['插件运行状态尚未同步']:!snapshot.extensions.runtime.readyPlugins.includes(resource.id)?[ready?'插件尚未就绪':'插件未加载']:[];
}
export function journalReply(snapshot:JournalSnapshot,page:JournalPage):boolean{
  let value=snapshot.policy.agentEnabled??true;
  if(page.kind&&snapshot.policy.byKind[page.kind]?.agentEnabled!==undefined)value=snapshot.policy.byKind[page.kind]!.agentEnabled!;
  if(page.type==='conv'&&snapshot.policy.byConversation[page.key]?.agentEnabled!==undefined)value=snapshot.policy.byConversation[page.key]!.agentEnabled!;
  return value;
}
export function journalVerdict(snapshot:JournalSnapshot,draft:JournalDraft,page:JournalPage,slots:SlotsResponse|undefined,effective?:JournalEffective){
  const reasons:string[]=[];const role=journalRole(snapshot,draft,page),connection=homeConnection(snapshot.accountId,slots);
  if(!role)reasons.push('尚未绑定角色卡');else if(role.state==='missing')reasons.push('角色卡或版本缺失');
  else if(role.state==='pending')reasons.push('角色版本待核对');
  const binding=snapshot.bindings.find(b=>journalKey(b)===page.key);
  if(binding?.worldbook?.enabled&&['missing','invalid'].includes(binding.effectiveWorldbook?.state??''))reasons.push('已启用的世界书不可用，请在资料与世界书中修复');
  if(!connection.connected)reasons.push(connection.label);
  if(!journalReply(snapshot,page))reasons.push('自动回复已暂停');
  if(!effective)reasons.push('运行条件待核对');else if(!effective.chatAvailable)reasons.push(effective.chatReason??'对话模型不可用');
  return {ok:reasons.length===0,reasons,role};
}
