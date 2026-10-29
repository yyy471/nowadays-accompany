// 显式启动的内存样例，仅用于真实 React 渲染层验收；不装配 Core、QQ 或模型。
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {resolveEffectiveExtensions} from '../../src/extensions/effective.ts';
const apiPort=50331,uiPort=50330,token='relationship-preview';
// 仅显式隔离预览可放慢装饰时长，供截图工具捕获中间帧；产品构建不消费此变量。
const animationScale=Math.max(1,Math.min(10,Number(process.env.RELATIONSHIP_ANIMATION_SCALE)||1));
const names=[['10001','白昼来信'],['10002','晚风电台'],['10003','花园值班室']];
const artifacts=['夏澄','阿遥','阿序','林间邮差','花园看守'].map((name,i)=>({ref:{source:'public',id:'role-'+i,revision:'r1'},manifest:{kind:'role-card',id:'role-'+i,name,revision:'r1'}}));
const plugins=[['journal','手账整理'],['weather','天气信笺'],['garden','花园观察']].map(([id,name])=>({key:'public/plugin/'+id,source:'public',id,name,revision:'r1',tools:[],hooks:[],skills:[],stateVersion:'1',accountSharedState:false}));
const skills=['写一封信','记录日常','温柔提醒','天气播报','夜间陪伴'].map((name,i)=>({id:'skill-'+i,name,source:'public',instructions:'明确标记的验收样例。',tools:[],defaultEnabled:i<3,...(i===3?{requires:['image.generate']}:{})}));
const extension=id=>({accountId:id,revision:'e1',profileRevision:'p1',configVersion:2,authorizedTools:[],defaults:{plugins:Object.fromEntries(plugins.map(p=>[p.key,'on'])),skills:{'skill-3':'on'}},byKind:{group:{skills:{'skill-1':'off'}}},byConversation:{'group/785002':{skills:{'skill-1':'on'}}},catalog:{plugins,tools:[],hooks:[],skills},runtime:{synced:true,readyPlugins:plugins.slice(0,2).map(p=>p.key),readyTools:[],plugins:plugins.map((p,i)=>({pluginKey:p.key,revision:'r1',ready:i<2,tools:[],hooks:[]}))}});
const policy=()=>({agentEnabled:true,allowedProviders:[],crossProviderFallback:false,media:{allowCloudUpload:false},capabilities:{},bindings:{},byKind:{},byConversation:{'group/785003':{agentEnabled:false},'private/462831':{agentEnabled:true}}});
const initial=()=>({flags:{},requests:[],ext:Object.fromEntries(names.map(([id])=>[id,extension(id)])),policies:Object.fromEntries(names.map(([id])=>[id,policy()])),bindings:Object.fromEntries(names.map(([id],i)=>[id,[['group','785001'],['group','785002'],['group','785003'],['private','462831'],['private','462832']].slice(0,5-i).map(([kind,peerId],j)=>({accountId:id,kind,peerId,roleCard:artifacts[(i+j)%artifacts.length].ref,revision:'b1-'+j,state:'ready',cardName:artifacts[(i+j)%artifacts.length].manifest.name,resolvedRevision:'r1',worldbookEntryCount:0}))]))});
let state=initial();const clients=new Set();
const send=(res,code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value));};
const merge=(target,patch)=>{for(const [k,v]of Object.entries(patch)){if(v==='inherit')delete target[k];else if(v&&typeof v==='object'&&!Array.isArray(v))merge(target[k]??={},v);else target[k]=v;}return target;};
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname;
  if(path==='/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(': isolated-preview\n\n');clients.add(res);const beat=setInterval(()=>res.write(': ping\n\n'),10000);req.on('close',()=>{clearInterval(beat);clients.delete(res);});return;}
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)return send(res,413,{error:'fixture body too large'});}const body=raw?JSON.parse(raw):undefined;
  if(path==='/__fixture/state')return send(res,200,state);
  if(path==='/__fixture/reset'){state=initial();return send(res,200,{ok:true});}
  if(path==='/__fixture/control'){state.flags={...state.flags,...body};return send(res,200,{ok:true});}
  if(req.headers.authorization!=='Bearer '+token)return send(res,401,{error:'isolated preview token required'});
  state.requests.push({method:req.method,path,body});if(state.requests.length>1000)state.requests.shift();
  const accounts=names.map(([id,name])=>({accountId:id,nickname:name,signature:'仅用于界面验收的虚构账号',dir:'fixture/'+id,state:'ready',slots:['fixture-'+id]}));
  if(path==='/accounts')return send(res,200,{ok:true,accounts});
  if(path==='/slots')return send(res,200,{ok:true,specs:[],resumable:[],slots:accounts.map((a,i)=>({id:'fixture-'+a.accountId,accountId:a.accountId,backend:'fake',state:i===2?'stopped':'online',connected:i!==2,selfIds:[a.accountId],restartAttempts:0}))});
  if(path==='/artifacts')return send(res,200,{ok:true,current:Object.fromEntries(artifacts.map(a=>['role-card:'+a.ref.id,'r1'])),artifacts});
  if(path==='/conversations')return send(res,200,{ok:true,conversations:[{accountId:url.searchParams.get('accountId'),kind:'group',peerId:'785099'},{accountId:url.searchParams.get('accountId'),kind:'private',peerId:'462899'}]});
  const match=/^\/accounts\/([^/]+)\/(.+)$/.exec(path);
  if(match){const [,id,kind]=match,p=state.policies[id],ext=state.ext[id];if(!p)return send(res,404,{error:'unknown fixture account'});
    if(kind==='policy')return send(res,200,{ok:true,policy:p});
    if(kind==='artifacts')return send(res,200,{ok:true,artifacts:[]});
    if(kind==='role-bindings')return send(res,200,{ok:true,bindings:state.bindings[id]});
    const role=/^role-bindings\/(group|private)\/([^/]+)$/.exec(kind);
    if(role){const [,chat,peer]=role;state.bindings[id]=state.bindings[id].filter(b=>b.kind!==chat||b.peerId!==peer);const binding=req.method==='DELETE'?null:{accountId:id,kind:chat,peerId:peer,roleCard:body.roleCard,revision:'b'+Date.now(),state:'ready'};if(binding)state.bindings[id].push(binding);else(p.byConversation[chat+'/'+peer]??={}).agentEnabled=false;return send(res,200,{ok:true,binding});}
    if(kind==='agent'){const target=body.peerId?p.byConversation[body.kind+'/'+body.peerId]??={}:body.kind?p.byKind[body.kind]??={}:p;target.agentEnabled=body.enabled;if(state.flags.agentUnknown)return res.destroy();return send(res,200,{ok:true,policy:p});}
    if(kind==='extensions')return send(res,200,{ok:true,extensions:ext});
    if(kind==='extensions/policy'){
      if(state.flags.conflict||body.expectedRevision!==ext.revision)return send(res,409,{error:'样例配置已变化',code:'extension_conflict'});
      merge(ext,body.patch);ext.revision='e'+Date.now();if(state.flags.unknown)return res.destroy();return send(res,200,{ok:true,extensions:ext});
    }
    const conversation={accountId:id,kind:url.searchParams.get('kind')??'group',peerId:url.searchParams.get('peerId')??'785001'};
    if(kind==='extensions/effective')return send(res,200,{ok:true,effective:{accountId:id,conversation,...resolveEffectiveExtensions({accountId:id,conversation,catalog:ext.catalog,authorizedTools:ext.authorizedTools,extensions:ext})}});
    if(kind==='effective')return send(res,200,{ok:true,effective:{accountId:id,conversation,agentEnabled:p.byConversation[conversation.kind+'/'+conversation.peerId]?.agentEnabled??p.byKind[conversation.kind]?.agentEnabled??p.agentEnabled,agentSource:'account',capabilities:[{capability:'chat',enabled:true}],skills:{available:[],unavailable:[]}}});
    if(kind==='display')return send(res,200,{ok:true,display:{nickname:names.find(n=>n[0]===id)?.[1]}});
    if(kind==='skills')return send(res,200,{ok:true,revision:'s1',skills:[]});
  }
  if(path==='/providers')return send(res,200,{ok:true,providers:[],credentialStore:{kind:'preview',available:false}});
  if(path==='/worldbooks')return send(res,200,{ok:true,items:[]});
  if(path==='/skills')return send(res,200,{ok:true,revision:'s1',skills:[]});
  if(path==='/injection/settings')return send(res,200,{ok:true,settings:{version:1,resumeLastListen:false}});
  if(path==='/injection/runtime')return send(res,200,{ok:true,runtime:{configured:false,running:false,authenticated:false,passwordConfigured:false,consentRequired:false,autoLoadEnabled:false,autoLoadKnown:true,owner:'none',compatible:false,supportedVersion:'preview',startupState:'unconfigured'}});
  if(path==='/injection/processes')return send(res,200,{ok:true,processes:[]});
  send(res,404,{error:'未模拟此接口：'+path});
}catch(e){if(!res.headersSent)send(res,500,{error:String(e)});else res.end();}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(apiPort,'127.0.0.1',resolve);});
const proxy=Object.fromEntries(['/accounts','/conversations','/slots','/artifacts','/providers','/injection','/events','/skills','/worldbooks','/__fixture'].map(path=>[path,{target:'http://127.0.0.1:'+apiPort}]));
const motionPreview={name:'relationship-motion-review',transformIndexHtml(html){if(animationScale===1)return html;const overrides=[1500,900,180,380].map(ms=>'--nd-component-relationship-journal-duration'+ms+':'+(ms*animationScale)+'ms!important').join(';');return html.replace('</head>','<style>.wj-journal{'+overrides+'}</style></head>');}};
const vite=await createServer({configFile:fileURLToPath(new URL('../renderer/vite.config.ts',import.meta.url)),plugins:[motionPreview],server:{host:'127.0.0.1',port:uiPort,strictPort:true,proxy},clearScreen:false});await vite.listen();
process.stdout.write('Isolated relationship preview: http://127.0.0.1:'+uiPort+'/?token='+token+'&preview=1#/roles\nMemory fixture only; no Core, QQ, model or real user data.\n');
if(animationScale>1)process.stdout.write('Animation time scale x'+animationScale+' (verification only).\n');
async function close(){for(const client of clients)client.end();await vite.close();server.close();}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
