// Diagnostic only: uses fake adapters and a dedicated temporary directory.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../src/providers/config-store.ts';
import { PolicyService } from '../../src/policy/policy.ts';
import { ExtensionRegistry, SkillRuntime } from '../../src/extensions/registry.ts';
import { ProviderRouter } from '../../src/providers/router.ts';
import { MemoryCredentialVault } from '../../src/secrets/vault.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { FakeChannel } from '../../src/channels/fake.ts';
import { createCore } from '../../src/core/core.ts';
import { seedRoleCard, seedProfile } from '../helpers.ts';
import { accountPolicy, bind, TINY_PNG, writePhase1Config, textInbound, waitFor } from '../phase1-helpers.ts';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'accompany-second-review-'));
const conv={accountId:'10001',kind:'private' as const,peerId:'42'};
const log=(name:string,data:unknown)=>console.log(JSON.stringify({name,data}));
try {
  const p={id:'p',adapterId:'review',baseUrl:'https://old-cloud.example.test/v1',location:'cloud',models:[{id:'vision',capabilities:['image.understand'],input:['text','image']} ]};
  const policy=accountPolicy({allowedProviders:['p'],bindings:{'image.understand':bind('p','vision')},media:{allowCloudUpload:true}});
  await writePhase1Config(root,{providers:[p],accountPolicies:{'10001':policy}});
  const config=await ConfigStore.load({filePath:path.join(root,'config.v2.json')});
  const calls:unknown[]=[];
  const router=new ProviderRouter({config,policy:new PolicyService(config),skills:new SkillRuntime(()=>[]),extensions:new ExtensionRegistry(),vault:new MemoryCredentialVault(),logger:silentLogger('review'),adapters:[{
    id:'review',supports:()=>true,cancelMode:()=> 'localOnly',
    async imageUnderstand(ctx:any){calls.push({url:ctx.provider.baseUrl,location:ctx.provider.location});return {text:'observation'};}
  }]});
  const old=router.resolve('10001',conv,'image.understand',{media:'image'});
  await config.upsertProvider({...p,baseUrl:'http://127.0.0.1:8000/v1',location:'local'});
  await config.setAccountPolicy('10001',{...policy,media:{allowCloudUpload:false}});
  let staleCode='resolved';
  let staleReason='';
  try {
    await router.imageUnderstand('10001',conv,{mediaId:'m',accountId:'10001',mimeType:'image/png',bytes:TINY_PNG.length,kind:'image',data:TINY_PNG},'describe',new AbortController().signal,undefined,old);
  } catch (error) {
    staleCode=error instanceof Error && 'code' in error ? String((error as {code:unknown}).code) : String(error);
    staleReason=error instanceof Error && 'reason' in error ? String((error as {reason:unknown}).reason) : '';
  }
  log('validate_current_but_execute_old_endpoint',{current:config.provider('p')?.baseUrl,allowCloudUpload:false,staleCode,staleReason,calls});
  if(staleReason!=='execution_plan_stale'||calls.length!==0){process.exitCode=1;console.error('S1 not fixed: stale plan was executed');}
  await config.dispose();

  const appRoot=path.join(root,'core');
  await seedRoleCard(appRoot); await seedProfile(appRoot,'10001');
  const pluginDir=path.join(appRoot,'public','artifacts','plugin','echo','r1');
  await fs.mkdir(pluginDir,{recursive:true});
  await fs.writeFile(path.join(pluginDir,'manifest.json'),JSON.stringify({id:'echo',kind:'plugin',revision:'r1',entry:'echo.mjs',apiVersion:1}));
  await fs.writeFile(path.join(pluginDir,'echo.mjs'),"export function onMessage(){return 'legacy plugin still replies';}");
  await fs.writeFile(path.join(appRoot,'public','catalog.json'),JSON.stringify({version:1,artifacts:{'role-card:default':'r1','plugin:echo':'r1'}}));
  await fs.writeFile(path.join(appRoot,'accounts','10001','profile.json'),JSON.stringify({version:1,roleCard:{source:'public',id:'default'},plugins:[{source:'public',id:'echo'}]}));
  await writePhase1Config(appRoot,{providers:[],accountPolicies:{'10001':accountPolicy({replyMode:'plugins',agentEnabled:true})}});
  let channel:FakeChannel;
  const core=await createCore({dataRoot:appRoot,instances:[{id:'a',backend:'fake',accountId:'10001'}],logger:silentLogger('review'),channelFactory:ctx=>(channel=new FakeChannel(ctx,{selfId:'10001'}))});
  try {
    await core.start();
    await core.patchAgentEnabled('10001',false);
    channel!.emitInbound(textInbound('a','10001','42','paused-message','hello'));
    await waitFor(async()=>(await core.readMessages('10001',conv)).length>0);
    await new Promise((resolve)=>setTimeout(resolve,300));
    const stored=await core.readMessages('10001',conv);
    log('paused_legacy_plugin',{configuredAgentEnabled:core.policy.resolveAccount('10001').agentEnabled,storedMessages:stored.length,replies:channel!.sent.length});
    if(channel!.sent.length!==0){process.exitCode=1;console.error('S2 not fixed: paused plugin replied');}
  } finally { await core.stop(); }
} finally {
  if(!path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)) throw new Error('Unexpected temporary directory');
  await fs.rm(root,{recursive:true,force:true});
}
