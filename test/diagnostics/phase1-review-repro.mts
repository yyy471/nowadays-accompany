// Review regression diagnostic, not an acceptance test. Exit 0 means the scenarios ran;
// the JSON output below shows the expected post-fix behavior for R1-R7.
// Uses fake adapters/HTTP responses and a dedicated OS temporary directory only.
// Run from the project root: .\node_modules\.bin\tsx.cmd test/diagnostics/phase1-review-repro.mts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../../src/providers/config-store.ts';
import { PolicyService } from '../../src/policy/policy.ts';
import { ExtensionRegistry, SkillRuntime } from '../../src/extensions/registry.ts';
import { ProviderRouter } from '../../src/providers/router.ts';
import { parseAccountPolicy } from '../../src/providers/types.ts';
import { MemoryCredentialVault } from '../../src/secrets/vault.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { ProviderError } from '../../src/providers/errors.ts';
import { MediaJobService } from '../../src/jobs/service.ts';
import { MediaService } from '../../src/media/service.ts';
import { FakeChannel } from '../../src/channels/fake.ts';
import { createCore } from '../../src/core/core.ts';
import { seedRoleCard, seedProfile, bindTestConversation } from '../helpers.ts';
import { accountPolicy, bind, TINY_PNG, writePhase1Config, textInbound, waitFor } from '../phase1-helpers.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accompany-review-'));
const log = (name: string, data: unknown) => console.log(JSON.stringify({ name, data }));
try {
  const providers = [{ id: 'p', adapterId: 'review', baseUrl: 'http://127.0.0.1:9', location: 'local', models: [
    {id: 'primary', capabilities: ['image.generate'], input: ['text']},
    {id: 'backup', capabilities: ['image.generate'], input: ['text']}
  ] }];
  const policy = accountPolicy({ allowedProviders: ['p'], bindings: { 'image.generate': bind('p', 'primary', { fallback: [{providerId:'p', modelId:'backup'}] }) } });
  const configRoot = path.join(root, 'router');
  await writePhase1Config(configRoot, { providers, accountPolicies: {'10001': policy} });
  const config = await ConfigStore.load({filePath:path.join(configRoot, 'config.v2.json')});
  const ps = new PolicyService(config);
  const ex = new ExtensionRegistry();
  const called: string[] = [];
  let failPrimary = true;
  const router = new ProviderRouter({config, policy:ps, skills:new SkillRuntime(()=>[]), extensions:ex,
    vault:new MemoryCredentialVault(), logger:silentLogger('review'), adapters:[{
      id:'review', supports:()=>true, cancelMode:()=> 'none',
      async imageGenerate(ctx: any) { called.push(ctx.model.id); if(failPrimary && ctx.model.id==='primary') throw new ProviderError('provider_generate_unknown','remote accepted but response unknown',{providerId:'p',capability:'image.generate',retryable:false}); return {images:[{data:TINY_PNG,mimeType:'image/png'}]}; }
    }]});
  const conv = {accountId:'10001',kind:'private' as const,peerId:'42'};
  try {
    await router.imageGenerate('10001',conv,{prompt:'a dot'},new AbortController().signal);
    log('unknown_generation_fallback', {error:null,called});
  } catch (error) {
    log('unknown_generation_fallback', {error:(error as {code?:string}).code ?? String(error),called});
  }
  failPrimary = false;
  const oldResolution = router.resolve('10001',conv,'image.generate');
  await config.setAccountPolicy('10001',accountPolicy({allowedProviders:[],capabilities:{'image.generate':false}}));
  called.length=0;
  try {
    await router.imageGenerate('10001',conv,{prompt:'a dot'},new AbortController().signal,undefined,oldResolution);
    log('revoked_authorization_cached_resolution', {error:null,currentEnabled:router.resolve('10001',conv,'image.generate').enabled,called});
  } catch (error) {
    log('revoked_authorization_cached_resolution', {error:(error as {reason?:string}).reason ?? String(error),currentEnabled:router.resolve('10001',conv,'image.generate').enabled,called});
  }
  await Promise.all([
    config.setAccountPolicy('20001',accountPolicy({agentEnabled:false})),
    config.setAccountPolicy('20002',accountPolicy({agentEnabled:false}))
  ]);
  log('concurrent_config_updates',{has20001:Boolean(config.accountPolicy('20001')),has20002:Boolean(config.accountPolicy('20002'))});

  const jobs = new MediaJobService({accountDir:id=>path.join(root,'jobs',id)});
  const input = {accountId:'10001',conversation:conv,capability:'image.generate' as const,turnId:'t',sessionEpoch:1,cancelMode:'none' as const,actionId:'same-action',executor:async()=>({text:'done'})};
  const result = await Promise.all([jobs.submit(input),jobs.submit(input)]);
  log('concurrent_same_action',{duplicates:result.map(r=>r.duplicate),jobIds:result.map(r=>r.job.id)});
  await jobs.dispose();

  const skills = new SkillRuntime(()=>[{id:'personal',name:'Personal',instructions:'public instructions',tools:[]}]);
  const configSkills = config.snapshot();
  configSkills.accountPolicies = {
    '10001': parseAccountPolicy(accountPolicy({skills:{definitions:[{id:'personal',name:'Personal A',instructions:'A only',tools:[]}]}}),'review.skills.10001'),
    '10002': parseAccountPolicy(accountPolicy({skills:{disabled:['personal']}}),'review.skills.10002')
  };
  const skillAccounts = ['10001','10002'].map(id=>{
    const resolution = skills.resolve(ps.resolveWithConfig(configSkills,id,{...conv,accountId:id}),()=>true,new Set());
    return {id,available:resolution.available.map(s=>({id:s.id,source:s.source,instructions:s.instructions})),unavailable:resolution.unavailable.map(s=>({id:s.id,reason:s.reason}))};
  });
  log('skills_account_enable_set',skillAccounts);

  const media = new MediaService({accountDir:id=>path.join(root,'media',id),maxDownloadMs:15,
    fetchImpl: async (_url: any, init: any) => new Response(new ReadableStream({start(controller){
      const timer=setTimeout(()=>{controller.enqueue(TINY_PNG);controller.close();},100);
      init.signal.addEventListener('abort',()=>{clearTimeout(timer);controller.error(new Error('aborted'));},{once:true});
    }}),{status:200,headers:{'content-type':'image/png'}}) });
  const start = Date.now();
  try {
    const refs = await media.ingestInbound('10001',conv,{...textInbound('a','10001','42','m',''),segments:[{type:'image',data:{file:'https://93.184.216.34/image.png'}}]});
    log('body_download_timeout',{limitMs:15,elapsedMs:Date.now()-start,succeeded:refs.length===1});
  } catch (error) {
    log('body_download_timeout',{limitMs:15,elapsedMs:Date.now()-start,succeeded:false,error:(error as {code?:string}).code ?? String(error)});
  }
  await media.dispose();

  const appRoot = path.join(root,'core');
  await seedRoleCard(appRoot); await seedProfile(appRoot,'10001');
  const pluginDir=path.join(appRoot,'public','artifacts','plugin','echo','r1');
  await fs.mkdir(pluginDir,{recursive:true});
  await fs.writeFile(path.join(pluginDir,'manifest.json'),JSON.stringify({id:'echo',kind:'plugin',revision:'r1',entry:'echo.mjs',apiVersion:1}));
  await fs.writeFile(path.join(pluginDir,'echo.mjs'),"export function onMessage(){return 'plugin reply';}");
  await fs.writeFile(path.join(appRoot,'public','catalog.json'),JSON.stringify({version:1,artifacts:{'role-card:default':'r1','plugin:echo':'r1'}}));
  await fs.writeFile(path.join(appRoot,'accounts','10001','profile.json'),JSON.stringify({version:1,roleCard:{source:'public',id:'default'},plugins:[{source:'public',id:'echo'}]}));
  const cp=accountPolicy({allowedProviders:['chat'],replyMode:'agent',bindings:{chat:bind('chat','text-model')}});
  await writePhase1Config(appRoot,{providers:[{id:'chat',adapterId:'fake-v1',baseUrl:'http://127.0.0.1:9',location:'local',models:[{id:'text-model',capabilities:['chat'],input:['text']}],options:{chatText:'agent reply'}}],accountPolicies:{'10001':cp}});
  let channel: FakeChannel;
  const core=await createCore({dataRoot:appRoot,instances:[{id:'a',backend:'fake',accountId:'10001'}],logger:silentLogger('review'),channelFactory:ctx=>(channel=new FakeChannel(ctx,{selfId:'10001'}))});
  try {
    await bindTestConversation(core,'10001','private','42');
    await core.start();
    await core.setAccountPolicy('10001',{...cp,replyMode:'plugins'});
    channel!.emitInbound(textInbound('a','10001','42','mode-message','hello'));
    await waitFor(()=>channel!.sent.length>0);
    log('agent_to_plugins_switch',{configuredMode:core.policy.resolveAccount('10001').replyMode,reply:channel!.sent[0]?.message.segments,instanceAgent:core.status().instances[0]?.agent});
  } finally {await core.stop();}
} finally {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected review temporary directory');
  await fs.rm(root,{recursive:true,force:true});
}
