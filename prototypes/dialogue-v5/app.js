(function(){
'use strict';
const D=DialogueDemo3,$=id=>document.getElementById(id),root=document.documentElement,query=new URLSearchParams(location.search);
const scroller=$('messages'),draft=$('draft'),historyPanel=$('history-panel'),assetDialog=$('asset-dialog'),stage=$('stage'),themeSwitch=document.querySelector('.theme-switch');
const media=matchMedia('(prefers-reduced-motion: reduce)'),reduced=()=>root.dataset.motion==='reduced'||media.matches;
const messageNodes=new Map(),layers=new D.LayerStore(),ownedUrls=new Set(),dayButtons=new Map();
const layerVersions={background:0,character:0},layerTimers={background:null,character:null};
let state,follow=true,historyLock=false,hasNew=false,composing=false,historyOpen=false,historyVersion=0,historyCloseTimer=null,historyOpener=null;
let lastDay='',cueTimer=null,noticeTimer=null,locateTimer=null,toastTimer=null,located=null,pickerVersion=0,pickerOpener=null,fileLoading=false;
let sceneTarget=null,scenePreview=null,visibleScene=null,manualSpriteAt=null;
const dismissedScenes=new Set();
const voice={pending:null,active:null,timer:null};
/* History model: one selected day, one front card, an optional message-level hit cursor. */
let selectedKey='',cardIndex=0,cards=[],hits=[],hitIndex=-1,timelineSig='',cardsSig='',swipe=null,suppressClick=false,pulseTimer=null,instantPalette=false;
const make=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
function icon(name){const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#'+name);svg.append(use);svg.setAttribute('aria-hidden','true');return svg;}
function announce(text){$('announcer').textContent=text;}
function time(timestamp){return new Date(timestamp).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23'});}
function dateCaption(key){const today=D.dayKey(Date.now());return(key===today?'今天 · ':'')+D.dateLabel(key);}
const WEEK='日一二三四五六';
function updateLatest(){const b=$('latest-button');b.hidden=follow;b.classList.toggle('has-new',hasNew);}
function createMessage(row, live) {
 const key=D.dayKey(row.createdAt);
 if(key!==lastDay){scroller.append(make('div','date-divider',dateCaption(key)));lastDay=key;}
 const article=make('article',`message ${row.role}`);
 article.dataset.messageId=row.messageId;
 article.dataset.segmentId=row.segmentId;
 article.setAttribute('aria-label',`${row.role==='user'?'你':'夏澄'}，${dateCaption(key)} ${time(row.createdAt)}`);
 let speaker=null;
 if(row.action){
  const action=make('div',`stage-direction${live&&!reduced()?' is-revealing':''}`);
  const line=make('span','cue-line');line.setAttribute('aria-hidden','true');
  action.append(line,make('span','sr-only','动作：'),make('span','cue-text',row.action));
  article.append(action);
 }else{
  const speech=make('div','speech-line');
  const bubble=make('div',`bubble${live?' first-ink':''}`);
  bubble.append(make('p','message-text',row.text));
  speech.append(bubble);
  if(row.role==='assistant'){
   speaker=make('button','icon-button line-speaker');
   speaker.type='button';speaker.title='播放这句';
   speaker.setAttribute('aria-label',`播放这句：${row.text.slice(0,28)}`);
   speaker.append(icon('speaker'));
   speaker.addEventListener('click',()=>playSpeech(row,false));
   speech.append(speaker);
  }
  article.append(speech);
 }
 if(row.status==='interrupted')article.append(make('div','message-status','未说完'));
 const tools=make('div','round-tools');tools.hidden=true;
 const stamp=make('time','message-time',time(row.createdAt));
 stamp.title=`${dateCaption(key)} ${time(row.createdAt)}`;
 article.append(tools,stamp);scroller.append(article);
 const parts={article,speaker,tools,toolsKey:''};messageNodes.set(row.id,parts);return parts;
}

function updateVoiceButtons(){
 for(const [id,parts] of messageNodes){
  if(!parts.speaker)continue;
  const playing=voice.active?.rowId===id;
  parts.speaker.classList.toggle('is-playing',playing);
  parts.speaker.setAttribute('aria-pressed',String(playing));
 }
}
function cancelPendingVoice(){clearTimeout(voice.timer);voice.pending=null;}
function playSpeech(row, automatic){
 cancelPendingVoice();
 if(!('speechSynthesis' in window)||!('SpeechSynthesisUtterance' in window)){
  if(!automatic)toast('这台设备暂时无法使用本地朗读。');
  return;
 }
 const pending={row,automatic};voice.pending=pending;
 voice.timer=setTimeout(()=>{
  if(voice.pending!==pending)return;
  voice.pending=null;
  const synth=window.speechSynthesis;
  const chinese=synth.getVoices().find(item=>item.localService&&/^zh(?:[-_]|$)/i.test(item.lang));
  if(!chinese){if(!automatic)toast('本机没有可用的中文朗读音色。');return;}
  const clip=new SpeechSynthesisUtterance(row.text);
  clip.voice=chinese;clip.lang=chinese.lang;
  const active={clip,rowId:row.id};
  const finish=()=>{if(voice.active!==active)return;voice.active=null;updateVoiceButtons();};
  clip.onstart=()=>{if(voice.active===active)updateVoiceButtons();};
  clip.onend=finish;
  clip.onerror=()=>{if(voice.active!==active)return;finish();if(!automatic)toast('这句语音暂时播不出来。');};
  voice.active=active;synth.cancel();synth.speak(clip);updateVoiceButtons();
 },automatic?220:0);
}

function sceneLabel(mode){return mode==='background'?'背景图':'人物场景图';}
function updateRoundTools(roundRows){
 const scenesByRound=new Map();
 for(const scene of state.scenes){
  const list=scenesByRound.get(scene.messageId)??[];list.push(scene);scenesByRound.set(scene.messageId,list);
 }
 for(const row of state.messages){
  if(row.role!=='assistant')continue;
  const parts=messageNodes.get(row.id);
  const canDraw=roundRows.get(row.messageId)===row.id&&state.availableRounds.has(row.messageId);
  const scenes=(scenesByRound.get(row.messageId)??[]).filter(scene=>scene.start===row.ordinal);
  const key=JSON.stringify([canDraw,scenes.map(scene=>[scene.id,scene.status])]);
  if(parts.toolsKey===key)continue;
  parts.toolsKey=key;parts.tools.replaceChildren();
  parts.tools.hidden=!canDraw&&!scenes.length;
  for(const scene of scenes){
   if(scene.status==='generating'){
    const label=make('span','scene-pending',`${sceneLabel(scene.mode)}生成中…`);label.setAttribute('role','status');parts.tools.append(label);continue;
   }
   if(scene.status==='failed'){
    const label=make('span','scene-pending',`${sceneLabel(scene.mode)}生成失败`);label.setAttribute('role','status');parts.tools.append(label);continue;
   }
   const view=make('button','text-button scene-chip',`查看${sceneLabel(scene.mode)}`);
   view.type='button';view.addEventListener('click',()=>{scenePreview=scene;updateStage();$('scene-dismiss').focus({preventScroll:true});});
   parts.tools.append(view);
  }
  if(canDraw){
   const draw=make('button','text-button scene-chip','生成过场图');
   draw.type='button';draw.setAttribute('aria-haspopup','dialog');
   draw.prepend(icon('image'));
   draw.addEventListener('click',()=>{sceneTarget=row.messageId;$('scene-dialog').showModal();});
   parts.tools.append(draw);
  }
 }
}

function updateStage(){
 const row=state.current;
 const reviewing=!follow||historyOpen||historyLock;
 const candidate=reviewing
  ? (visibleScene&&!dismissedScenes.has(visibleScene.id)?visibleScene:null)
  : row&&state.scenes.findLast(scene=>scene.status==='succeeded'&&scene.messageId===row.messageId&&
    scene.start<=row.ordinal&&row.ordinal<=scene.end&&!dismissedScenes.has(scene.id));
 const scene=scenePreview??candidate;
 if(visibleScene?.id===scene?.id)return;
 visibleScene=scene;
 const full=scene?.mode==='full_scene';
 stage.dataset.scene=scene?.mode??'';
 $('scene-cover').hidden=!scene;$('scene-dismiss').hidden=!scene;
 $('scene-figure').hidden=!full;
 if(scene){
  $('scene-background').src=D.PRESETS.background[1].src;
  if(full)$('scene-figure').src=D.PRESETS.character[1].src;
 }
}
function revealSprite(row){
 if(!row||row.id===manualSpriteAt||!follow||historyOpen)return;
 const image=$('performance-sprite');
 const pose=state.messages.findLast(item=>item.messageId===row.messageId&&item.sprite)?.sprite;
 const sprite=D.PRESETS.character.find(item=>item.id===pose);
 if(!sprite||(!image.hidden&&image.getAttribute('src')===sprite.src))return;
 const segmentId=row.segmentId;
 const next=new Image();
 next.onload=()=>{
  if(state.current?.segmentId!==segmentId||manualSpriteAt===row.id)return;
  image.src=sprite.src;image.alt=sprite.label;image.hidden=false;stage.dataset.sprite='automatic';
 };
 next.src=sprite.src;
}

function render(snapshot,event={reason:'initial'}){
 const wasAdvancing=state?.activeId!=null;state=snapshot;
 const roundRows=new Map();
 for(const row of state.messages){
  if(!messageNodes.has(row.id))createMessage(row,event.id===row.id);
  if(row.role==='assistant')roundRows.set(row.messageId,row.id);
 }
 updateRoundTools(roundRows);updateVoiceButtons();
 const advancing=state.activeId!==null;
 $('composer').hidden=advancing;$('turn-controls').hidden=!advancing;
 $('next-segment').setAttribute('aria-disabled',String(!state.canAdvance));
 $('turn-status').textContent=state.canAdvance?'继续这轮对话':state.current?'下一句还在准备…':'等她开口…';
 $('reply-error').textContent=state.error;$('reply-error').hidden=!state.error;
 root.dataset.generating=String(advancing);
 if(event.reason==='segment'){
  const row=event.row;scenePreview=null;
  if(voice.pending?.automatic)cancelPendingVoice();
  revealSprite(row);
  if(row.text&&$('voice-auto').checked&&!historyOpen&&follow)playSpeech(row,true);
  if(row.action&&!reduced()&&!lighting?.busy){clearTimeout(cueTimer);stage.classList.remove('cue');void stage.offsetWidth;stage.classList.add('cue');cueTimer=setTimeout(()=>stage.classList.remove('cue'),760);}
  announce(row.action||row.text);
 }else if(event.reason==='send'){
  scenePreview=null;
  if(voice.pending?.automatic)cancelPendingVoice();
  announce('消息已发送，等她开口。');
 }
 if(wasAdvancing&&!advancing&&!historyOpen&&follow&&
    (document.activeElement===$('next-segment')||document.activeElement===document.body))draft.focus({preventScroll:true});
 if(follow)scroller.scrollTop=scroller.scrollHeight;else if(event.reason==='send'||event.reason==='segment')hasNew=true;
 updateStage();updateLatest();if(historyOpen)refreshHistory();
}
let lighting=null;
const engine=new DialoguePerformance({scenario:query.get('scenario'),empty:query.get('empty')==='1',onChange:render});
function preference(name){try{return localStorage.getItem(`dialogue-v5-${name}`)==='1';}catch{return false;}}
function savePreference(name,value){try{localStorage.setItem(`dialogue-v5-${name}`,value?'1':'0');}catch{}}
$('voice-auto').checked=query.has('voice')?query.get('voice')==='1':preference('voice');
$('scene-auto').checked=query.has('scene')?query.get('scene')==='1':preference('scene');engine.autoScene=$('scene-auto').checked;
render(engine.snapshot());
function draftChanged(){const send=$('send-button');send.disabled=!draft.value.trim();send.setAttribute('aria-disabled',String(send.disabled));draft.style.height='';const min=innerWidth<=760?(innerHeight<=700?32:41):46;draft.style.height=Math.min(innerWidth<=760?76:92,Math.max(min,draft.scrollHeight))+'px';}
function sendDraft(){if(composing||!draft.value.trim())return;historyLock=false;follow=true;hasNew=false;if(!engine.send(draft.value))return;draft.value='';draftChanged();$('next-segment').focus({preventScroll:true});}
$('composer').addEventListener('submit',e=>{e.preventDefault();sendDraft();});draft.addEventListener('input',draftChanged);draft.addEventListener('compositionstart',()=>{composing=true;});draft.addEventListener('compositionend',()=>{composing=false;draftChanged();});draft.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!composing&&e.keyCode!==229){e.preventDefault();if(!e.repeat)sendDraft();}});
$('next-segment').addEventListener('click',()=>{if(!state.canAdvance)return;historyLock=false;follow=true;hasNew=false;engine.advance();});
$('performance-settings').addEventListener('click',()=>$('performance-dialog').showModal());
$('voice-auto').addEventListener('change',()=>{savePreference('voice',$('voice-auto').checked);if(!$('voice-auto').checked&&voice.pending?.automatic)cancelPendingVoice();});
$('scene-auto').addEventListener('change',()=>{engine.autoScene=$('scene-auto').checked;savePreference('scene',engine.autoScene);});
$('scene-dialog').addEventListener('click',event=>{
 const mode=event.target.closest('[data-scene-mode]')?.dataset.sceneMode;
 if(mode&&sceneTarget){engine.requestScene(sceneTarget,mode);$('scene-dialog').close();}
});
$('scene-dismiss').addEventListener('click',()=>{if(visibleScene)dismissedScenes.add(visibleScene.id);scenePreview=null;updateStage();scroller.focus({preventScroll:true});});
scroller.addEventListener('scroll',()=>{follow=!historyLock&&scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<48;if(follow)hasNew=false;updateStage();updateLatest();},{passive:true});$('latest-button').addEventListener('click',()=>{historyLock=false;follow=true;hasNew=false;scenePreview=null;scroller.scrollTop=scroller.scrollHeight;revealSprite(state.current);updateStage();updateLatest();});
function marked(parent,text,search){parent.replaceChildren();let from=0;for(const[start,end]of D.rangesFor(text,search)){if(start>from)parent.append(make('span','',text.slice(from,start)));parent.append(make('mark','',text.slice(start,end)));from=end;}if(from<text.length||!text.length)parent.append(make('span','',text.slice(from)));}
/* ---------- History: month timeline + stacked snippets ---------- */
const q=()=>$('history-search').value;
const hasQuery=()=>D.termsFor(q()).length>0;
function weekday(key){return '周'+WEEK[D.keyToDate(key).getDay()];}
function dayMap(){return new Map(D.buildDays(state.messages).map(d=>[d.key,d]));}
function hitCounts(){const c=new Map();for(const m of hits){const k=D.dayKey(m.createdAt);c.set(k,(c.get(k)||0)+1);}return c;}
function buildTimeline(days){const track=$('timeline-track'),scroll=$('timeline-scroll'),left=scroll.scrollLeft;dayButtons.clear();track.replaceChildren();if(!days.size)return;
 const keys=[...days.keys()],first=keys[0],last=D.dayKey(Date.now())>keys.at(-1)?D.dayKey(Date.now()):keys.at(-1);let month=null,row=null;
 for(const key of D.calendarDays(first.slice(0,8)+'01',last)){const date=D.keyToDate(key),label=(date.getMonth()+1)+'月';
  if(!month||month.dataset.month!==key.slice(0,7)){month=make('div','tl-month');month.dataset.month=key.slice(0,7);month.append(make('span','tl-month-label',(date.getMonth()===0||!track.children.length?date.getFullYear()+'年 ':'')+label));row=make('div','tl-days');month.append(row);track.append(month);}
  const d=days.get(key);let cell;
  if(d){cell=make('button','tl-day has');cell.type='button';cell.dataset.day=key;cell.tabIndex=-1;cell.setAttribute('aria-pressed','false');const dot=make('span','tl-dot tier-'+D.dotTier(d.count));dot.setAttribute('aria-hidden','true');cell.append(dot);dayButtons.set(key,cell);}
  else{cell=make('span','tl-day');cell.setAttribute('aria-hidden','true');}
  if(date.getDay()===1)cell.classList.add('week');row.append(cell);}
 scroll.scrollLeft=left;}
function decorateTimeline(days){const counts=hitCounts(),searching=hasQuery();$('timeline-track').classList.toggle('searching',searching);
 for(const[key,b]of dayButtons){const d=days.get(key),n=counts.get(key)||0,on=key===selectedKey;b.classList.toggle('hit',n>0);b.classList.toggle('dim',searching&&!n);b.setAttribute('aria-pressed',String(on));b.tabIndex=on?0:-1;
  b.setAttribute('aria-label',D.dateLabel(key)+' '+weekday(key)+'，'+d.count+' 条消息'+(searching?(n?'，命中 '+n+' 处':'，没有命中'):''));
  let num=b.querySelector('.tl-num');if(on){if(!num){num=make('span','tl-num');num.setAttribute('aria-hidden','true');b.append(num);}num.textContent=String(D.keyToDate(key).getDate());}else if(num)num.remove();}
 if(selectedKey&&!dayButtons.has(selectedKey)&&dayButtons.size){const latest=[...dayButtons.keys()].at(-1);selectedKey=latest;decorateTimeline(days);}}
function revealDay(key,smooth){const b=dayButtons.get(key),scroll=$('timeline-scroll');if(!b)return;const r=b.getBoundingClientRect(),s=scroll.getBoundingClientRect();const target=scroll.scrollLeft+(r.left-s.left)-s.width/2+r.width/2;scroll.scrollTo({left:Math.max(0,target),behavior:smooth&&!reduced()?'smooth':'instant'});}
function lineText(m,main){if(m.text)return D.snippet(m.text,q(),main?150:64);return m.status==='generating'?'等她开口…':'还没来得及写下。';}
function buildCard(c,front){const card=make(front?'button':'div','snippet-card');if(front)card.type='button';else card.setAttribute('aria-hidden','true');const target=c.lines.find(l=>l.main);
 const meta=make('span','snippet-meta'),stateText=target.status==='interrupted'?'未说完':target.status==='generating'?'正在回复…':'';meta.append(make('span','',time(target.createdAt)+' · '+(target.role==='user'?'你说':'夏澄')),make('span','snippet-state',stateText));card.append(meta);
 for(const m of c.lines){const line=make('span','snippet-line'+(m.main?' main':'')),who=make('span','snippet-who',m.role==='user'?'你':'夏澄'),content=make('span','snippet-body');
  if(m.actionVisible&&m.action){const cue=make('span','snippet-cue'),mini=make('span','cue-mini'),words=make('span');mini.setAttribute('aria-hidden','true');marked(words,m.action,q());cue.append(mini,make('span','sr-only','动作：'),words);content.append(cue);}
  const text=make('span','snippet-text');marked(text,lineText(m,m.main),m.text?q():'');content.append(text);line.append(who,content);card.append(line);}
 if(front)card.setAttribute('aria-label',D.dateLabel(c.key)+' '+time(target.createdAt)+'，'+(target.role==='user'?'你':'夏澄')+'：'+D.snippet(D.textFor(target)||lineText(target,true),q(),90)+'。按 Enter 回到这句话');
 return card;}
function cardSignature(list){return list.map(c=>c.targetId+':'+c.lines.map(l=>l.id+'.'+l.status+'.'+l.text.length+'.'+(l.actionVisible?1:0)).join(',')).join('|')+'#'+q();}
function renderCards(dir){const stack=$('card-stack'),hadFocus=stack.contains(document.activeElement);stack.replaceChildren();stack.removeAttribute('data-dir');
 if(!cards.length){$('card-count').textContent='';$('card-prev').disabled=$('card-next').disabled=true;return;}
 cardIndex=Math.max(0,Math.min(cards.length-1,cardIndex));let behind=[cardIndex+1,cardIndex+2].filter(i=>i<cards.length);if(behind.length<2)behind=behind.concat([cardIndex-1,cardIndex-2].filter(i=>i>=0)).slice(0,2);
 behind.slice().reverse().forEach((i,n)=>{const c=buildCard(cards[i],false);c.classList.add('behind-'+(behind.length-n));c.dataset.card=i;stack.append(c);});
 const front=buildCard(cards[cardIndex],true);front.classList.add('front');front.dataset.card=cardIndex;front.dataset.targetId=cards[cardIndex].targetId;stack.append(front);
 if(dir&&!reduced()){void stack.offsetWidth;stack.dataset.dir=dir;}
 $('card-count').textContent=(cardIndex+1)+' / '+cards.length;$('card-prev').disabled=cardIndex===0;$('card-next').disabled=cardIndex===cards.length-1;
 if(hadFocus)front.focus({preventScroll:true});}
function dayHeading(days){const d=days.get(selectedKey);if(!d)return;$('day-title').textContent=dateCaption(selectedKey)+' · '+weekday(selectedKey);const n=hitCounts().get(selectedKey)||0;
 $('day-meta').textContent=hasQuery()?(n?'这天命中 '+n+' 处':'这天没有命中，先看这天的片段'):d.count+' 条消息 · '+cards.length+' 段对话';}
function loadCards(keepTarget){const dayHits=hasQuery()&&(hitCounts().get(selectedKey)||0)>0;cards=selectedKey?D.daySnippets(state.messages,selectedKey,dayHits?q():''):[];
 if(keepTarget!==undefined){const i=cards.findIndex(c=>c.targetId===keepTarget);cardIndex=i>=0?i:Math.min(cardIndex,cards.length-1);}cardsSig=cardSignature(cards);}
function syncHitToCard(){if(!hasQuery()||!cards[cardIndex])return;const i=hits.findIndex(m=>m.id===cards[cardIndex].targetId);if(i>=0)hitIndex=i;}
function updateHitNav(){const on=hasQuery();$('hit-nav').hidden=!on;$('search-clear').hidden=!q();if(!on)return;$('hit-count').textContent=hits.length?(hitIndex+1)+' / '+hits.length:'0 / 0';$('hit-prev').disabled=hitIndex<=0;$('hit-next').disabled=hitIndex<0||hitIndex>=hits.length-1;}
function updateEmpty(){const empty=hasQuery()&&!hits.length;$('history-empty').hidden=!empty;document.querySelector('.day-heading').hidden=empty;$('snippet-area').hidden=empty;}
function chooseDay(key,{card='last',focus=false,smooth=true,dir}={}){const days=dayMap();if(!days.has(key))return;const changed=key!==selectedKey;selectedKey=key;loadCards();
 cardIndex=card==='last'?cards.length-1:typeof card==='number'?card:0;if(typeof card==='string'&&card.startsWith('id:')){const i=cards.findIndex(c=>c.targetId===Number(card.slice(3)));cardIndex=i>=0?i:0;}
 syncHitToCard();decorateTimeline(days);dayHeading(days);renderCards(changed?undefined:dir);updateHitNav();revealDay(key,smooth);
 if(changed&&!reduced()){const h=document.querySelector('.day-heading');h.classList.remove('changed');void h.offsetWidth;h.classList.add('changed');const t=$('timeline-track');t.classList.remove('pulse');void t.offsetWidth;t.classList.add('pulse');clearTimeout(pulseTimer);pulseTimer=setTimeout(()=>t.classList.remove('pulse'),520);}
 if(focus)dayButtons.get(key)?.focus({preventScroll:true});}
function latestKey(){return[...dayMap().keys()].at(-1)||'';}
function gotoHit(i,smooth=true){if(!hits.length)return;hitIndex=Math.max(0,Math.min(hits.length-1,i));const m=hits[hitIndex];chooseDay(D.dayKey(m.createdAt),{card:'id:'+m.id,smooth});updateHitNav();announce('第 '+(hitIndex+1)+' 处，共 '+hits.length+' 处，'+D.dateLabel(D.dayKey(m.createdAt))+'。');}
function onQuery(){hits=D.findHits(state.messages,q());updateEmpty();if(hasQuery()){if(hits.length)gotoHit(hits.length-1);else{hitIndex=-1;decorateTimeline(dayMap());updateHitNav();announce('没有找到相关片段。');}}else{hitIndex=-1;chooseDay(selectedKey&&dayMap().has(selectedKey)?selectedKey:latestKey(),{card:'last'});}updateHitNav();}
/* Live: new and interrupted replies stay searchable while the layer is open. */
function refreshHistory(){const days=dayMap(),sig=[...days.values()].map(d=>d.key+':'+d.count).join('|');if(sig!==timelineSig){timelineSig=sig;buildTimeline(days);}
 const keepHit=hits[hitIndex]?.id;hits=D.findHits(state.messages,q());if(hasQuery()){const i=hits.findIndex(m=>m.id===keepHit);hitIndex=i>=0?i:hits.length?hits.length-1:-1;if(keepHit===undefined&&hits.length&&!selectedKey)gotoHit(hits.length-1,false);}
 if(!days.has(selectedKey))selectedKey=latestKey();decorateTimeline(days);const keep=cards[cardIndex]?.targetId,before=cardsSig;loadCards(keep);if(cardsSig!==before)renderCards();dayHeading(days);updateHitNav();updateEmpty();}
function moveCard(step){const next=cardIndex+step;if(next<0||next>=cards.length)return;cardIndex=next;syncHitToCard();renderCards(step>0?'next':'prev');updateHitNav();const stack=$('card-stack');if(stack.contains(document.activeElement)||document.activeElement===document.body)stack.querySelector('.front')?.focus({preventScroll:true});announce('第 '+(cardIndex+1)+' 张片段，共 '+cards.length+' 张。');}
function focusCard(){const f=$('card-stack').querySelector('.front');if(f)f.focus({preventScroll:true});}
function stepDay(delta,edge){const keys=[...dayButtons.keys()].filter(k=>!hasQuery()||dayButtons.get(k).classList.contains('hit'));if(!keys.length)return;let at=keys.indexOf(selectedKey);
 let next=edge==='home'?0:edge==='end'?keys.length-1:at<0?(delta>0?keys.findIndex(k=>k>selectedKey):keys.length-1-[...keys].reverse().findIndex(k=>k<selectedKey)):at+delta;if(at<0&&next<0)next=delta>0?keys.length-1:0;
 next=Math.max(0,Math.min(keys.length-1,next));chooseDay(keys[next],{card:hasQuery()?0:'last',focus:true});if(hasQuery())updateHitNav();}
function resetHistory(){$('history-search').value='';hits=[];hitIndex=-1;updateEmpty();chooseDay(latestKey(),{card:'last'});updateHitNav();$('history-search').focus({preventScroll:true});announce('已清空条件，回到最近的日期。');}
function openHistory(){clearTimeout(historyCloseTimer);++historyVersion;historyPanel.classList.remove('leaving','initial-open');historyOpen=true;if(voice.pending?.automatic)cancelPendingVoice();historyOpener=$('history-button');historyPanel.hidden=false;document.querySelector('.history-heading').insertBefore($('demo-label'),$('history-close'));$('chat-pane').inert=true;$('chat-pane').setAttribute('aria-hidden','true');$('history-button').setAttribute('aria-expanded','true');
 timelineSig='';refreshHistory();if(!selectedKey||!dayMap().has(selectedKey))selectedKey=latestKey();if(hasQuery()&&hits.length&&hitIndex>=0)gotoHit(hitIndex,false);else chooseDay(selectedKey,{card:cards.length&&cardIndex>=0&&cardIndex<cards.length?cardIndex:'last',smooth:false});updateEmpty();$('history-search').focus({preventScroll:true});}
function closeHistory(restore=true,after){if(historyPanel.hidden){if(after)after();return;}historyOpen=false;const version=++historyVersion;clearTimeout(historyCloseTimer);historyPanel.classList.add('leaving');$('chat-pane').inert=false;$('chat-pane').removeAttribute('aria-hidden');$('history-button').setAttribute('aria-expanded','false');const finish=()=>{if(version!==historyVersion)return;historyPanel.hidden=true;document.querySelector('.composer-controls').insertBefore($('demo-label'),document.querySelector('.send-controls'));historyPanel.classList.remove('leaving');if(restore&&historyOpener)historyOpener.focus({preventScroll:true});if(after)after();};if(reduced())finish();else historyCloseTimer=setTimeout(finish,180);}
$('history-button').addEventListener('click',()=>historyOpen?closeHistory():openHistory());$('history-close').addEventListener('click',()=>closeHistory());
$('history-search').addEventListener('input',onQuery);$('search-clear').addEventListener('click',resetHistory);$('clear-filters').addEventListener('click',resetHistory);$('empty-reset').addEventListener('click',resetHistory);
$('history-search').addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229)return;if(e.key==='ArrowDown'||e.key==='Enter'){if(!cards.length||$('snippet-area').hidden)return;e.preventDefault();focusCard();}});
$('hit-prev').addEventListener('click',()=>gotoHit(hitIndex-1));$('hit-next').addEventListener('click',()=>gotoHit(hitIndex+1));
$('timeline-track').addEventListener('click',e=>{const b=e.target.closest('button.tl-day');if(!b)return;chooseDay(b.dataset.day,{card:hasQuery()?0:'last',focus:true});});
$('timeline-track').addEventListener('keydown',e=>{const map={ArrowLeft:-1,ArrowRight:1};if(e.key in map){e.preventDefault();stepDay(map[e.key]);}else if(e.key==='Home'||e.key==='End'){e.preventDefault();stepDay(0,e.key==='Home'?'home':'end');}else if(e.key==='Enter'||e.key==='ArrowDown'||e.key===' '){if(e.target.closest('button.tl-day')){e.preventDefault();if(e.target.dataset.day!==selectedKey)chooseDay(e.target.dataset.day,{card:hasQuery()?0:'last'});focusCard();}}});
$('timeline-scroll').addEventListener('wheel',e=>{const s=$('timeline-scroll');if(Math.abs(e.deltaY)>Math.abs(e.deltaX)&&s.scrollWidth>s.clientWidth){e.preventDefault();s.scrollLeft+=e.deltaY;}},{passive:false});
$('card-prev').addEventListener('click',()=>moveCard(-1));$('card-next').addEventListener('click',()=>moveCard(1));
$('card-stack').addEventListener('click',e=>{if(suppressClick){suppressClick=false;return;}const c=e.target.closest('.snippet-card');if(!c)return;if(c.classList.contains('front'))locateMessage(Number(c.dataset.targetId));else{const i=Number(c.dataset.card);moveCard(i-cardIndex);}});
$('card-stack').addEventListener('keydown',e=>{if(e.key==='ArrowLeft'){e.preventDefault();moveCard(-1);}else if(e.key==='ArrowRight'){e.preventDefault();moveCard(1);}else if(e.key==='ArrowUp'){e.preventDefault();dayButtons.get(selectedKey)?.focus({preventScroll:true});}});
$('card-stack').addEventListener('pointerdown',e=>{swipe={x:e.clientX,y:e.clientY,id:e.pointerId};});
$('card-stack').addEventListener('pointerup',e=>{if(!swipe||swipe.id!==e.pointerId)return;const dx=e.clientX-swipe.x,dy=e.clientY-swipe.y;swipe=null;if(Math.abs(dx)>48&&Math.abs(dx)>Math.abs(dy)*1.3){suppressClick=true;setTimeout(()=>{suppressClick=false;},0);moveCard(dx<0?1:-1);}});
$('card-stack').addEventListener('pointercancel',()=>{swipe=null;});
function locateMessage(id){const p=messageNodes.get(id),m=state.messages.find(m=>m.id===id);if(!p||!m)return;follow=false;historyLock=true;hasNew=state.activeId!==null;updateLatest();closeHistory(false,()=>{if(located)located.classList.remove('located');clearTimeout(locateTimer);located=p.article;located.classList.add('located');located.tabIndex=-1;const top=located.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop-18;scroller.scrollTo({top:Math.max(0,top),behavior:reduced()?'auto':'smooth'});located.focus({preventScroll:true});$('date-notice').textContent=dateCaption(D.dayKey(m.createdAt));$('date-notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{$('date-notice').hidden=true;},1650);locateTimer=setTimeout(()=>{if(located)located.classList.remove('located');located=null;},2000);announce('已定位到'+dateCaption(D.dayKey(m.createdAt))+'的消息。');});}
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},3200);}
$('back-button').addEventListener('click',()=>{if(historyOpen)closeHistory();else toast('这一页就是入口，消息仍留在这里。');});
/* Assets never depend on the theme. Each layer has its own decode/crossfade version. */
for(const kind of ['background','character']){const selected=D.PRESETS[kind].find(p=>p.id===query.get(kind));if(selected)layers.current[kind]={...selected};$(kind+'-a').src=layers.current[kind].src;}
const visibleAssets={background:{...layers.current.background},character:{...layers.current.character}};
function collectUrls(){const keep=new Set();for(const k of ['background','character']){keep.add(layers.current[k].src);keep.add(visibleAssets[k].src);for(const letter of ['a','b'])keep.add($(k+'-'+letter).getAttribute('src'));}if(layers.draft)keep.add(layers.draft.asset.src);for(const url of ownedUrls)if(!keep.has(url)){URL.revokeObjectURL(url);ownedUrls.delete(url);}}
function decode(src){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth*image.naturalHeight>50000000){reject(new Error('dimensions'));return;}resolve(image);};image.onerror=()=>reject(new Error('decode'));image.src=src;});}
async function applyLayer(change){const{kind,current}=change,version=++layerVersions[kind];clearTimeout(layerTimers[kind]);try{await decode(current.src);if(layerVersions[kind]!==version)return;const a=$(kind+'-a'),b=$(kind+'-b'),old=a.classList.contains('active')?a:b,next=old===a?b:a;next.src=current.src;next.alt=kind==='character'?current.label+'，独立角色图层':'';next.setAttribute('aria-hidden','false');requestAnimationFrame(()=>{if(layerVersions[kind]!==version)return;old.classList.remove('active');old.setAttribute('aria-hidden','true');next.classList.add('active');visibleAssets[kind]={...current};if(kind==='character'){manualSpriteAt=state.current?.id??null;$('performance-sprite').hidden=true;delete stage.dataset.sprite;}layerTimers[kind]=setTimeout(()=>{if(layerVersions[kind]!==version)return;old.removeAttribute('src');collectUrls();},reduced()?0:560);});announce((kind==='background'?'背景':'角色立绘')+'已更换。');}catch(_){if(layerVersions[kind]!==version)return;layers.current[kind]={...visibleAssets[kind]};collectUrls();toast('这张图片暂时打不开，原来的画面没有改变。');}}
function refreshPicker(){const d=layers.draft;if(!d)return;$('asset-title').textContent=d.kind==='background'?'替换背景':'替换角色立绘';$('asset-preview').classList.toggle('character',d.kind==='character');$('asset-preview-image').src=d.asset.src;$('asset-selection-name').textContent=d.asset.label;for(const b of $('preset-options').children)b.setAttribute('aria-pressed',String(b.dataset.assetId===d.asset.id));$('asset-apply').disabled=fileLoading;$('asset-apply').setAttribute('aria-disabled',String(fileLoading));}
function openPicker(kind,opener){if(assetDialog.open)return;layers.begin(kind);pickerOpener=opener;++pickerVersion;fileLoading=false;$('asset-error').textContent='';$('asset-file').value='';$('preset-options').replaceChildren();for(const asset of D.PRESETS[kind]){const b=make('button','preset-option '+kind);b.type='button';b.dataset.assetId=asset.id;const img=make('img');img.src=asset.src;img.alt='';b.append(img,make('span','',asset.label),icon('check'));b.addEventListener('click',()=>{++pickerVersion;fileLoading=false;layers.choose(asset);$('asset-error').textContent='';refreshPicker();collectUrls();});$('preset-options').append(b);}refreshPicker();const r=stage.getBoundingClientRect();assetDialog.style.left=Math.max(12,Math.min(innerWidth-388,r.right-376))+'px';assetDialog.style.top=Math.max(12,Math.min(innerHeight-540,r.top+12))+'px';assetDialog.classList.remove('initial-open');assetDialog.showModal();}
function closePicker(){++pickerVersion;fileLoading=false;layers.cancel();if(assetDialog.open)assetDialog.close();$('asset-preview-image').removeAttribute('src');collectUrls();}
$('background-button').addEventListener('click',()=>openPicker('background',$('background-button')));$('character-button').addEventListener('click',()=>openPicker('character',$('character-button')));$('asset-close').addEventListener('click',closePicker);$('asset-cancel').addEventListener('click',closePicker);assetDialog.addEventListener('cancel',e=>{e.preventDefault();closePicker();});assetDialog.addEventListener('close',()=>{if(pickerOpener?.isConnected)pickerOpener.focus({preventScroll:true});});assetDialog.addEventListener('click',e=>{if(e.target!==assetDialog)return;const r=assetDialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closePicker();});
$('asset-reset').addEventListener('click',()=>{++pickerVersion;fileLoading=false;layers.reset();$('asset-error').textContent='';refreshPicker();collectUrls();});$('asset-apply').addEventListener('click',()=>{if(fileLoading||!layers.draft)return;const change=layers.commit();++pickerVersion;assetDialog.close();$('asset-preview-image').removeAttribute('src');applyLayer(change);collectUrls();});$('import-button').addEventListener('click',()=>$('asset-file').click());
$('asset-file').addEventListener('change',async()=>{const file=$('asset-file').files?.[0];if(!file||!layers.draft)return;const version=++pickerVersion;if(!['image/png','image/jpeg','image/webp','image/avif'].includes(file.type)||file.size>20*1024*1024){fileLoading=false;refreshPicker();$('asset-error').textContent='请选择 20 MB 以内的 PNG、JPG、WebP 或 AVIF 图片。';$('asset-file').value='';return;}fileLoading=true;$('asset-error').textContent='';refreshPicker();const url=URL.createObjectURL(file);ownedUrls.add(url);try{await decode(url);if(version!==pickerVersion||!assetDialog.open||!layers.draft){URL.revokeObjectURL(url);ownedUrls.delete(url);return;}layers.choose({id:'local-'+version,src:url,label:file.name,imported:true});fileLoading=false;refreshPicker();collectUrls();}catch(_){URL.revokeObjectURL(url);ownedUrls.delete(url);if(version===pickerVersion&&assetDialog.open){fileLoading=false;$('asset-error').textContent='这张图片暂时打不开，请换一张。';refreshPicker();}}$('asset-file').value='';});
function palette(theme,persist=true){root.dataset.theme=theme;root.dataset.uiPreset=theme==='night'?'nightwave':'daylight';root.dataset.light=theme;if(persist)try{localStorage.setItem('nowadays-dialogue-v5-theme',theme);}catch(_){} }
function selectedTheme(theme){$('theme-day').setAttribute('aria-pressed',String(theme==='day'));$('theme-night').setAttribute('aria-pressed',String(theme==='night'));}
function restart(el,attr,value){el.removeAttribute(attr);void el.offsetWidth;el.setAttribute(attr,value);}
/* Sunset scale: beam + stage light at once; the reading surface hands over row by row through
   one View Transition (dusk top→bottom, dawn bottom→top). Without it the palette switches in one step. */
