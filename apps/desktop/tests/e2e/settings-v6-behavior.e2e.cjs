'use strict';

// 使用设置页 Electron 场景的本机 HTTP 替身，按规范检查六种视口和主题组合。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check } = require('./settings-media-sheet.e2e.cjs');
const { configControls, editor, element, setValue } = require('../helpers/config-page-controls.cjs');

function contrast(first, second) {
  const luminance = color => {
    const channels = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color)?.slice(1);
    assert.ok(channels, `预期不透明的计算色值：${color}`);
    const [r, g, b] = channels.map(value => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const sorted = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (sorted[0] + 0.05) / (sorted[1] + 0.05);
}

async function verifyLongTextAndContrast({ cmd, ev, until, nav, out, errors, longResourceName, longResourceAddress }) {
  await until(() => ev(`(() => {
    const trigger=document.querySelector('.ui-menu-trigger');
    if(!trigger)return false;
    if(trigger.getAttribute('aria-expanded')!=='true'){trigger.click();return false;}
    const item=[...document.querySelectorAll('.ui-menu-panel:not([inert]) .ui-menu-item')].find(item=>item.textContent.trim()==='设置');
    if(!item)return false;
    item.click();
    return true;
  })()`), 'settings menu');
  try { await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='settings'"), 'settings for long text'); }
  catch (error) { console.error('settings page state', { text: await ev('document.body.innerText'), errors }); throw error; }
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const checked = [];
  const geometry = [];
  const problems = [];
  for (const theme of ['白昼来信', '晚风电台']) {
    const targetPreset = theme === '晚风电台' ? 'nightwave' : 'daylight';
    await ev(`[...document.querySelectorAll('.ui-theme-switcher button')].find(button=>button.textContent.includes(${JSON.stringify(theme)})).click()`);
    await until(() => ev(`document.documentElement.dataset.uiPreset === ${JSON.stringify(targetPreset)} && !document.querySelector('.config-theme-veil') && !document.documentElement.hasAttribute('data-switching')`), `theme ${theme} settled`);
    for (const [width, height] of [[1440, 840], [1280, 800], [720, 540]]) {
      await cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await nav('模型');
      await until(() => ev(`document.querySelector('.config-service-head h2')?.textContent===${JSON.stringify(longResourceName)}`), 'long model heading');
      await ev('document.fonts.ready');
      // 等视口尺寸与连续两帧状态点 X 坐标完全稳定，避免主题切光或滚动条收口未完成时读到瞬态偏差。
      let settledDotKey = '';
      let layout = null;
      await until(async () => {
        const probe = await ev(`(() => {
          if (Math.abs(window.innerWidth - ${width}) > 1) return null;
          if (document.querySelector('.config-theme-veil') || document.documentElement.hasAttribute('data-switching')) return null;
          if (document.getAnimations({ subtree: true }).some(a => a.playState === 'running')) return null;
          const book = document.querySelector('.config-book');
          const leaf = document.querySelector('.config-leaf-body');
          const heading = document.querySelector('.config-service-head h2');
          const address = document.querySelector(${JSON.stringify(width <= 900 ? '.config-service-head p' : '[data-service-group="连接"] .config-sum-keys span')});
          if (!book || !leaf || !heading || !address) return null;
          const fields = [heading, address];
          const dots = [...leaf.querySelectorAll('.config-sum .ui-dot')].filter(dot => dot.getClientRects().length);
          const footer = document.querySelector('.config-leaf-foot');
          return {
            bookOverflow: book.scrollWidth - book.clientWidth,
            leafOverflow: leaf.scrollWidth - leaf.clientWidth,
            fields: fields.map(field => ({ title: field.title, overflow: field.scrollWidth - field.clientWidth, ellipsis: getComputedStyle(field).textOverflow })),
            dotXs: dots.map(dot => dot.getBoundingClientRect().x),
            footerHeight: footer.getBoundingClientRect().height,
            hasRetiredCopy: /已全部保存|点按任一项修改|配置状态以已保存的数据为准|本机偏好|位角色活动中/.test(book.innerText),
          };
        })()`);
        if (!probe || probe.dotXs.length < 5) {
          settledDotKey = '';
          return false;
        }
        const nextKey = probe.dotXs.map(x => Math.round(x * 100)).join(',');
        const stable = nextKey === settledDotKey;
        settledDotKey = nextKey;
        if (!stable) return false;
        layout = probe;
        return true;
      }, `${theme} ${width} layout settled`);
      assert.ok(layout.bookOverflow <= 1 && layout.leafOverflow <= 1, `${theme} ${width} 横向溢出：${JSON.stringify(layout)}`);
      assert.deepEqual(layout.fields.map(field => field.title), [longResourceName, longResourceAddress]);
      const fields = layout.fields.map(({ overflow, ellipsis }) => ({ overflow, ellipsis }));
      if (fields.some(field => field.overflow <= 0 || field.ellipsis !== 'ellipsis')) problems.push(`${theme} ${width} 长文字未按单行省略：${JSON.stringify(fields)}`);
      if (layout.dotXs.length < 5 || Math.max(...layout.dotXs) - Math.min(...layout.dotXs) > 0.5) problems.push(`${theme} ${width} 状态点未对齐：${JSON.stringify(layout.dotXs)}`);
      const referenceX = { 1440:1296.67, 1280:1136.67, 720:598.67 }[width];
      if (layout.dotXs.some(x => Math.abs(x - referenceX) > 0.5)) problems.push(`${theme} ${width} 状态点偏离 demo：${JSON.stringify(layout.dotXs)}`);
      if (layout.footerHeight !== 0 || layout.hasRetiredCopy) problems.push(`${theme} ${width} 干净底栏或文案未收口`);
      geometry.push({ theme, width, fields, dotXs: layout.dotXs, footerHeight: layout.footerHeight });

      await nav('角色');
      const colors = await until(() => ev(`(() => {
        const stopped = document.querySelector('.config-status-poster[data-state=stopped]');
        const active = document.querySelector('.config-status-poster[data-state=active]');
        if (!stopped || !active) return null;
        const dot = stopped.querySelector('.config-status-state .ui-dot');
        const shadow = getComputedStyle(dot, '::before').boxShadow;
        return {
          bg: getComputedStyle(stopped).backgroundColor,
          name: getComputedStyle(stopped.querySelector('.config-status-name')).color,
          state: getComputedStyle(dot).color,
          dot: shadow.match(/rgb\\([^)]*\\)/)?.[0],
          active: getComputedStyle(active.querySelector('.config-status-name')).color,
        };
      })()`), 'stopped and active role cards');
      const ratios = {
        name: contrast(colors.name, colors.bg),
        state: contrast(colors.state, colors.bg),
        dot: contrast(colors.dot, colors.bg),
        nameChange: contrast(colors.active, colors.name),
      };
      checked.push({ theme, width, ...ratios });
    }
  }
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  const forced = await ev(`(() => {
    const stopped = document.querySelector('.config-status-poster[data-state=stopped]');
    const active = document.querySelector('.config-status-poster[data-state=active]');
    const outline = getComputedStyle(stopped);
    const dot = card => getComputedStyle(card.querySelector('.config-status-state .ui-dot'), '::before');
    return { active:matchMedia('(forced-colors: active)').matches, style:outline.borderTopStyle, width:outline.borderTopWidth,
      stoppedDot:dot(stopped).boxShadow, activeDot:dot(active).backgroundColor,
    };
  })()`);
  fs.writeFileSync(path.join(out, 'long-text-and-contrast.json'), JSON.stringify({ checked, forced, geometry }, null, 2));
  assert.equal(forced.active, true);
  assert.equal(forced.style, 'dashed');
  assert.ok(parseFloat(forced.width) > 0 && parseFloat(forced.width) <= 1, `强制色虚线边框：${forced.width}`);
  assert.notEqual(forced.stoppedDot, 'none');
  assert.notEqual(forced.activeDot, 'rgba(0, 0, 0, 0)');
  for (const ratios of checked) {
    if (ratios.name < 4.5 || ratios.state < 4.5 || ratios.dot < 3 || ratios.nameChange < 1.5) problems.push(`G9：${JSON.stringify(ratios)}`);
  }
  return { checked, geometry, forced, problems };
}

async function verifySaveFeedback({ cmd, ev, until }) {
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'no-preference' }, { name:'forced-colors', value:'none' }] });
  const { click, pickRole, tab, openRoleRow } = configControls(ev, until);
  await click(element('.config-return-link'));
  await until(() => ev("document.querySelector('.studio-shell')?.dataset.page==='role-config'"), 'return to role configuration');
  await pickRole('b');
  await until(() => ev("document.activeElement?.matches('.config-leaf-body h2')"), 'switch role focuses heading');
  await tab('模型');
  const row = `${editor} [data-edit="model:memory"]`;
  await openRoleRow('model:memory');
  await until(() => ev("document.activeElement?.matches('.config-sheet select')"), 'model group starts with first field');
  const expectedFocus = await ev(`(() => {
    const input = document.activeElement, probe = document.createElement('span');
    probe.style.cssText = 'border-color:var(--nd-semantic-color-focus);box-shadow:var(--nd-semantic-shadow-focus-halo)';
    input.parentElement.appendChild(probe);
    const result = [getComputedStyle(probe).borderColor, getComputedStyle(probe).boxShadow];
    probe.remove();
    return result;
  })()`);
  await until(() => ev(`document.activeElement.matches('.config-sheet select:focus') && !document.activeElement.getAnimations().some(a => a.playState === 'running')`), 'the focused field finished its transition');
  assert.deepEqual(await ev(`[getComputedStyle(document.activeElement).borderColor, getComputedStyle(document.activeElement).boxShadow]`), expectedFocus, 'M16 uses the configuration focus color and halo');
  await ev(setValue(element('.config-sheet select'), 'm1'));
  await until(() => ev("!!document.querySelector('.config-sheet input[role=combobox]')"), 'memory model field');
  await ev(setValue(element('.config-sheet input[role=combobox]'), 'memo-sweep'));
  await ev(`(() => {
    window.v6FeedbackTrace=[];
    window.v6SavingSheet=document.querySelector('.config-sheet');
    const observer=new MutationObserver(records => {
      for(const node of records.flatMap(record=>[...record.addedNodes])) {
        if(!(node instanceof HTMLElement) || !node.matches('.config-save-sweep'))continue;
        const row=node.closest('.config-sum');
        const sweep=node.getAnimations()[0]?.effect.getTiming();
        const entering=row?.querySelector('.config-sum-val:not(.config-old-value)')?.getAnimations()[0]?.effect.getTiming();
        const sheet=window.v6SavingSheet.isConnected ? window.v6SavingSheet : null;
        const entry={ row:row?.dataset.edit, exiting:!!sheet, sweep:sweep?.duration, duration:entering?.duration, delay:entering?.delay };
        if(sheet) {
          entry.exitAnimations=sheet.getAnimations().map(animation=>({
            state:animation.playState, at:animation.currentTime, end:animation.effect.getComputedTiming().endTime,
          }));
        }
        window.v6FeedbackTrace.push(entry);
      }
    });
    observer.observe(document.querySelector('.config-leaf-body'),{subtree:true,childList:true});
  })()`);
  await click(element('.config-sheet .config-save-btn'));
  await until(() => ev("window.v6FeedbackTrace.length>0"), 'save animates the changed summary');
  const standard = await ev('window.v6FeedbackTrace');
  assert.deepEqual(standard, [{ row:'model:memory', exiting:false, sweep:600, duration:360, delay:90 }], 'M7/M8：纸笺完全收回后仅播放变化行的交叉淡化和扫光');
  await until(() => ev("!document.querySelector('.config-save-sweep,.config-old-value')"), 'save feedback settles');

  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
  await openRoleRow('model:memory');
  await ev(setValue(element('.config-sheet input[role=combobox]'), 'memo-reduced'));
  await click(element('.config-sheet .config-save-btn'));
  await until(() => ev(`!document.querySelector('.config-sheet') && ${element(row)}?.innerText.includes('memo-reduced')`), 'save succeeds under reduced motion');
  await ev('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  assert.deepEqual(await ev('window.v6FeedbackTrace'), standard, '减少动效时更新摘要而不扫光');
  return standard;
}

