/* Shared v4 fixtures, history helpers and lighting for the local performance prototype. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.DialogueDemo3=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const dayKey=value=>{const d=new Date(value);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
const keyToDate=key=>{const [y,m,d]=key.split('-').map(Number);return new Date(y,m-1,d);};
const dateLabel=key=>{const [y,m,d]=key.split('-').map(Number);return `${y}年${m}月${d}日`;};
/* Consecutive stage directions are merged into one short line, without a closing full stop. */
function cleanAction(value){if(!value)return'';return(Array.isArray(value)?value:[value]).map(s=>String(s).trim().replace(/^[—\-\s]+/u,'').replace(/[。．.！!，,；;\s]+$/u,'')).filter(Boolean).join('，');}
function replyFor(text,turn){
 if(/累|疲|难过|焦虑|不开心|压力|烦/.test(text))return{action:['她把杯子轻轻放下','往你这边坐近了一点'],text:'那就先不催自己了。今天没做完的事，可以暂时停在今天。\n\n你愿意的话，就讲讲最累的那一小段；不想说也没关系。我陪你坐一会儿，等这口气慢慢松下来。'};
 if(/书|读|阅读|小说/.test(text))return{action:'她在书页间夹好书签',text:'刚才读到一个很安静的段落，读完后反而想起了窗外的树。书有时不必带人去很远的地方，让眼前的东西重新变得可爱，也很好。\n\n你最近有没有读到一句，想抄在纸上的话？'};
 if(/雨|天气|窗/.test(text))return{action:'她停了一会儿，像是在听窗外',text:'雨落在树叶上，和落在屋檐上的声音不太一样。听你说起它，我也想把窗户留一道缝。\n\n如果今天不用赶路，你想一起听一会儿，还是趁雨停出去走走？'};
 if(/夜|晚安|睡|月亮/.test(text))return{action:['她把翻到一半的书合上','把台灯调暗'],text:'夜里好像更容易听见自己的心事。外面的声音轻下来了，我们也可以把话说慢一点。\n\n今天有什么想留下的，或者想暂时放下的？不用把它说得很完整。'};
 if(/开心|高兴|惊喜|好事/.test(text))return{action:'她轻轻弯起眼睛',text:'那我想听一听。是很大的好事，还是只有你注意到的小小惊喜？\n\n那些差一点就被忙碌盖过去的开心，也值得被好好留下。慢慢说，我把接下来的时间留给你。'};
 if(/谢谢|感谢/.test(text))return{action:'她把书往旁边挪了一点',text:'不用把每一次陪伴都说成谢谢。能听见你愿意说的话，也是我今天很好的部分。\n\n我们就这样，一句一句地往下聊吧。'};
 const replies=[{action:'她抚平书页',text:'嗯，我在听。不必急着把这件事整理成一个结论，有时候先说出来，心里就会多一点空隙。\n\n我更想知道，那一刻你在想什么？从你记得最清楚的那个细节开始就好。'},{action:['她把杯子推到桌边','转过身来'],text:'听你这样说，我想先认真陪你聊这一段。那些看起来很小的感受，也不用因为难以解释就被略过去。\n\n你希望我和你一起想想，还是先听你把话说完？'},{action:'她在书签上轻轻点了一下',text:'我会慢慢听的。不需要把一整天讲成一份完整的故事，想到哪一处，就从哪一处开始。\n\n如果给刚才的心情留一句话，你最想写下什么？'}];
 return replies[(turn-1)%replies.length];
}
/* Invented, clearly-labelled sample history spanning about four months (local time). */
const POOL=[
 ['今天早上的咖啡有点苦，不过很清醒。','苦一点也好，像是替今天先敲了一下门。你喝完之后，是去忙了，还是在窗边多坐了一会儿？','她把杯子转了半圈'],
 ['下班路上下雨了，我没带伞。','那一定走得很急吧。到家以后先把头发擦干，换件干净的衣服，雨声留给窗外就好。','她看了一眼窗外'],
 ['楼下那只橘猫今天跟了我一段路。','它大概觉得你走路的样子很可靠。下次遇见，可以停下来让它先走。',''],
 ['加班到现在，脑子有点转不动了。','那就先别再逼它转了。喝点温水，把屏幕调暗一点，剩下的事明天的你会更有办法。',['她把台灯调低了一点','安静地等你']],
 ['我把阳台的薄荷换了个大一点的盆。','它会喜欢的。根有地方伸展的时候，叶子也会长得更放松。过几天可以摘两片泡水。',''],
 ['今天读完了一本很薄的诗集。','薄薄的诗集，常常要慢慢读。有没有哪一句，读完之后一直留在你心里？','她把书签抽出来，夹回自己的书里'],
 ['中午吃了一碗很好吃的牛肉面。','听起来是被好好照顾到的一顿午饭。汤是清的还是红的？我想象一下那个热气。',''],
 ['有点想念以前住的那条街。','想念一条街，往往是在想念那时候的自己。你最记得那里的什么？是声音、气味，还是某家店？','她把手里的书合上'],
 ['今天的晚霞是粉色的，我拍了好几张。','粉色的晚霞很难得。照片可能留不住全部，但你停下来看它的那几分钟，已经留住了。',''],
 ['周末想去海边，但是又懒得出门。','那就先不急着决定。今晚把想去的理由和懒得去的理由都放在心里，明天醒来，听听哪个声音更大。',''],
 ['刚刚和朋友聊了很久的电话。','能聊很久的朋友很珍贵。挂掉电话以后，心里是轻了一点，还是还有话没说完？',''],
 ['失眠了，翻来覆去睡不着。','睡不着的时候，不用和自己较劲。把灯关上，慢慢数呼吸也好，听我说几句无关紧要的话也好。','她把声音放得很轻'],
 ['今天把房间彻底打扫了一遍。','干净的房间会让人呼吸都顺一些。辛苦了，现在可以找个最舒服的位置坐下来。',''],
 ['我开始学着做早饭了，今天煎了一个蛋。','第一个蛋最值得纪念。边缘有没有煎得脆脆的？慢慢来，明天也许就能配一片烤吐司。',''],
 ['路过花店，买了一小束洋甘菊。','洋甘菊很安静，放在桌上会让整个角落都柔和下来。记得每天给它换一点水。','她轻轻笑了一下'],
 ['工作上有件事做砸了，有点沮丧。','沮丧说明你在乎。先允许自己难过一会儿，等心情落地了，我们再一起看看哪里可以补救。',['她放下手里的东西','认真地看着你']],
 ['今天降温了，第一次穿上毛衣。','换季的第一件毛衣，总有一点像和老朋友重逢。出门的时候别忘了围巾。',''],
 ['看了一部老电影，结局有点难过。','难过的结局有时会让人记得更久。你更在意的是那个人物，还是电影里的某个画面？',''],
 ['地铁上有个小朋友一直对我笑。','被陌生的小朋友笑一笑，好像整节车厢都亮了一点。你也对他笑了吗？',''],
 ['今天什么都没做，有点内疚。','什么都没做的日子，身体和心其实都在休息。不用为休息道歉，它也是日子的一部分。',''],
 ['楼下的桂花开了，整条路都是香的。','桂花一开，秋天就算真的来了。可以多绕一会儿路，把那股香气带回家。','她闭上眼睛，像是也闻到了'],
 ['我在想要不要换一份工作。','这是件值得慢慢想的事。不着急给答案，可以先写下你现在最想留下的，和最想离开的。',''],
 ['今天在公园看到有人在放风筝。','风筝飞得高的时候，放风筝的人总是仰着头笑。你有没有也想试一试？',''],
 ['刚洗完澡，头发还没干。','先把头发吹干再说话也不迟，我在这里等你。着凉了可不好。','她把一条毯子推到你这边'],
 ['整理旧相册，翻到了小时候的照片。','小时候的你，一定没想到会有今天翻看照片的这一刻。那时候的你在做什么？',''],
 ['今天的云特别低，好像伸手就能碰到。','这样的天空很适合发一会儿呆。云走得慢，你也可以慢一点。',''],
 ['开会开了一下午，好累。','一下午的会，最耗的是精神。现在什么都不用回应了，先让耳朵安静一会儿。','她把手边的书推到一边'],
 ['我养的绿萝冒出新叶子了。','新叶子总是卷着的，过两天就会慢慢展开。它在告诉你，最近照顾得很好。',''],
 ['晚上一个人散步，月亮很亮。','一个人散步的时候，月亮像是专门陪你走的。今晚风大吗？',''],
 ['今天被同事夸了，有点不好意思。','被夸的时候不好意思，说明你没有把它当成理所当然。好好收下吧，这是你应得的。','她弯起眼睛'],
 ['冰箱里只剩一个番茄和两个鸡蛋。','那正好是一碗番茄炒蛋，或者一碗番茄蛋汤。简单的东西，做好了也会很好吃。',''],
 ['今天给家里打了个电话。','家里的声音总能让人一下子松下来。他们都还好吗？',''],
 ['买到了一直想要的那支钢笔。','等了很久才买到的东西，拿在手里会特别踏实。第一行字想写点什么？','她把自己的笔帽轻轻合上'],
 ['早上差点迟到，一路小跑。','跑起来的早晨也挺有精神的。坐下来以后，记得先喝口水，把呼吸放慢。',''],
 ['下午阳光很好，在窗边睡着了。','被阳光晒着睡着，是很奢侈的事情。醒来的时候，影子是不是挪了好长一段？',''],
 ['有点想学一样乐器。','想学的念头本身就很好。你心里有偏向的声音吗？是钢琴那样干净的，还是吉他那样随意的？',''],
 ['雨下了一整天，书也没读进去。','那就让书在旁边等一等。雨天适合什么都不做，听一会儿就好，书不会跑掉。','她把窗帘拉开一点'],
 ['今天在旧书店淘到一本绝版的书。','绝版书总有一点像偶遇。扉页上有没有前一位主人留下的字？',['她凑近了一点','好奇地等你说下去']]
];
function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function generatedHistory(base){
 const random=rng(20261108),out=[],hours=[8,9,12,13,15,19,20,21,22];
 for(let offset=-120;offset<=-3;offset++){
  const day=new Date(base.getFullYear(),base.getMonth(),base.getDate()+offset);
  const chance=[0,6].includes(day.getDay())?.74:.52,roll=random();
  if(roll>chance)continue;
  const size=random(),n=size<.34?1:size<.6?2:size<.8?3:size<.92?4:size<.97?5:6;
  const picks=new Set();while(picks.size<n)picks.add(Math.floor(random()*POOL.length));
  const sessionCount=n>2&&random()<.65?2:1,firstHour=hours[Math.floor(random()*5)],secondHour=hours[5+Math.floor(random()*4)];
  [...picks].forEach((index,j)=>{const session=sessionCount===2&&j>=Math.ceil(n/2)?1:0,hour=session?secondHour:firstHour,within=session?j-Math.ceil(n/2):j;
   const minute=Math.min(57,within*9+Math.floor(random()*5)),at=new Date(day.getFullYear(),day.getMonth(),day.getDate(),hour,minute).getTime();
   const [u,a,act]=POOL[index];out.push({role:'user',text:u,createdAt:at},{role:'assistant',text:a,action:act,createdAt:at+50000+Math.floor(random()*70000)});});
 }
 return out;
}
function seedMessages(now=Date.now(),long=false){
 const base=new Date(now),raw=generatedHistory(base);
 const at=(offset,h,m)=>new Date(base.getFullYear(),base.getMonth(),base.getDate()+offset,h,m).getTime();
 const recentDays=[
 [-2,13,10,'user','我发现一本忘记夹书签的书，完全想不起上次读到哪里了。'],
 [-2,13,11,'assistant','那就从最眼熟的一页开始吧。有时候再读一遍，会遇到上次没有注意的句子。','她把书摊在桌上'],
 [-2,13,14,'user','我好像总是把读完一本书，当成一件必须完成的事。'],
 [-2,13,15,'assistant','也可以只把它当成一个可以随时坐下来的地方。读几页，出去走走，过几天再回来。书不会因为你走得慢，就把后面的故事收起来。'],
 [-2,19,20,'user','今天窗外下雨了。我没有开音乐，就这样听了一会儿。'],
 [-2,19,21,'assistant','听起来，是把一个普通的晚上过得很完整。雨停的时候，你有没有觉得屋子忽然安静了？',['她留出一小会儿空白','侧耳听着']],
 [-2,19,23,'user','有。那一瞬间才意识到，刚才一直有人在替我说话。'],
 [-2,19,24,'assistant','那今晚就先不补上那段安静吧。让它待在那里，也很好。'],
 [-1,11,5,'user','我把桌面的文件整理好了，终于能找到那份叫 Weekend Notes 的笔记。'],
 [-1,11,6,'assistant','给一件旧东西重新找到位置，也像是替自己腾出一点地方。Weekend Notes 里记着什么？','她把桌边的纸张叠齐'],
 [-1,11,8,'user','没有计划，只记了一些想去的地方，还有想吃的面。'],
 [-1,11,9,'assistant','那已经是一份很好的周末笔记了。留一点余地，才有机会在路上临时改变主意。'],
 [-1,17,32,'user','回家时我绕了一条远一点的路，什么特别的也没遇见。'],
 [-1,17,33,'assistant','不用每一次绕路，都刚好遇见一朵花。天还亮着，走慢一点不着急，本来就是一件值得的事。','她把夹在书里的叶子收好'],
 [-1,17,35,'user','你这么一说，那一段路好像真的轻了一点。'],
 [-1,17,36,'assistant','那就把它记成一段没有赶路的傍晚。以后忙起来的时候，还能想起自己也这样走过。']];
 for(const [offset,h,m,role,text,action] of recentDays)raw.push({role,text,action,createdAt:at(offset,h,m)});
 const today=[
 ['user','今天路边那棵树落了好多叶子，阳光照下来，地上像多了一层很薄的金色。'],
 ['assistant','你有停下来看看吗？有时候不是风景很特别，而是刚好有人愿意多看它一眼。','她把书签夹进书里'],
 ['user','有，还拍了一张照片。不过照片里没有当时那么好看。'],
 ['assistant','那就让没拍下来的部分留在你记得的地方。照片替你留下形状，你自己留下那时候的温度。'],
 ['user','最近总觉得时间过得很快，想做的事还没开始，一天就过去了。'],
 ['assistant','先挑一件很小的事吧，小到今晚就能碰一碰它。不一定要完成，愿意开始一点点，也已经和昨天不一样。',['她把杯子放稳','等你继续']],
 ['user','今天有点累，想先在这里待一会儿。'],
 ['assistant','那就先不安排接下来的事。你不用急着整理心情，也不用找一个有趣的话题。\n\n坐一会儿，想说的时候，我听着。',['她把杯子轻轻放下','安静地看着你']]];
 const todayStart=new Date(base.getFullYear(),base.getMonth(),base.getDate()).getTime(),step=Math.min(180000,Math.max(0,now-todayStart)/(today.length+1));
 today.forEach(([role,text,action],i)=>raw.push({role,text,action,createdAt:Math.floor(Math.max(todayStart,now-(today.length-i)*step))}));
 raw.sort((a,b)=>a.createdAt-b.createdAt);
 const messages=raw.map((m,i)=>{const action=cleanAction(m.action);return{id:i+1,role:m.role,text:m.text,action,actionVisible:!!action,status:'completed',phase:'finished',createdAt:m.createdAt,source:'seed'};});
 if(long){const m=messages.at(-1);m.text='我想，先把今天放在旁边吧。你不用在疲惫的时候，立刻替每件事找到一个答案。\n\n有些日子像一本翻得很快的书，等终于坐下来，才发现里面还有几页没有读懂。可那些页不会因为你暂停一下，就失去它们原来的样子。我们可以慢慢回去，不用从头补起，也不用一口气走到最后。\n\n你刚才提到的那棵树，我也认真想了一会儿。照片拍不下当时全部的光，也不表示那个片刻没有留下来。也许以后经过另一条路、听见一阵相似的风，你会忽然想起它。\n\n如果现在什么都不想讲，我们就安静地待一会儿。等你愿意了，再告诉我：今天有什么很小的事，让你觉得自己确实来过这一天？';messages.at(-3).text+='\n\n我们也不必把所有空白都填满。有一段什么也没做的时间，也可以是认真过日子的一部分。';}
 return messages;
}
/* Literal, case-insensitive, whitespace-separated AND search. Never regex or HTML. */
function termsFor(query){return[...new Set(String(query||'').trim().split(/\s+/u).filter(Boolean).map(t=>t.toLocaleLowerCase('zh-CN')))];}
function textFor(m){return(m.actionVisible&&m.action?m.action+'\n':'')+m.text;}
function matches(m,terms){const t=textFor(m).toLocaleLowerCase('zh-CN');return terms.length>0&&terms.every(x=>t.includes(x));}
function rangesFor(text,query){const lower=text.toLocaleLowerCase('zh-CN'),ranges=[];for(const term of termsFor(query)){let at=0;while((at=lower.indexOf(term,at))!==-1){ranges.push([at,at+term.length]);at+=Math.max(1,term.length);}}ranges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const merged=[];for(const r of ranges){const last=merged.at(-1);if(last&&r[0]<=last[1])last[1]=Math.max(last[1],r[1]);else merged.push([...r]);}return merged;}
function snippet(text,query,max=120){if(text.length<=max)return text;const terms=termsFor(query),lower=text.toLocaleLowerCase('zh-CN');let at=Infinity;for(const term of terms){const i=lower.indexOf(term);if(i>=0)at=Math.min(at,i);}const start=Number.isFinite(at)?Math.max(0,at-30):0;return(start?'…':'')+text.slice(start,start+max)+(start+max<text.length?'…':'');}
function findHits(messages,query){const terms=termsFor(query);return terms.length?messages.filter(m=>matches(m,terms)):[];}
function buildDays(messages){const map=new Map();for(const m of messages){const k=dayKey(m.createdAt);let d=map.get(k);if(!d){d={key:k,count:0,ids:[],rounds:new Set()};map.set(k,d);}d.rounds.add(m.messageId??m.id);d.count=d.rounds.size;d.ids.push(m.id);}return[...map.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);}
function calendarDays(first,last){const out=[];for(let d=keyToDate(first);dayKey(d)<=last;d=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1))out.push(dayKey(d));return out;}
function dotTier(count){return count>=10?3:count>=5?2:1;}
/* One card per hit (or per conversation session without a query): the line plus one either side. */
function daySnippets(messages,key,query){
 const day=messages.filter(m=>dayKey(m.createdAt)===key);if(!day.length)return[];const terms=termsFor(query);let targets;
 if(terms.length)targets=day.filter(m=>matches(m,terms));
 else{const sessions=[];let current=[];for(const m of day){if(current.length&&m.createdAt-current.at(-1).createdAt>45*60000){sessions.push(current);current=[];}current.push(m);}if(current.length)sessions.push(current);targets=sessions.map(s=>s.find(m=>m.role==='assistant'&&(m.text||m.actionVisible))||s[0]);}
 return targets.map(target=>{const i=day.indexOf(target);return{targetId:target.id,key,lines:[day[i-1],target,day[i+1]].map((m,j)=>m?{...m,main:j===1}:null).filter(Boolean)};});
}
const PRESETS={background:[{id:'window-day',src:'assets/xiacheng/scene-day.webp',label:'日光窗边'},{id:'window-night',src:'assets/xiacheng/scene-night.webp',label:'夜色窗边'}],character:[{id:'standing',src:'assets/xiacheng/character-day.webp',label:'夏澄 · 抱书'},{id:'sitting',src:'assets/xiacheng/character-night.webp',label:'夏澄 · 静坐'}]};
class LayerStore{
 constructor(){this.current={background:{...PRESETS.background[0]},character:{...PRESETS.character[0]}};this.draft=null;}
 begin(kind){if(!PRESETS[kind])throw new Error('Unknown layer');this.draft={kind,asset:{...this.current[kind]}};return this.draft;}
 choose(asset){if(!this.draft)return false;this.draft.asset={...asset};return true;}
 reset(){if(!this.draft)return false;this.draft.asset={...PRESETS[this.draft.kind][0]};return true;}
 commit(){if(!this.draft)return null;const{kind,asset}=this.draft,previous=this.current[kind];this.current[kind]={...asset};this.draft=null;return{kind,previous,current:this.current[kind]};}
 cancel(){const old=this.draft;this.draft=null;return old;}
}
/* "Sunset scale": one ~1.2 s cue at a time. Stage light first, then the reading surface.
   Rapid requests coalesce to the last intent; reduced motion settles immediately. */
