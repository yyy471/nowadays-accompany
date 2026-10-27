// Explicit development fixture host. Actual renderer, memory-only API; never imports Core/preload.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const apiPort=Number(process.env.HOME_FIXTURE_PORT||50321), uiPort=Number(process.env.HOME_PREVIEW_PORT||50320);
const policy=enabled=>({agentEnabled:enabled,allowedProviders:[],crossProviderFallback:false,media:{allowCloudUpload:false},capabilities:{},bindings:{},byKind:{},byConversation:{}});
const account=(id,name,signature='')=>({accountId:id,nickname:name,signature,dir:`fixture/${id}`,state:'ready',slots:[`fixture-${id}`]});
const initial=()=>({accounts:[account('10001','白昼来信','把小事慢慢说，把普通的日子认真过。'),account('10002','晚风电台','今天也想听你说说话。')],policies:{10001:policy(true),10002:policy(false)},flags:{},requests:[]});
let state=initial();
const clients=new Set();
const reply=(response,status,value)=>{response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(value));};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms||0));
const server=http.createServer(async(request,response)=>{
  try {
    const url=new URL(request.url,'http://127.0.0.1'), path=url.pathname;
    if(path==='/events'){
      response.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
      response.write(`id: 1\nevent: preview.ready\ndata: {"at":${Date.now()}}\n\n`);clients.add(response);
      const heartbeat=setInterval(()=>response.write(': preview\n\n'),10000);request.on('close',()=>{clearInterval(heartbeat);clients.delete(response);});return;
    }
    let text='';for await(const chunk of request){text+=chunk;if(text.length>1000000){reply(response,413,{error:'fixture body too large'});return;}}
    const body=text?JSON.parse(text):undefined;
    if(path==='/__fixture/reset'){state=initial();reply(response,200,{ok:true});return;}
    if(path==='/__fixture/control'){if(body.accounts)state.accounts=body.accounts;if(body.flags)state.flags={...state.flags,...body.flags};reply(response,200,{ok:true});return;}
    if(path==='/__fixture/state'){reply(response,200,state);return;}
    state.requests.push({method:request.method,path,body});if(state.requests.length>2000)state.requests.shift();
    if(request.headers.authorization!=='Bearer home-preview'){reply(response,401,{error:'Isolated preview token required'});return;}
    const fail=message=>reply(response,503,{error:message,code:'fixture_failure',retryable:true});
    if(path==='/accounts'){await wait(state.flags.accountsDelay);if(state.flags.failAccounts){fail('样例账号读取失败');return;}reply(response,200,{ok:true,accounts:state.accounts});return;}
    if(path==='/slots'){
      if(state.flags.failSlots){fail('样例连接状态读取失败');return;}
      reply(response,200,{ok:true,specs:[],resumable:[],slots:state.accounts.map(item=>({id:`fixture-${item.accountId}`,accountId:item.accountId,backend:'fake',state:state.flags.offline?'stopped':'online',connected:!state.flags.offline,selfIds:[item.accountId],restartAttempts:0}))});return;
    }
    const match=/^\/accounts\/([^/]+)\/(policy|agent|role-bindings|display|artifacts|effective|extensions|skills)$/.exec(path);
    if(match){
      const [,id,kind]=match;
      if(!state.accounts.some(item=>item.accountId===id)){reply(response,404,{error:'样例账号不存在'});return;}
      if(kind==='agent'){
        await wait(state.flags.agentDelay);
        if(state.flags.agentFailure){fail('样例暂停请求失败');return;}
        state.policies[id]=policy(body.enabled);
        if(state.flags.agentUnknown){response.destroy();return;}
        reply(response,200,{ok:true,policy:state.policies[id]});return;
      }
      if(kind==='policy'){
        const captured=structuredClone(state.policies[id]??policy(true));await wait(state.flags.policyDelay?.[id]);
        if(state.flags.failPolicy?.includes(id)){fail('样例策略读取失败');return;}
        reply(response,200,{ok:true,policy:captured});return;
      }
      if(kind==='role-bindings'){
        await wait(state.flags.bindingDelay?.[id]);if(state.flags.failBindings?.includes(id)){fail('样例绑定读取失败');return;}
        reply(response,200,{ok:true,bindings:state.flags.noBindings?[]:[
          {accountId:id,kind:'group',peerId:'42',roleCard:{source:'public',id:id==='10001'?'xiacheng':'yue',revision:'r1'},revision:'binding-1',updatedAt:Date.now(),state:'ready',cardName:id==='10001'?'夏澄':'阿遥',resolvedRevision:'r1',worldbookEntryCount:0},
          {accountId:id,kind:'private',peerId:'42',roleCard:{source:'public',id:'xu',revision:'r1'},revision:'binding-2',updatedAt:Date.now(),state:'ready',cardName:'阿序',resolvedRevision:'r1',worldbookEntryCount:0}
        ]});return;
      }
      if(kind==='display'){
        const item=state.accounts.find(item=>item.accountId===id);
        if(request.method==='PUT'){item.nickname=body.nickname;item.signature=body.signature;}
        reply(response,200,{ok:true,display:{nickname:item.nickname,signature:item.signature,avatarDataUrl:item.avatarDataUrl}});return;
      }
      if(kind==='artifacts'){reply(response,200,{ok:true,artifacts:[]});return;}
      if(kind==='effective'){reply(response,200,{ok:true,effective:{accountId:id,conversation:{accountId:id,kind:url.searchParams.get('kind')||'private',peerId:url.searchParams.get('peerId')||'0'},agentEnabled:state.policies[id]?.agentEnabled!==false,agentSource:'account',visionMode:'external',visionSource:'default',allowCloudUpload:false,capabilities:[],skills:{available:[],unavailable:[]}}});return;}
      reply(response,503,{error:'本隔离样例不模拟扩展编辑接口'});return;
    }
    if(path==='/artifacts'){
      reply(response,200,{ok:true,current:{'role-card:xiacheng':'r1','role-card:yue':'r1','role-card:xu':'r1'},artifacts:[['xiacheng','夏澄'],['yue','阿遥'],['xu','阿序']].map(([id,name])=>({ref:{source:'public',id,revision:'r1'},manifest:{id,name,kind:'role-card',revision:'r1',content:'明确标记的角色资源样例。'}}))});return;
    }
    if(path==='/providers'){reply(response,200,{ok:true,providers:[],credentialStore:{kind:'preview',available:false}});return;}
    if(path==='/worldbooks'){reply(response,200,{ok:true,items:[]});return;}
    if(path==='/skills'){reply(response,200,{ok:true,revision:'preview',skills:[]});return;}
    if(path==='/injection/settings'){reply(response,200,{ok:true,settings:{version:1,resumeLastListen:false}});return;}
    if(path==='/injection/runtime'){reply(response,200,{ok:true,runtime:{configured:false,running:false,authenticated:false,passwordConfigured:false,consentRequired:false,autoLoadEnabled:false,autoLoadKnown:true,owner:'none',compatible:false,supportedVersion:'preview',startupState:'unconfigured'}});return;}
    if(path==='/injection/processes'){reply(response,200,{ok:true,processes:[]});return;}
    reply(response,404,{error:`隔离预览未模拟此接口：${path}`});
  }catch(error){if(!response.headersSent)reply(response,500,{error:String(error)});else response.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(apiPort,'127.0.0.1',resolve);});
const proxy=Object.fromEntries(['/accounts','/slots','/artifacts','/providers','/injection','/events','/skills','/worldbooks','/__fixture'].map(path=>[path,{target:`http://127.0.0.1:${apiPort}`} ]));
const vite=await createServer({configFile:fileURLToPath(new URL('../renderer/vite.config.ts',import.meta.url)),server:{host:'127.0.0.1',port:uiPort,strictPort:true,proxy},clearScreen:false});
await vite.listen();
process.stdout.write(`Isolated homepage preview: http://127.0.0.1:${uiPort}/?token=home-preview&preview=1#/home\nMemory-only fixture API; no product Core, QQ, models or user data.\n`);
async function close(){for(const client of clients)client.end();await vite.close();server.close();}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});