function beginLight(theme){root.dataset.lighting='true';root.dataset.lightDir=theme==='night'?'dusk':'dawn';themeSwitch.setAttribute('aria-busy','true');themeSwitch.dataset.state=theme;restart(themeSwitch,'data-motion',theme==='night'?'to-night':'to-day');stage.classList.remove('sunset','sunrise');void stage.offsetWidth;stage.classList.add(theme==='night'?'sunset':'sunrise');}
const SWEEP_MS=820,SWEEP_STEPS=14,paneEl=document.querySelector('.conversation-pane');let sweepJobs=[],sweepRows=[];
function preset(theme){return theme==='night'?'nightwave':'daylight';}
function pin(el,theme){el.classList.add('pal');el.setAttribute('data-ui-theme','xiacheng');el.setAttribute('data-ui-preset',preset(theme));}
function unpin(el){el.classList.remove('pal','flipped');el.removeAttribute('data-ui-theme');el.removeAttribute('data-ui-preset');}
/* Ends the sweep atomically: every unpin happens with transitions suppressed and is flushed before the
   suppression lifts, so no colour can animate back from the old palette (v3's end-of-sweep flash). */
function finishSweep(){for(const id of sweepJobs)clearTimeout(id);sweepJobs=[];if(!paneEl.classList.contains('sweeping')&&!sweepRows.length&&!paneEl.classList.contains('pal'))return;
 paneEl.classList.add('sweep-settle');for(const el of sweepRows)unpin(el);sweepRows=[];paneEl.classList.remove('sweeping','dawn');for(const k of ['--sweep-paper','--sweep-rule','--band'])paneEl.style.removeProperty(k);unpin(paneEl);
 void paneEl.offsetHeight;void getComputedStyle(paneEl).backgroundColor;paneEl.classList.remove('sweep-settle');}