async function verifyImmediateSuccessor({ cmd, ev, until }) {
  await cmd('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'no-preference' }] });
  const { click, openRoleRow } = configControls(ev, until);
  await openRoleRow('model:memory');
  await until(() => ev("document.querySelectorAll('.config-scrim,.config-book-scrim').length===2"), 'both paper scrims are present');
  await ev(setValue(element('.config-sheet input[role=combobox]'), 'memo-next-sheet'));
  await ev(`(() => {
    const paper=document.querySelector('.config-sheet');
    const scrims=[...document.querySelectorAll('.config-scrim,.config-book-scrim')];
    const leaf=document.querySelector('.config-leaf-body');
    const footer=document.querySelector('.config-leaf-foot');
    const next=${element(`${editor} [data-edit="model:chat"] .config-sum-edit`)};
    window.v6SavingSheet=paper;
    window.v6FeedbackTrace.length=0;
    window.v6ExitBoundary={};
    const observer=new MutationObserver(() => {
      if(paper.isConnected && paper.hasAttribute('data-exiting') && !window.v6ExitBoundary.layers) {
        window.v6ExitBoundary.layers=[paper,...scrims].map(node=>node.getAnimations()
          .find(animation=>animation.effect.getTiming().duration===260)?.effect.getTiming().duration ?? null);
      }
      if(paper.isConnected)return;
      observer.disconnect();
      window.v6ExitBoundary.oldScrims=scrims.filter(node=>node.isConnected).length;
      window.v6ExitBoundary.bodyLocked=leaf.inert || footer.inert;
      if(!window.v6ExitBoundary.bodyLocked)next.click();
    });
    observer.observe(document.querySelector('.config-book'), {subtree:true,childList:true,attributes:true,attributeFilter:['data-exiting']});
  })()`);
  await click(element('.config-sheet .config-save-btn'));
  await until(() => ev("window.v6ExitBoundary?.oldScrims !== undefined"), 'M2 and M6 exit committed together');
  const boundary = await ev('window.v6ExitBoundary');
  assert.deepEqual(boundary, { layers:[260, 260, 260], oldScrims:0, bodyLocked:false }, '纸笺和两层压暗同步退出，正文与页脚同帧解锁');
  await until(() => ev("document.querySelector('.config-sheet h3')?.textContent==='编辑对话' && document.activeElement?.matches('.config-sheet select')"), 'next paper opens and takes focus');
  await until(() => ev('window.v6FeedbackTrace.length>0'), 'previous save feedback reaches summary while next sheet is open');
  assert.equal(await ev("document.activeElement?.matches('.config-sheet select')"), true, '上一张纸笺的返回焦点不能抢走新纸笺焦点');
  assert.deepEqual(await ev('window.v6FeedbackTrace'), [{ row:'model:memory', exiting:false, sweep:600, duration:360, delay:90 }]);
  await click(element('.config-sheet .config-sheet-x'));
  await until(() => ev("!document.querySelector('.config-sheet,.config-scrim,.config-book-scrim,.config-leaf-body[inert]')"), 'second paper completes its own exit');
  return boundary;
}

check(async context => {
  const bundle = await context.ev("document.querySelector('script[type=module][src]')?.src.split('/').pop()");
  const layout = await verifyLongTextAndContrast(context);
  const feedback = await verifySaveFeedback(context);
  const immediateSuccessor = await verifyImmediateSuccessor(context);
  fs.writeFileSync(path.join(context.out, 'v6-behavior.json'), JSON.stringify({ bundle, ...layout, feedback, immediateSuccessor }, null, 2));
  assert.deepEqual(context.errors, []);
  assert.deepEqual(layout.problems, []);
  console.log(JSON.stringify({ bundle, longText:true, forcedColors:true, settingsSummary:true, reducedMotion:true, feedback, immediateSuccessor }, null, 2));
});
