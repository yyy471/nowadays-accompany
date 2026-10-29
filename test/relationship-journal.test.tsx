import {describe,expect,it} from 'vitest';
import {journalDraft,journalIssues,journalPages,journalResources,journalRole,journalSwitch,journalVerdict,type JournalSnapshot} from '../desktop/renderer/src/lib/relationship-journal';
import {buildPolicyPatch,catalogKeys,setScopeSwitch} from '../desktop/renderer/src/lib/extensions-policy';
import {conversationScopeKey} from '../src/providers/types.js';
import {pluginKey} from '../src/extensions/contracts.js';

export function snapshot(accountId='10001'):JournalSnapshot{return {
  accountId,current:{'role-card:summer':'r2'},
  policy:{agentEnabled:true,byKind:{},byConversation:{'group/42':{agentEnabled:false}},allowedProviders:[],crossProviderFallback:false,media:{allowCloudUpload:false},capabilities:{},bindings:{}},
  extensions:{accountId,revision:'e1',profileRevision:'p1',configVersion:2,authorizedTools:[],defaults:{skills:{letter:'on'}},byKind:{group:{skills:{letter:'off'}}},byConversation:{},
    catalog:{plugins:[],tools:[],hooks:[],skills:[{id:'letter',name:'写信',source:'public',defaultEnabled:false,instructions:'写一封信',tools:[]}]},runtime:{synced:true,readyPlugins:[],readyTools:[],plugins:[]}},
  bindings:[{accountId,kind:'group',peerId:'42',revision:'b1',state:'ready',resolvedRevision:'r2',roleCard:{source:'public',id:'summer'}}],
  artifacts:['r1','r2'].map(revision=>({ref:{source:'public',id:'summer',revision},manifest:{kind:'role-card',id:'summer',revision,name:'夏澄 '+revision,content:'fixture'}})),
  candidates:[{accountId,kind:'private',peerId:'99'}]
};}
describe('关系手账的真实作用域与状态',()=>{
  it('名册只含显式配置；同群不同账号和群私聊身份不混同',()=>{
    const s=snapshot();s.bindings.push({...s.bindings[0]!,accountId:'other',peerId:'88'});
    s.policy.byConversation['private/42']={agentEnabled:false};
    const pages=journalPages(s);
    expect(pages.map(p=>p.key)).toEqual(['acc','k:group','group/42','k:private','private/42']);
    expect(journalPages(snapshot('10002')).find(p=>p.key==='group/42')).toBeDefined();
    expect(pages.some(p=>p.peerId==='99'||p.peerId==='88')).toBe(false);
  });
  it('单会话覆盖优先，恢复继承后使用分类；分类恢复继承使用账号通用',()=>{
    const s=snapshot(),d=journalDraft(s),p=journalPages(s).find(p=>p.key==='group/42')!,r=journalResources(s,d)[0]!;
    expect(journalSwitch(s,d,p,r)).toMatchObject({value:'off',source:'kind',own:'inherit'});
    d.extensions=setScopeSwitch(d.extensions,{level:'conversation',kind:'group',peerId:'42'},'skills','letter','on');
    expect(journalSwitch(s,d,p,r)).toMatchObject({value:'on',source:'conversation',own:'on'});
    d.extensions=setScopeSwitch(d.extensions,{level:'conversation',kind:'group',peerId:'42'},'skills','letter','inherit');
    d.extensions=setScopeSwitch(d.extensions,{level:'kind',kind:'group'},'skills','letter','inherit');
    expect(journalSwitch(s,d,p,r)).toMatchObject({value:'on',source:'account',own:'inherit'});
  });
  it('跟随版本使用已解析版本或当前 catalog，不能把历史资源当作可用绑定',()=>{
    const s=snapshot(),d=journalDraft(s),p=journalPages(s).find(p=>p.type==='conv')!;
    expect(journalRole(s,d,p)).toMatchObject({revision:'r2',name:'夏澄 r2',state:'ready'});
    s.bindings[0]!.state='missing';expect(journalRole(s,d,p)?.state).toBe('missing');
    d.roles[p.key]={source:'public',id:'summer'};expect(journalRole(s,d,p)?.revision).toBe('r2');
    d.roles[p.key]={source:'public',id:'summer',revision:'missing'};expect(journalRole(s,d,p)?.state).toBe('missing');
    d.roles[p.key]={source:'private',id:'summer'};expect(journalRole(s,d,p)?.state).toBe('pending');
    expect(journalRole(s,d,journalPages(s)[0]!)).toBeUndefined();
  });
  it('角色和连接存在也不能误报可回复，必须核对开关与对话模型',()=>{
    const s=snapshot(),d=journalDraft(s),p=journalPages(s).find(p=>p.type==='conv')!;
    const slots={ok:true,slots:[{accountId:s.accountId,state:'online',connected:true}]} as any;
    expect(journalVerdict(s,d,p,slots).ok).toBe(false);
    expect(journalVerdict(s,d,p,slots).reasons).toContain('自动回复已暂停');
    expect(journalVerdict(s,d,p,slots,{agentEnabled:true,chatAvailable:false,extensions:{} as any}).ok).toBe(false);
    expect(journalVerdict(s,d,p,slots,{agentEnabled:true,chatAvailable:true,extensions:{} as any}).ok).toBe(false);
    s.policy.byConversation['group/42']={agentEnabled:true};
    expect(journalVerdict(s,d,p,slots,{agentEnabled:true,chatAvailable:true,extensions:{} as any}).ok).toBe(true);
    s.bindings[0]!.worldbook={enabled:true};s.bindings[0]!.effectiveWorldbook={state:'missing'};
    expect(journalVerdict(s,d,p,slots,{agentEnabled:true,chatAvailable:true,extensions:{} as any}).ok).toBe(false);
  });
  it('分类预览可用且未核对能力依赖明确显示，不伪造已就绪',()=>{
    const s=snapshot(),d=journalDraft(s),p=journalPages(s)[0]!;
    s.extensions.catalog.skills[0]!.requires=['image.generate'];
    expect(journalIssues(s,d,p,journalResources(s,d)[0]!)).toContain('能力状态尚未核对');
    expect(()=>journalIssues(s,d,journalPages(s)[1]!,journalResources(s,d)[0]!)).not.toThrow();
  });
  it('账号通用预览不受下属分类覆盖影响',()=>{
    const s=snapshot(),d=journalDraft(s);d.extensions.byKind.private={skills:{letter:'off'}};
    expect(journalIssues(s,d,journalPages(s)[0]!,journalResources(s,d)[0]!)).toEqual([]);
  });
  it('纯身份工具保持旧公开接口和标识符校验',()=>{
    expect(pluginKey('public','demo')).toBe('public/plugin/demo');
    expect(conversationScopeKey('group','42')).toBe('group/42');
    expect(()=>conversationScopeKey('group','../escape')).toThrow();
  });
  it('缺失资源恢复继承仍在补丁中发送删除旧覆盖',()=>{
    const s=snapshot();s.extensions.defaults.skills={ghost:'on'};
    const d=journalDraft(s);d.extensions=setScopeSwitch(d.extensions,{level:'defaults'},'skills','ghost','inherit');
    expect(buildPolicyPatch(d.extensions,s.extensions,catalogKeys(s.extensions.catalog)).defaults?.skills?.ghost).toBe('inherit');
    expect(journalResources(s,journalDraft(s)).find(r=>r.id==='ghost')?.accountPrivate).toBe(true);
  });
});