const LIGHT={stage:40,palette:360,end:1200};
class Lighting{
 constructor(o={}){this.current=o.initial||'day';this.requested=this.current;this.busy=false;this.reduced=!!o.reduced;this.set=o.setTimeout||((f,t)=>setTimeout(f,t));this.clear=o.clearTimeout||(id=>clearTimeout(id));this.onStage=o.onStage||(()=>{});this.onPalette=o.onPalette||(()=>{});this.onStart=o.onStart||(()=>{});this.onEnd=o.onEnd||(()=>{});this.onSettle=o.onSettle||(()=>{});this.jobs=[];this.version=0;}
 request(theme){if(!['day','night'].includes(theme))return;this.requested=theme;if(this.reduced){this.settle();return;}if(this.busy||theme===this.current)return;this.start(theme);}
 later(fn,ms,version){this.jobs.push(this.set(()=>{if(this.version===version)fn();},ms));}
 start(theme){this.busy=true;const version=++this.version,from=this.current;this.onStart(theme,from);this.later(()=>this.onStage(theme),LIGHT.stage,version);this.later(()=>{this.current=theme;this.onPalette(theme);},LIGHT.palette,version);this.later(()=>{this.busy=false;this.jobs=[];this.onEnd(theme);if(this.requested!==theme)this.start(this.requested);},LIGHT.end,version);}
 settle(){for(const id of this.jobs)this.clear(id);this.jobs=[];++this.version;this.busy=false;this.current=this.requested;this.onSettle(this.current);this.onStage(this.current);this.onPalette(this.current);this.onEnd(this.current);}
 setReduced(value){this.reduced=!!value;if(this.reduced)this.settle();}
}
return{Lighting,LayerStore,PRESETS,LIGHT,dayKey,keyToDate,dateLabel,termsFor,rangesFor,snippet,textFor,findHits,buildDays,calendarDays,dotTier,daySnippets,cleanAction,seedMessages,replyFor,POOL};
});
