/* Presentation enhancement for the standalone, user-selected desk prototype. */
'use strict';
function enhanceAnimeDesk(){
 document.title='nowadays / 桌面玩具 · 二次元';
 const sample=document.querySelector('.sample');if(sample)sample.textContent='桌面玩具 · 二次元方向稿';
 const footerCopy=document.querySelector('.footer>span:nth-child(2)');if(footerCopy)footerCopy.textContent='SOFT MACHINES / ANIME EDITION';
 const sub=document.querySelector('.brand-sub');if(sub)sub.textContent='A LITTLE COMPANY. EVERYDAY.';
 document.querySelectorAll('img').forEach(el=>{el.alt='夏澄角色立绘：深蓝长发、樱粉开衫、深蓝长裙与手账。';});
 const word=document.querySelector('.object-word');if(word)word.innerHTML='XIA<span>CHENG.</span>';
 const label=document.querySelector('.object-label');if(label)label.innerHTML='<small>PERSONA / 海边放映室</small><strong>夏澄 · XIA CHENG</strong>';
 const caption=document.querySelector('.object-caption');if(caption)caption.innerHTML='角色卡预览 / 夏澄<br>群聊与好友分别选择角色';
 const stamp=document.querySelector('.role-stamp');if(stamp)stamp.innerHTML='A LITTLE<br>COMPANY';
 const roleCopy=document.querySelector('.role-spotlight>p');if(roleCopy)roleCopy.innerHTML='喜欢手账、旧电影和傍晚的光。<br>认真听你说话，也有自己的小日常。';
 const heading=document.querySelector('.role-spotlight>h2');if(heading)heading.textContent='夏澄 · XIA CHENG';
 const sampleTag=document.querySelector('.role-meta>span:first-child');if(sampleTag)sampleTag.textContent='角色预览样本';
 const collection=document.querySelector('.collection-layout>aside');if(collection){const h=collection.querySelector('h2');if(h)h.textContent='XIA CHENG / 日常搭档';}
}
const renderOriginalDesk=render;
render=function(){renderOriginalDesk();enhanceAnimeDesk();};
enhanceAnimeDesk();
document.addEventListener('change',e=>{if(e.target.id==='pair-role'){const heading=document.querySelector('.role-spotlight>h2');if(heading)heading.textContent='夏澄 · XIA CHENG';}});
