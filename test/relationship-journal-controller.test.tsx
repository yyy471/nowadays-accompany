import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DraftRegistry} from '../desktop/renderer/src/lib/drafts/registry';
import {TransitionController} from '../desktop/renderer/src/lib/drafts/transition-controller';
const h=vi.hoisted(()=>({cells:[] as any[],index:0,effects:[] as Array<()=>void>,cleanups:new Map<number,()=>void>(),api:vi.fn(),protection:null as any}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:(initial:any)=>{const i=h.index++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return [h.cells[i],(v:any)=>{h.cells[i]=typeof v==='function'?v(h.cells[i]):v;}];},
  useRef:(value:any)=>h.cells[h.index++]??=( {current:value} ),
  useCallback:(fn:any)=>{h.index++;return fn;},
  useEffect:(fn:any,deps:any[])=>{const i=h.index++,before=h.cells[i];if(!before||deps.some((v,j)=>!Object.is(v,before[j])))h.effects.push(()=>{h.cleanups.get(i)?.();const cleanup=fn();if(typeof cleanup==='function')h.cleanups.set(i,cleanup);});h.cells[i]=deps;}
}));
vi.mock('../desktop/renderer/src/api',()=>({api:(...args:any[])=>h.api(...args),ApiError:class extends Error{constructor(message:string,readonly status:number,readonly code='http_error'){super(message);}}}));
vi.mock('../desktop/renderer/src/hooks',()=>({errorMessage:(e:unknown)=>e instanceof Error?e.message:String(e)}));
vi.mock('../desktop/renderer/src/components/DraftProtectionProvider',()=>({useDraftProtection:()=>h.protection}));
import {useJournal} from '../desktop/renderer/src/pages/relations/use-journal';
import {ApiError} from '../desktop/renderer/src/api';
import {journalResources} from '../desktop/renderer/src/lib/relationship-journal';
const items:any[]=[];
const seed=(id:string)=>({accountId:id,revision:'e1',profileRevision:'p1',configVersion:2,authorizedTools:[],defaults:{},byKind:{},byConversation:{},catalog:{plugins:[],tools:[],hooks:[],skills:[{id:'letter',name:'信笺',source:'public',tools:[],instructions:'写信',defaultEnabled:false}]},runtime:{synced:true,readyPlugins:[],readyTools:[],plugins:[]}});
let state:any,j:ReturnType<typeof useJournal>,confirm:ReturnType<typeof vi.fn>;
function render(){h.index=0;j=useJournal(['10001','10002'],items,false);const effects=h.effects.splice(0);effects.forEach(fn=>fn());return j;}
async function flush(){for(let i=0;i<8;i++){await Promise.resolve();render();}}
const deferred=()=>{let resolve!:(v:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};};
beforeEach(()=>{h.cells=[];h.index=0;h.effects=[];h.cleanups.clear();h.api.mockReset();
  state={ext:{10001:seed('10001'),10002:seed('10002')},policy:{10001:{agentEnabled:true,byKind:{},byConversation:{'group/42':{}}},10002:{agentEnabled:true,byKind:{},byConversation:{'group/42':{}}}},bindings:{10001:[],10002:[]}};
  const registry=new DraftRegistry(),controller=new TransitionController(registry);confirm=vi.fn(async()=>true);h.protection={registry,requestTransition:(options:any)=>controller.request({...options,confirm})};
  h.api.mockImplementation(async(path:string,init?:RequestInit)=>{
    const id=path.split('/')[2],tail=path.split('/').slice(3).join('/');
    if(path.startsWith('/conversations'))return {ok:true,conversations:[]};
    if(tail==='extensions')return {extensions:structuredClone(state.ext[id!])};
    if(tail==='policy')return {policy:structuredClone(state.policy[id!])};
    if(tail==='role-bindings')return {bindings:structuredClone(state.bindings[id!])};
    if(tail==='artifacts')return {artifacts:[]};
    if(tail==='extensions/effective?kind=group&peerId=42')return {effective:{skills:[],plugins:[],tools:[],hooks:[],states:[]}};
    if(tail==='effective?kind=group&peerId=42')return {effective:{agentEnabled:true,capabilities:[{capability:'chat',enabled:true}]}};
    if(tail==='extensions/policy'){const body=JSON.parse(init!.body as string);const apply=(target:any,patch:any)=>{for(const [k,v]of Object.entries(patch)){if(v==='inherit')delete target[k];else if(v&&typeof v==='object'&&!Array.isArray(v)){apply(target[k]??={},v);if(!Object.keys(target[k]).length)delete target[k];}else target[k]=v;}};apply(state.ext[id!],body.patch);state.ext[id!].defaults??={};state.ext[id!].byKind??={};state.ext[id!].byConversation??={};state.ext[id!].revision='e2';return {extensions:structuredClone(state.ext[id!])};}
    if(tail.startsWith('role-bindings/')){const [,kind,peerId]=tail.split('/'),ref=JSON.parse(init!.body as string).roleCard;const binding={accountId:id,kind,peerId,revision:'b2',roleCard:ref};state.bindings[id!].push(binding);return {binding};}
    if(tail==='agent')throw new ApiError('fixture rejected',400);
    throw new Error('unhandled '+path);
  });render();
});
afterEach(()=>{h.cleanups.forEach(fn=>fn());});
it('迟到的账号读取不能替换当前账号',async()=>{
  const pending=deferred(),normal=h.api.getMockImplementation()!;
  // 首次请求已进入微任务；重新读取 A 的 extension 请求延后，再切 B。
  await flush();h.api.mockImplementation((path:string,init?:RequestInit)=>path==='/accounts/10001/extensions'?pending.promise:normal(path,init));
  const loading=j.reload();await Promise.resolve();await Promise.resolve();render();await j.chooseAccount('10002');render();await flush();
  pending.resolve({extensions:seed('10001')});await loading;await flush();expect(j.accountId).toBe('10002');expect(j.snapshot.accountId).toBe('10002');
});
it('修改草稿后取消账号切换，账号与草稿均保留',async()=>{
  await flush();const r=journalResources(j.snapshot,j.draft)[0]!;j.edit(r,'on');render();confirm.mockResolvedValue(false);
  expect(await j.chooseAccount('10002')).toBe(false);render();expect(j.accountId).toBe('10001');expect(j.extensionDirty).toBe(true);expect(confirm).toHaveBeenCalledOnce();
});
it('扩展 CAS 冲突保留草稿且不覆盖远端',async()=>{
  await flush();j.edit(journalResources(j.snapshot,j.draft)[0]!,'on');render();const normal=h.api.getMockImplementation()!;
  h.api.mockImplementation((path:string,init?:RequestInit)=>path.endsWith('/extensions/policy')?Promise.reject(new ApiError('changed',409,'extension_conflict')):normal(path,init));
  await j.saveExtensions();render();expect(j.extensionDirty).toBe(true);expect(j.error).toContain('配置已在别处变化');expect(j.unknown).toBeUndefined();
});
it('未知保存不会自动重提，可通过只读核对确认成功',async()=>{
  await flush();j.edit(journalResources(j.snapshot,j.draft)[0]!,'on');render();const normal=h.api.getMockImplementation()!;
  h.api.mockImplementation(async(path:string,init?:RequestInit)=>{const result=await normal(path,init);if(path.endsWith('/extensions/policy'))throw new ApiError('connection lost',0);return result;});
  await j.saveExtensions();render();expect(j.unknown?.kind).toBe('extensions');const writes=()=>h.api.mock.calls.filter(c=>c[0].endsWith('/extensions/policy')).length;
  await j.saveExtensions();expect(writes()).toBe(1);await j.verify();render();expect(j.unknown).toBeUndefined();expect(j.extensionDirty).toBe(false);expect(writes()).toBe(1);
});
it('角色批次部分成功仅清除已确认项目，其余草稿保留',async()=>{
  await flush();j.bind({source:'public',id:'first'});render();j.choosePage('private/77');state.policy['10001'].byConversation['private/77']={};
  // 重新选择一个已管理的私聊以形成第二处草稿。
  j.snapshot.policy.byConversation['private/77']={};render();j.choosePage('private/77');render();j.bind({source:'public',id:'second'});render();
  const normal=h.api.getMockImplementation()!;h.api.mockImplementation((path:string,init?:RequestInit)=>path.endsWith('/private/77')?Promise.reject(new ApiError('role missing',400)):normal(path,init));
  await j.saveRoles();render();expect(j.draft.roles['group/42']).toBeUndefined();expect(j.draft.roles['private/77']?.id).toBe('second');expect(j.error).toContain('已保存 1 处');
});
it('加入会话失败不切到不存在的页',async()=>{
  await flush();await expect(j.add('group','88')).rejects.toThrow('未确认加入');render();expect(j.page.key).toBe('group/42');expect(j.pages.some(p=>p.peerId==='88')).toBe(false);
});
it('总览预取迟到不覆盖已打开账号的新草稿',async()=>{
  await flush();const pending=deferred(),normal=h.api.getMockImplementation()!;let count=0;
  h.api.mockImplementation((path:string,init?:RequestInit)=>path==='/accounts/10002/extensions'&&count++===0?pending.promise:normal(path,init));
  const prefetch=j.prefetch();await j.chooseAccount('10002');render();await flush();j.edit(journalResources(j.snapshot,j.draft)[0]!,'on');render();
  pending.resolve({extensions:seed('10002')});await prefetch;await flush();expect(j.accountId).toBe('10002');expect(j.extensionDirty).toBe(true);
});
it('重新读取运行状态失败时使旧有效条件失效',async()=>{
  await flush();expect(Object.keys(j.effective)).toContain('10001/group/42');const normal=h.api.getMockImplementation()!;
  h.api.mockImplementation((path:string,init?:RequestInit)=>path.includes('/effective?')?Promise.reject(new ApiError('fixture offline',503)):normal(path,init));
  await j.reload();await flush();expect(j.effective['10001/group/42']).toBeUndefined();expect(j.error).toContain('运行条件读取失败');
});
