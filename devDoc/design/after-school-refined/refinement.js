/* Refines the independent design prototype. Does not load or call the production application. */
'use strict';
const refinementNavPaths={home:'<path d="m3 10 9-7 9 7v10h-6v-7H9v7H3Z"/>',roles:'<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M5 16c1-4 7-4 8 0m3-8h2m-2 4h2m-2 4h2"/>',models:'<path d="M4 7h16M4 17h16M8 3v8m8 2v8"/>',library:'<path d="m3 7 9-4 9 4v12l-9 4-9-4Zm0 0 9 4 9-4M12 11v12"/>'};
function refineInterface(){
 document.title='nowadays / 放课后通信 · UI 精修';
 document.querySelector('.sample').textContent='UI 精修稿 · 示例数据';
 const avatar=document.querySelector('.mini-avatar');if(avatar)avatar.textContent=state.account===0?'昼':'风';
 document.querySelectorAll('.bookmarks [data-page]').forEach(b=>{if(b.querySelector('.nav-icon'))return;const span=document.createElement('span');span.className='nav-icon';span.innerHTML=`<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${refinementNavPaths[b.dataset.page]||''}</svg>`;b.prepend(span);});
 const title=document.querySelector('.home-title');if(title)title.innerHTML='今天的日常，<br><span>也请多指教。</span>';
 const choices=document.querySelector('.vn-choices');choices?.querySelector('[data-page="models"]')?.remove();
 const note=document.querySelector('.preview-note');if(note)note.innerHTML='<strong>夏澄 · 角色预览</strong>应用目标：海边放映室<br>每段关系，单独选择角色';
 document.querySelectorAll('input,select,textarea').forEach(el=>{if(el.disabled)el.setAttribute('aria-disabled','true');});
}
const originalPrototypeRender=render;
render=function(){originalPrototypeRender();refineInterface();};
refineInterface();
