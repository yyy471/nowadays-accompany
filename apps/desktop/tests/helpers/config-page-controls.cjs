'use strict';

const editor = '.config-role-editor:not([hidden])';
const sheet = '.config-sheet';

function button(label, scope) {
  return `[...document.querySelectorAll(${JSON.stringify(scope ? `${scope} button` : 'button')})].find(button=>button.getClientRects().length && button.textContent.trim()===${JSON.stringify(label)})`;
}

function element(selector) {
  return `document.querySelector(${JSON.stringify(selector)})`;
}

function setValue(target, value) {
  return `(()=>{const field=${target};Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field),'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event(field instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`;
}

function configControls(evaluate, until) {
  async function click(target) {
    await until(() => evaluate(`(()=>{const control=${target};if(!control || control.disabled || control.closest('[inert]') || control.getAttribute('aria-disabled')==='true' || !control.getClientRects().length)return false;control.click();return true;})()`));
  }

  async function pickRole(roleId) {
    await until(() => evaluate(`(()=>{
      const select=document.querySelector('.config-role-switch');
      if(!select || !select.getClientRects().length || ![...select.options].some(option=>option.value===${JSON.stringify(roleId)}))return false;
      const title=document.querySelector('.config-sheet:not([data-exiting]) h3')?.textContent;
      if(select.value===${JSON.stringify(roleId)} || title==='切换角色' || title==='新建角色' || document.querySelector('.config-sheet-confirm'))return true;
      if(document.querySelector('.config-sheet[data-exiting]'))return false;
      select.focus({preventScroll:true});
      ${setValue('select', roleId)};
      return false;
    })()`));
  }

  async function tab(label) {
    const matching = `[...document.querySelectorAll('.config-tabs button')].find(button=>button.querySelector('strong')?.textContent.trim()===${JSON.stringify(label)})`;
    let tryAgainAt = 0;
    await until(async () => {
      const result = await evaluate(`(()=>{
        const control=${matching};
        if(!control || !control.getClientRects().length)return false;
        if(control.getAttribute('aria-current')==='page')return true;
        const transitioning=[...document.querySelectorAll('.config-leaf,.config-leaf-body,.config-tabs')].some(node=>node.getAnimations().some(animation=>animation.pending || animation.playState==='running'));
        if(${Date.now() < tryAgainAt} || transitioning || control.disabled || control.closest('[inert]') || document.querySelector('.config-sheet-confirm'))return false;
        control.click();
        return 'requested';
      })()`);
      // 再点击会取消上一轮 M9。先让动画和渲染提交，再重试被写入守卫忽略的点击。
      if (result === 'requested') tryAgainAt = Date.now() + 350;
      return result === true;
    }, `tab ${label}`);
  }

  async function openSheet(trigger, title) {
    const titleCheck = title ? `sheet.querySelector('h3')?.textContent.trim()===${JSON.stringify(title)}` : 'true';
    await until(() => evaluate(`(()=>{
      const sheet=document.querySelector('.config-sheet:not([data-exiting])');
      if(sheet)return ${titleCheck};
      const control=${trigger};
      if(control && !control.disabled && !control.closest('[inert]') && control.getClientRects().length)control.click();
      return false;
    })()`));
  }

  async function openRoleRow(row) {
    await openSheet(element(`${editor} [data-edit="${row}"] .config-sum-edit`));
  }

  return { click, pickRole, tab, openRoleRow, openSheet };
}

module.exports = { button, configControls, editor, element, setValue, sheet };