/* Rows the reader can see right now, top to bottom. */
function visibleRows(){const box=paneEl.getBoundingClientRect(),inView=el=>{const r=el.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom&&r.height>0;};
 const rows=historyOpen?[...historyPanel.children].filter(el=>!el.hidden):[...scroller.children].filter(inView).concat([$('latest-button'),$('date-notice'),$('composer'),$('turn-controls')].filter(el=>el&&!el.hidden));
 return rows.map(el=>{const r=el.getBoundingClientRect();return{el,f:Math.max(0,Math.min(1,((r.top+r.bottom)/2-box.top)/Math.max(1,box.height)))};});}
function paletteStep(){const theme=lighting.current,from=root.dataset.theme;finishSweep();
 if(instantPalette){instantPalette=false;paneEl.classList.add('sweep-settle');palette(theme);void paneEl.offsetHeight;paneEl.classList.remove('sweep-settle');return;}
 if(reduced()||from===theme||!paneEl){palette(theme);return;}
 const dusk=theme==='night',rows=visibleRows();pin(paneEl,from);palette(theme);
 const tokens=getComputedStyle(root);paneEl.style.setProperty('--sweep-paper',tokens.getPropertyValue('--nd-semantic-color-surface').trim()||(dusk?'#202836':'#FFFCF7'));paneEl.style.setProperty('--sweep-rule',tokens.getPropertyValue('--nd-semantic-color-line-decorative').trim()||(dusk?'#3D4657':'#DDCFD0'));paneEl.classList.toggle('dawn',!dusk);paneEl.classList.add('sweeping');
 /* One job per step moves the band and flips exactly the rows it has reached: band and ink stay in lockstep. */
 const slot=SWEEP_MS/SWEEP_STEPS,byStep=Array.from({length:SWEEP_STEPS+1},()=>[]);for(const{el,f}of rows){sweepRows.push(el);byStep[Math.max(1,Math.min(SWEEP_STEPS,Math.ceil((dusk?f:1-f)*SWEEP_STEPS)))].push(el);}
 paneEl.style.setProperty('--band','0%');for(let k=1;k<=SWEEP_STEPS;k++)sweepJobs.push(setTimeout(()=>{paneEl.style.setProperty('--band',(k/SWEEP_STEPS*100).toFixed(2)+'%');for(const el of byStep[k]){pin(el,theme);el.classList.add('flipped');}if(k===SWEEP_STEPS)finishSweep();},k*slot));}
