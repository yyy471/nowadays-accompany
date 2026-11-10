import os, subprocess, re, json, uuid, shutil
from pathlib import Path
root=Path('backend/test-results/fix-231-desktop').resolve()
root.mkdir(parents=True, exist_ok=True)
build=root/'renderer'
shutil.copytree(Path('desktop/desk-preview/renderer/dist'), build, dirs_exist_ok=True)
text=(build/'index.html').read_text(encoding='utf-8')
text=re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', '', text)
fixture=r"""<script>
const query=new URLSearchParams(location.search), testCase=query.get('review');
localStorage.setItem('nowadays-dialogue-scene','1');localStorage.setItem('nowadays-dialogue-voice','0');
const aDate='2026-11-09T03:00:00.000Z';
const role={roleId:'r',displayName:'复核角色',defaultWindowId:'w',initStatus:'ready'};
const windowRow={windowId:'w',roleId:'r',kind:'main',source:'nowadays',createdAt:aDate,updatedAt:aDate};
const message=(id,sender,content,sequence)=>({messageId:id,windowId:'w',sender,content,sequence,sourcePlatform:'nowadays',status:'completed',createdAt:aDate,updatedAt:aDate});
const seg=(id,text,ordinal=0)=>({segmentId:id,messageId:'reply',windowId:'w',ordinal,kind:'speech',text,startOffset:0,endOffset:text.length,outfitId:null,spriteAssetId:null,annotatedAt:null,createdAt:aDate});
const old=message('reply','assistant','已有台词',1), first=seg('speech-1','第一句',0), second=seg('speech-2','第二句',1);
const scene={taskId:'image',roleId:'r',windowId:'w',messageId:'reply',executionId:'e',trigger:'manual',layerMode:'full_scene',startSegmentId:first.segmentId,endSegmentId:second.segmentId,status:'succeeded',attempt:1,plan:null,errorCode:null,errorSummary:null,result:{assetId:'image-a',mediaType:'image/png',width:1,height:1,byteSize:80,createdAt:aDate},createdAt:aDate,updatedAt:aDate};
const sendAudio=[];
class FakeAudio {
 constructor(src){this.src=src;this.index=sendAudio.length;this.pauses=0;sendAudio.push(this)}
 play(){if(this.index===1 && testCase==='audio')return Promise.reject(Error('模拟播放失败'));if(this.index===1 && (testCase==='audio-success' || testCase==='audio-cancel'))return new Promise(resolve=>{this.start=()=>{this.onplaying?.();resolve()}});this.onplaying?.();return Promise.resolve()}
 pause(){this.pauses++}
}
window.Audio=FakeAudio;window.qaAudio=sendAudio;
const streams=new Set(); let seq=0;
window.EventSource=class { static CLOSED=2; constructor(){this.readyState=1;streams.add(this);setTimeout(()=>this.onopen?.(),10)} addEventListener(name,fn){this.handler=fn} close(){streams.delete(this);this.readyState=2} };
function push(type,payload){const data=JSON.stringify({type,streamEventId:++seq,...payload});for(const stream of streams)stream.handler?.({data})}
const nativeFetch=window.fetch.bind(window);
window.fetch=async (url,init)=>{
 const p=new URL(url,location.href).pathname.replace(/^\/[A-Za-z]:/,'');
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 if(p==='/api-config.json')return json({});
 if(p==='/v1/roles')return json({items:[role]});
 if(p==='/v1/roles/r')return json(role);
 if(p.endsWith('/state'))return json({stateVersion:1,state:{}});
 if(p.endsWith('/appearance/outfits'))return json({items:[]});
 if(p.endsWith('/windows'))return json({items:[windowRow]});
 if(p.endsWith('/voice'))return json({voice:{updatedAt:aDate}});
 if(p.endsWith('/speech'))return new Response(new Uint8Array([1,2,3]),{status:200});
 if(p.endsWith('/messages')&&init?.method==='POST'){
   const user=message('u','user','你好',1);
   setTimeout(()=>push('execution_started',{executionId:'e',triggerType:'user_message',messageIds:['u']}),35);
   if(testCase!=='legacy')setTimeout(()=>push('message_segments',{executionId:'e',replyMessageId:'reply',partial:true,segments:[seg('temporary','旧句段')]}),75);
   setTimeout(()=>push('message_segments',{executionId:'e',replyMessageId:'reply',segments:testCase==='segments-more'?[seg('official','正式句段'),seg('official-next','下一句',1)]:[seg('official','正式句段')]}),150);
   setTimeout(()=>push('message_completed',{executionId:'e',replyMessageId:'reply'}),190);
   return json({message:user,duplicate:false},201);
 }
 if(p.endsWith('/messages'))return json({items:testCase.startsWith('segments')||testCase==='legacy'?[]:[old],segments:testCase.startsWith('segments')||testCase==='legacy'?[]:[first,second],nextAfter:null,nextBefore:null,activeReply:null,cursor:0,...(testCase==='legacy'?{}:{sceneImages:testCase==='scene'?[scene]:testCase==='scene-missing'?[{...scene,startSegmentId:'missing'}]:[]})});
 return nativeFetch(url,init);
};
</script>"""
runner=r"""<script>
(async()=>{
 const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const poll=async test=>{for(let i=0;i<200;i++){const v=test();if(v)return v;await pause(12)}throw Error('selector timed out')};
 const tap=el=>el.click();
 tap(await poll(()=>[...document.querySelectorAll('.ui-dock-item')].find(b=>b.textContent.includes('对话'))));
 const input=await poll(()=>document.querySelector('.dialogue-composer textarea'));
 await poll(()=>document.querySelector('.dialogue-connection[data-state=open]'));
 let evidence={};
 if(testCase.startsWith('segments') || testCase==='legacy'){
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'你好');
   input.dispatchEvent(new Event('input',{bubbles:true}));await pause(40);
   document.querySelector('.dialogue-composer').requestSubmit();
   await poll(()=>document.querySelector(testCase==='legacy'?'[data-segment-id="official"]':'[data-segment-id="temporary"]'));await pause(350);
   evidence={before:[...document.querySelectorAll('.dialogue-message.assistant')].map(n=>n.dataset.segmentId),inputVisible:!!document.querySelector('.dialogue-composer')};
   if(testCase==='legacy')evidence.sceneButton=[...document.querySelectorAll('button')].some(b=>b.textContent.includes('生成过场图'));
   if(testCase==='segments-more'){
     tap(await poll(()=>document.querySelector('.dialogue-next[aria-disabled=false]')));await pause(45);
     evidence.after={segments:[...document.querySelectorAll('.dialogue-message.assistant')].map(n=>n.dataset.segmentId),inputVisible:!!document.querySelector('.dialogue-composer')};
   }
 }else if(testCase==='audio' || testCase==='audio-success' || testCase==='audio-cancel'){
   const speakers=await poll(()=>document.querySelectorAll('.dialogue-speaker').length===2&&document.querySelectorAll('.dialogue-speaker'));
   tap(speakers[0]);await poll(()=>window.qaAudio.length===1&&speakers[0].getAttribute('aria-pressed')==='true');
   tap(speakers[1]);await poll(()=>window.qaAudio.length===2);await pause(45);
   evidence={firstPauses:window.qaAudio[0].pauses,firstSrcRetained:!!window.qaAudio[0].src,activeButtons:[...speakers].filter(x=>x.getAttribute('aria-pressed')==='true').length};
   if(testCase==='audio-success'){
     window.qaAudio[1].start();await pause(45);
     evidence.after={firstPauses:window.qaAudio[0].pauses,secondActive:speakers[1].getAttribute('aria-pressed')==='true'};
   } else if(testCase==='audio-cancel'){
     tap([...document.querySelectorAll('.ui-dock-item')].find(b=>b.textContent.includes('桌面')));await pause(50);
     window.qaAudio[1].start();await pause(45);
     evidence.after={firstPauses:window.qaAudio[0].pauses,candidatePauses:window.qaAudio[1].pauses,candidateSrcRetained:!!window.qaAudio[1].src};
   }
 }else if(testCase==='scene-missing'){
   await pause(120);
   evidence={anchored:[...document.querySelectorAll('.dialogue-message .dialogue-scene-chip')].filter(b=>b.textContent.includes('查看人物场景图')).length,unanchored:document.querySelector('[aria-label="未能定位句段的过场图"]')?.textContent.includes('查看人物场景图'),stage:document.querySelector('.dialogue-stage').dataset.scene};
 }else{
   await poll(()=>document.querySelector('.dialogue-stage[data-scene=full_scene]'));
   const chips=[...document.querySelectorAll('.dialogue-message .dialogue-scene-chip')].filter(b=>b.textContent.includes('查看人物场景图'));
   evidence={entrySegments:chips.map(b=>b.closest('[data-segment-id]').dataset.segmentId),before:document.querySelector('.dialogue-stage').dataset.scene};
   tap(document.querySelector('.dialogue-history-button'));await pause(90);
   evidence.after=document.querySelector('.dialogue-stage').dataset.scene;
   tap(await poll(()=>document.querySelector('.dialogue-snippet-card.front')));await pause(100);
   evidence.located={scene:document.querySelector('.dialogue-stage').dataset.scene,latestVisible:!document.querySelector('.dialogue-latest').hidden};
   tap(document.querySelector('.dialogue-latest'));await pause(90);
   evidence.returned=document.querySelector('.dialogue-stage').dataset.scene;
 }
 document.body.dataset.reviewResult=JSON.stringify(evidence);
})().catch(error=>{document.body.dataset.reviewResult=JSON.stringify({harnessError:error.message,body:document.body.innerText.slice(0,420)})});
</script>"""
qa=build/'review.html'
qa.write_text(text.replace('<head>','<head>'+fixture).replace('</body>',runner+'</body>'),encoding='utf-8')
chrome=r'C:\Program Files\Google\Chrome\Application\chrome.exe'
results={}
for case in ['segments','segments-more','audio','audio-success','audio-cancel','scene','scene-missing','legacy']:
 profile=root/('chrome-'+case+'-'+uuid.uuid4().hex[:8])
 try:
  p=subprocess.run([chrome,'--headless=new','--disable-gpu','--no-first-run','--allow-file-access-from-files','--window-size=1280,800',f'--user-data-dir={profile}','--virtual-time-budget=5800','--dump-dom',qa.as_uri()+f'?review={case}'],capture_output=True,timeout=25)
 finally:
  shutil.rmtree(profile, ignore_errors=True)
 match=re.search(rb"data-review-result=\"([^\"]*)\"",p.stdout)
 if not match: (root/f'{case}-debug.html').write_bytes(p.stdout)
 if not match: raise RuntimeError(f'{case} no DOM result: '+p.stderr.decode('utf-8','replace')[-700:])
 from html import unescape
 results[case]=json.loads(unescape(match[1].decode('utf-8')))
 print(case, json.dumps(results[case],ensure_ascii=False),flush=True)
(root/'findings.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
assert results['segments'] == {'before':['official'], 'inputVisible':True}, results['segments']
assert results['segments-more'] == {'before':['official'], 'inputVisible':False, 'after':{'segments':['official','official-next'],'inputVisible':True}}, results['segments-more']
assert results['audio'] == {'firstPauses':0, 'firstSrcRetained':True, 'activeButtons':1}, results['audio']
assert results['audio-success'] == {'firstPauses':0, 'firstSrcRetained':True, 'activeButtons':1, 'after':{'firstPauses':1,'secondActive':True}}, results['audio-success']
assert results['audio-cancel']['after']['firstPauses'] >= 1 and results['audio-cancel']['after']['candidatePauses'] >= 1 and not results['audio-cancel']['after']['candidateSrcRetained'], results['audio-cancel']
assert results['scene'] == {'entrySegments':['speech-1'], 'before':'full_scene', 'after':'full_scene', 'located':{'scene':'full_scene','latestVisible':True}, 'returned':'full_scene'}, results['scene']
assert results['scene-missing'] == {'anchored':0,'unanchored':True,'stage':''}, results['scene-missing']
assert results['legacy'] == {'before':['official'], 'inputVisible':True, 'sceneButton':False}, results['legacy']
