'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { backendDir } = require('../helpers/paths.cjs');
const { withDesktop, until } = require('../helpers/live-desktop.cjs');

async function run() {
  const { tsImport } = createRequire(path.join(backendDir, 'package.json'))('tsx/esm/api');
  const { createFixtureWithModel, ScriptedChatModel } = await tsImport(
    pathToFileURL(path.join(backendDir, 'tests/fixtures/conversation-fixture.ts')).href, __filename);
  const stop = {type:'completed', stopReason:'stop'};
  const say = text => [{type:'text_delta', text}, stop];
  const start = (id, prompt) => ({type:'tool_call', callId:id, name:'pi_task_start', arguments:{extId:id, prompt}});
  const model = new ScriptedChatModel([say('等候委托'), [start('alpha','编写目录'), start('beta','复核索引'), stop],
    say('已分派两项工程'), say('目录已取消'), say('索引已经交付')]);
  const f = createFixtureWithModel(model, {disablePresetAssistant:false, presetAssetsDir:path.join(backendDir,'tests/fixtures')});
  const upstream = http.createServer();
  const replies = new Set();
  upstream.on('request', (req,res) => {
    req.resume();
    replies.add(res);
    res.once('close', () => replies.delete(res));
  });
  try {
    upstream.listen(0,'127.0.0.1');
    await once(upstream,'listening');
    const { app } = f;
    app.server.listen(0,'127.0.0.1');
    await once(app.server,'listening');
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const roleId = app.appStore.getRoleIndexByBuiltinKey('xiacheng').roleId;
    const windowId = app.services.roles.initializeRole(roleId).defaultWindowId;
    const resource = app.services.resources.create({kind:'model',name:'本地工程',config:{
      protocol:'openai-chat',baseUrl:'http://127.0.0.1:' + upstream.address().port + '/v1'}});
    const [pi] = app.services.resources.listBindings(roleId);
    app.services.resources.replaceBindings(roleId,[{resourceId:pi.resourceId,capability:'mcp',enabled:true},
      {resourceId:resource.resourceId,capability:'chat_model',modelName:'offline',enabled:true}]);
    app.services.activity.resume(roleId);
    await app.conversation.waitForIdle(roleId,30000);
    await withDesktop(base, async ({cmd,ev,wait}) => {
      await wait("!!document.querySelector('.ui-studio-brand')",'首页');
      const dock = label => ev("[...document.querySelectorAll('.ui-dock-item')].find(b=>b.textContent.includes(" + JSON.stringify(label) + ")).click()");
      const choose = async name => {
        await wait("!!document.querySelector('.dialogue-role-switch button')",'角色选择');
        const selected = "document.querySelector('.dialogue-role-switch button')?.getAttribute('aria-label')?.includes(" + JSON.stringify(name) + ")";
        if (await ev(selected)) return;
        await ev("document.querySelector('.dialogue-role-switch button').click()");
        await ev("[...document.querySelectorAll('.dialogue-role-switch [role=menuitem]')].find(b=>b.textContent.includes("+JSON.stringify(name)+")).click()");
        await wait(selected,'已切换到'+name);
      };
      await dock('对话');
      await choose('阿澄');
      await wait("!!document.querySelector('#dialogue-draft')",'普通角色可输入');
      await ev("document.querySelector('#dialogue-draft').focus()");
      app.conversation.submitMessage(roleId,windowId,{content:'编写目录并复核索引',submissionId:crypto.randomUUID(),sourcePlatform:'nowadays'});
      const rows = "document.querySelectorAll('.engineering-row')";
      try { await wait(rows+'.length===2','两张进度胶囊'); }
      catch (error) {
        console.error({jobs:app.services.pi.running(), tasks:app.conversation.listTasks(roleId).map(t=>[t.goal,t.status,t.endReason]),
          requests:model.requests.map(r=>r.messages.at(-1)?.content?.slice(0,120)), view:await ev('document.body.innerText.slice(-900)')});
        throw error;
      }
      await wait("/工程进行中 · 0:0[1-9]/.test(document.querySelector('.engineering-row small').textContent)",'本地耗时更新');
      assert.equal(await ev("document.activeElement.id==='dialogue-draft'"),true);
      await dock('桌面');
      await wait("document.querySelector('.studio-shell').dataset.page==='home' && "+rows+'.length===2','跨页进度');
      await dock('对话');
      await choose('夏澄');
      await wait("document.body.innerText.includes('已分派两项工程')",'原窗已显示分派');
      await until(()=>replies.size===2,'两个真实 Pi worker 正在等待离线模型');
      const list = await (await fetch(base+'/v1/engineering/jobs')).json();
      assert.deepEqual(list.items.map(item=>item.extId).sort(),['alpha','beta']);
      assert.ok(list.items.every(item=>item.status==='running' && item.roleId===roleId));
      await cmd('Emulation.setDeviceMetricsOverride', {width:720, height:540, deviceScaleFactor:1, mobile:false});
      await wait("innerWidth===720 && document.querySelector('.engineering-summary').offsetHeight>0", '窄屏单行摘要');
      assert.equal(await ev("document.querySelector('.engineering-summary').textContent"), '后台工程 2 项');
      assert.equal(await ev("document.querySelector('.engineering-jobs').offsetHeight"), 0);
      const column = await ev("document.querySelector('.studio-floating-column').getBoundingClientRect().toJSON()");
      assert.deepEqual([column.x, column.bottom, column.height].map(Math.round), [24,436,40]);
      assert.ok(column.width <= 320);
      async function hit(selector) {
        const point = await ev(`(() => {
          const node = document.querySelector(${JSON.stringify(selector)});
          node.scrollIntoView({block:'nearest'});
          const rect = node.getBoundingClientRect(), x = rect.x + rect.width/2, y = rect.y + rect.height/2;
          return {x,y,reachable:node.contains(document.elementFromPoint(x,y))};
        })()`);
        assert.ok(point.reachable, selector);
        for (const type of ['mousePressed','mouseReleased']) await cmd('Input.dispatchMouseEvent', {type, x:point.x, y:point.y, button:'left', clickCount:1});
      }
      await hit('.engineering-summary');
      assert.ok(await ev("document.querySelector('.studio-floating-column').offsetHeight<=192"));
      await hit('[aria-label="取消工程 alpha"]');
      await wait(rows+".length===1 && document.querySelector('.engineering-row strong').textContent==='复核索引'",'仅取消选中工程');
      await wait("document.body.innerText.includes('目录已取消')",'角色接到单项取消回执');
      assert.equal(app.services.pi.running()[0].extId,'beta');
      for (const res of replies) {
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        res.end('data: '+JSON.stringify({id:'demo',model:'offline',choices:[{index:0,delta:{role:'assistant',content:'索引复核通过'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
      }
      await wait(rows+".length===0 && document.body.innerText.includes('索引已经交付')",'自动回原窗交付并撤下胶囊');
      assert.equal(app.services.messages.list(roleId,windowId,null,30).items.filter(m=>m.sender==='user').length,1);
      assert.equal(app.conversation.listTasks(roleId).find(t=>t.goal.includes('编写目录')).status,'completed');
    });
  } finally {
    await f.close();
    upstream.closeAllConnections();
    await new Promise(resolve=>upstream.close(resolve));
  }
}
run().catch(error=>{console.error(error);process.exitCode=1});