/* The last step (360 + 820 ms) finishes inside Lighting's 1200 ms window, while colour transitions are still held. */
function endLight(){root.dataset.lighting='false';stage.classList.remove('sunset','sunrise');themeSwitch.removeAttribute('data-motion');themeSwitch.setAttribute('aria-busy','false');themeSwitch.dataset.state=lighting.current;selectedTheme(lighting.requested);}
lighting=new D.Lighting({initial:root.dataset.theme,reduced:reduced(),onStart:beginLight,onStage:theme=>{stage.dataset.light=theme;},onPalette:paletteStep,onSettle:()=>{finishSweep();instantPalette=true;},onEnd:endLight});
stage.dataset.light=root.dataset.theme;themeSwitch.dataset.state=root.dataset.theme;selectedTheme(root.dataset.theme);document.querySelectorAll('[data-theme-choice]').forEach(b=>b.addEventListener('click',()=>{lighting.request(b.dataset.themeChoice);selectedTheme(lighting.requested);}));
if(media.addEventListener)media.addEventListener('change',()=>lighting.setReduced(reduced()));addEventListener('resize',()=>{if(lighting.busy)lighting.settle();draftChanged();if(follow)scroller.scrollTop=scroller.scrollHeight;});
document.addEventListener('keydown',e=>{if(e.key!=='Escape'||assetDialog.open)return;if(historyOpen){e.preventDefault();closeHistory();}else if(!$('toast').hidden){clearTimeout(toastTimer);$('toast').hidden=true;}});
addEventListener('pagehide',e=>{cancelPendingVoice();voice.active=null;window.speechSynthesis?.cancel();stage.classList.remove('cue');$('date-notice').hidden=true;if(located){located.classList.remove('located');located=null;}if(historyPanel.classList.contains('leaving')){historyPanel.hidden=true;historyPanel.classList.remove('leaving');document.querySelector('.composer-controls').insertBefore($('demo-label'),document.querySelector('.send-controls'));}if(!e.persisted)engine.dispose();lighting.settle();finishSweep();for(const id of [cueTimer,noticeTimer,locateTimer,toastTimer,historyCloseTimer,pulseTimer,...Object.values(layerTimers)])clearTimeout(id);if(!e.persisted){++pickerVersion;for(const url of ownedUrls)URL.revokeObjectURL(url);ownedUrls.clear();}});
draftChanged();
if(['background','character'].includes(query.get('layer'))){openPicker(query.get('layer'),$(query.get('layer')+'-button'));assetDialog.classList.add('initial-open');}
/* Preview links: ?history=1&q=书&date=2026-11-06|previous|densest&card=2 */
if(query.get('history')==='1'){$('history-search').value=query.get('q')||'';openHistory();const keys=[...dayMap().keys()],date=query.get('date');let key='';
 if(date==='previous')key=keys.at(-2)||'';else if(date==='densest'){const pool=hasQuery()?[...hitCounts()].sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?1:-1)).map(x=>x[0]):[...dayMap().values()].sort((a,b)=>b.count-a.count||(a.key<b.key?1:-1)).map(d=>d.key);key=pool[0]||'';}else if(date&&keys.includes(date))key=date;
 const card=Number(query.get('card'));if(key)chooseDay(key,{card:Number.isInteger(card)&&card>0?card-1:hasQuery()?0:'last',smooth:false});else if(Number.isInteger(card)&&card>0){cardIndex=card-1;renderCards();syncHitToCard();updateHitNav();}historyPanel.classList.add('initial-open');}
void document.body.offsetHeight;requestAnimationFrame(()=>requestAnimationFrame(()=>{root.dataset.ready='true';}));
})();
