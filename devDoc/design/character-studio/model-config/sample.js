(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const capabilities = [
    { id: 'chat', number: '01', name: '文本模型', short: '日常对话', icon: 'messages', model: 'everyday-chat', description: '负责日常对话，也承接工具调用后的续答。' },
    { id: 'image.understand', number: '02', name: '视觉模型', short: '理解图片', icon: 'overview', model: 'everyday-vision', description: '读懂图片里的内容，为对话补上看见的部分。' },
    { id: 'video.understand', number: '03', name: '视频模型', short: '阅读片段', icon: 'play', model: 'video-understand', description: '理解视频附件或短片段，补充动态画面中的信息。' },
    { id: 'image.generate', number: '04', name: '图片生成', short: '按需创作', icon: 'plus', model: 'image-create', description: '作为对话工具按需调用，把想法变成图片。' },
    { id: 'audio.generate', number: '05', name: '语音生成', short: '用声音回应', icon: 'radio', model: 'voice-generate', description: '作为对话工具按需调用，用合适的音色表达。' }
  ];
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const escapeText = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  let current = 'chat', currentTab = 'service', keyVisible = false, toastTimer;
  const dialogSources = new WeakMap();
  const makeDraft = capability => ({ provider: capability.id === 'chat' ? 'everyday' : 'new', adapter: 'openai-compatible-v1', url: capability.id === 'chat' ? 'https://api.example.com/v1' : '', key: '', model: capability.id === 'chat' ? capability.model : '', tools: capability.id === 'chat', voice: 'gentle', hasKey: capability.id === 'chat', credentialOrigin: capability.id === 'chat' ? 'https://api.example.com' : '' });
  const drafts = Object.fromEntries(capabilities.map(capability => [capability.id, makeDraft(capability)]));
  const baselines = structuredClone(drafts), busy = new Set(), results = {};
  const generations = Object.fromEntries(capabilities.map(capability => [capability.id, 0]));
  const dirty = id => JSON.stringify(drafts[id]) !== JSON.stringify(baselines[id]);
  const status = id => dirty(id) ? '待保存' : drafts[id].model ? '已配置' : '未配置';

  function renderIndex() {
    const focused = document.activeElement?.dataset.cap;
    for (const [target, items] of [['primary-capabilities', capabilities.slice(0, 3)], ['extra-capabilities', capabilities.slice(3)]]) {
      $(target).innerHTML = items.map(capability => `<button type="button" class="cap-button" data-cap="${capability.id}" aria-pressed="${current === capability.id}">${icon(capability.icon)}<span class="cap-copy"><strong>${capability.name}</strong><small>${drafts[capability.id].model ? escapeText(drafts[capability.id].model) : capability.short}</small></span><span class="cap-state" aria-hidden="true">${current === capability.id ? '↗' : ''}</span></button>`).join('');
    }
    if (focused) document.querySelector(`[data-cap="${focused}"]`)?.focus({ preventScroll: true });
  }
  function showToast(text) {
    clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }
  function setTheme(theme) {
    const selected = theme === 'nightwave' ? 'nightwave' : 'daylight';
    document.documentElement.dataset.uiPreset = selected;
    $$('[data-theme]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.theme === selected)));
    try { localStorage.setItem('nowadays.model-design.theme', selected); } catch { /* 离线存储不可用仍可切换。 */ }
  }
  let storedTheme;
  try { storedTheme = localStorage.getItem('nowadays.model-design.theme'); } catch { /* 仅外观偏好。 */ }
  const queryTheme = new URLSearchParams(location.search).get('theme');
  setTheme(queryTheme || storedTheme);
  $$('[data-theme]').forEach(button => button.addEventListener('click', () => setTheme(button.dataset.theme)));

  function setTab(tab) {
    currentTab = tab;
    $$('[data-tab]').forEach(button => { const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    $('service-view').hidden = tab !== 'service'; $('account-view').hidden = tab !== 'account';
  }
  $$('[data-tab]').forEach(button => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'service' : event.key === 'End' ? 'account' : currentTab === 'service' ? 'account' : 'service';
      setTab(next); $(next + '-tab').focus();
    });
  });
  $('go-account').onclick = () => { setTab('account'); $('account-tab').focus(); };
  $('go-service').onclick = () => { setTab('service'); $('service-tab').focus(); };
  function renderStatus() {
    const draft = drafts[current], changed = dirty(current);
    $('cap-status').innerHTML = `<span class="status-dot ${changed ? 'dirty' : draft.model ? '' : 'idle'}"></span>${status(current)}${!changed && draft.model ? ' · 示例' : ''}`;
    $('save-note').dataset.saved = 'false';
    $('save-note').innerHTML = icon(changed ? 'folder' : 'shield') + `<span>${changed ? '有修改尚未保存' : '当前配置为样例数据'}</span>`;
  }
  function renderOutput() {
    const result = results[current];
    $('test-output').dataset.tone = result?.tone || '';
    $('test-output').innerHTML = icon(result?.icon || 'radio') + `<div><strong>${escapeText(result?.title || '等一次小小的回应')}</strong><p>${escapeText(result?.detail || '点击“测试连接”，查看此处的结果反馈。测试与保存是两个独立操作。')}</p></div>`;
  }
  const buttonDefinitions = { models: ['fetch-models', 'refresh', '获取模型'], test: ['test-connection', 'play', '测试连接'], save: ['save-model', 'check', '保存配置'] };
  const operations = {};
  function setBusyUI() {
    const active = busy.has(current), operation = operations[current];
    for (const [kind, [id, glyph, text]] of Object.entries(buttonDefinitions)) {
      $(id).setAttribute('aria-disabled', String(active));
      const pending = active && operation === kind;
      $(id).innerHTML = icon(pending ? 'refresh' : glyph) + `<span>${pending ? kind === 'models' ? '获取中…' : kind === 'test' ? '测试中…' : '保存中…' : text}</span>`;
    }
    $('model-form').setAttribute('aria-busy', String(active));
  }
  function renderEditor() {
    const capability = capabilities.find(capability => capability.id === current), draft = drafts[current];
    $('cap-number').textContent = capability.number; $('cap-title').textContent = capability.name; $('cap-description').textContent = capability.description;
    for (const [id, key] of [['provider', 'provider'], ['adapter', 'adapter'], ['base-url', 'url'], ['api-key', 'key'], ['model-name', 'model'], ['voice-name', 'voice']]) $(id).value = draft[key];
    $('tools-switch').setAttribute('aria-checked', String(draft.tools)); $('tools-row').hidden = current !== 'chat'; $('voice-row').hidden = current !== 'audio.generate';
    $('key-state').textContent = draft.hasKey ? '凭据已配置 · 示例' : '尚未配置';
    $('api-key').placeholder = draft.hasKey ? '留空，继续使用已配置的密钥' : 'sk-…（请勿填写真实密钥）';
    keyVisible = false; $('api-key').type = 'password'; $('reveal-key').textContent = '显示'; $('reveal-key').setAttribute('aria-label', '显示 API Key'); $('reveal-key').setAttribute('aria-pressed', 'false');
    $('adapter').querySelector('[value="video-polling-v1"]').hidden = current !== 'video.understand';
    $('form-error').hidden = true; ['base-url', 'model-name', 'api-key'].forEach(id => $(id).removeAttribute('aria-invalid'));
    renderStatus(); renderOutput(); setBusyUI();
  }
  function syncDraft() {
    Object.assign(drafts[current], { provider: $('provider').value, adapter: $('adapter').value, url: $('base-url').value, key: $('api-key').value, model: $('model-name').value, voice: $('voice-name').value, tools: $('tools-switch').getAttribute('aria-checked') === 'true' });
    generations[current]++; delete results[current]; renderStatus(); renderOutput();
    $$('[data-cap]').forEach(button => { if (button.dataset.cap === current) button.querySelector('small').textContent = drafts[current].model || capabilities.find(capability => capability.id === current).short; });
    $('form-error').hidden = true;
    ['base-url', 'model-name', 'api-key'].forEach(id => $(id).removeAttribute('aria-invalid'));
  }
  $('service-view').addEventListener('click', event => {
    const button = event.target.closest('[data-cap]'); if (!button || button.dataset.cap === current) return;
    current = button.dataset.cap; renderIndex(); renderEditor(); document.querySelector(`[data-cap="${current}"]`).focus({ preventScroll: true });
  });
  for (const id of ['adapter', 'base-url', 'api-key', 'model-name', 'voice-name']) $(id).addEventListener('input', syncDraft);
  $('provider').addEventListener('change', () => {
    const name = $('provider').value, capability = capabilities.find(capability => capability.id === current);
    Object.assign(drafts[current], { provider: name, url: name === 'everyday' ? 'https://api.example.com/v1' : name === 'local' ? 'http://127.0.0.1:11434/v1' : '', model: name === 'everyday' ? capability.model : name === 'local' ? 'local-model' : '', key: '', hasKey: name === 'everyday', credentialOrigin: name === 'everyday' ? 'https://api.example.com' : '' });
    generations[current]++; delete results[current]; renderEditor(); renderIndex();
  });
  $('tools-switch').onclick = () => { $('tools-switch').setAttribute('aria-checked', String($('tools-switch').getAttribute('aria-checked') !== 'true')); syncDraft(); };
  $('reveal-key').onclick = () => {
    keyVisible = !keyVisible; $('api-key').type = keyVisible ? 'text' : 'password'; $('reveal-key').textContent = keyVisible ? '隐藏' : '显示';
    $('reveal-key').setAttribute('aria-label', (keyVisible ? '隐藏' : '显示') + ' API Key'); $('reveal-key').setAttribute('aria-pressed', String(keyVisible));
  };
  function validate(needsModel = true) {
    let problem = '', field = '';
    const draft = drafts[current];
    try { if (!['http:', 'https:'].includes(new URL(draft.url).protocol)) throw 0; } catch { problem = '请填写有效的 HTTP 或 HTTPS 服务地址。'; field = 'base-url'; }
    if (!problem && needsModel && !draft.model.trim()) { problem = '请填写模型名称，或点击“获取模型”选择一个。'; field = 'model-name'; }
    if (!problem && !draft.hasKey && !draft.key && draft.provider !== 'local') { problem = '请填写一个演示用 API Key，或选择本机模型服务。'; field = 'api-key'; }
    if (!problem && draft.hasKey && new URL(draft.url).origin !== draft.credentialOrigin && !draft.key) { problem = '服务地址已改变，请重新输入演示用 API Key。'; field = 'api-key'; }
    if (problem) { $('form-error').textContent = problem; $('form-error').hidden = false; $(field).setAttribute('aria-invalid', 'true'); $(field).setAttribute('aria-describedby', [$(field).getAttribute('aria-describedby'), 'form-error'].filter(Boolean).join(' ')); $(field).focus(); return false; }
    return true;
  }
  async function simulate(kind) {
    if (busy.has(current)) return;
    if (!validate(kind !== 'models')) return;
    const id = current, generation = generations[id], scenario = $('scenario').value;
    busy.add(id); operations[id] = kind; setBusyUI();
    if (kind === 'test') { results[id] = { icon: 'refresh', title: '正在等待示例回应…', detail: '这段等待仅用于展示加载状态。' }; renderOutput(); }
    await new Promise(resolve => setTimeout(resolve, kind === 'save' ? 500 : 800));
    busy.delete(id); delete operations[id]; if (current === id) setBusyUI();
    if (generations[id] !== generation) {
      if (current === id) { results[id] = { icon: 'clock', title: '配置已修改，请重新测试', detail: '本次演示结果属于修改前的配置，不会覆盖当前草稿。' }; renderOutput(); }
      return;
    }
    if (kind === 'models') {
      if (current !== id) return;
      if (scenario === 'error' || scenario === 'unknown') {
        results[id] = { tone: scenario === 'error' ? 'error' : 'warning', icon: 'warning', title: scenario === 'error' ? '演示：模型列表获取失败' : '演示：获取超时，结果未知', detail: '当前草稿已保留，仍可手动填写模型名称。没有自动重试。' };
        renderOutput(); return;
      }
      $('model-options').innerHTML = scenario === 'empty' ? '<p>示例服务未返回模型。关闭后仍可手动填写模型名称。</p>' : [capabilities.find(capability => capability.id === id).model, 'example-balanced', 'example-fast'].map(model => `<button type="button" class="model-option" data-model="${model}">${model}</button>`).join('');
      openDialog($('models-dialog'), $('fetch-models')); return;
    }
    if (kind === 'test') {
      results[id] = scenario === 'error' ? { tone: 'error', icon: 'warning', title: '演示：API Key 验证失败', detail: '请检查密钥是否正确、是否有权限访问这个模型。当前填写内容已保留。' } : scenario === 'unknown' ? { tone: 'warning', icon: 'clock', title: '演示：请求超时，结果未知', detail: '没有自动重试。请确认服务状态后，再手动发起一次测试。' } : { tone: 'success', icon: 'check', title: '演示：连接测试通过', detail: '示例模型已返回回应。测试成功不会自动保存，也不会给任何账号授权。' };
      if (current === id) renderOutput(); return;
    }
    if (drafts[id].key) drafts[id].credentialOrigin = new URL(drafts[id].url).origin;
    drafts[id].hasKey = drafts[id].hasKey || Boolean(drafts[id].key); drafts[id].key = ''; baselines[id] = structuredClone(drafts[id]);
    if (current === id) {
      $('api-key').value = ''; $('key-state').textContent = drafts[id].hasKey ? '凭据已配置 · 示例' : '无需密钥 · 示例'; renderStatus();
      $('save-note').dataset.saved = 'true'; $('save-note').innerHTML = icon('check') + '<span>示例已保存 · 本页内有效</span>';
    }
    renderIndex();
  }
  $('fetch-models').onclick = () => simulate('models'); $('test-connection').onclick = () => simulate('test');
  $('model-form').onsubmit = event => { event.preventDefault(); simulate('save'); };
  function openDialog(dialog, source) { dialogSources.set(dialog, source); dialog.showModal(); (dialog.querySelector('[data-close-dialog]') || dialog.querySelector('button,input'))?.focus(); }
  $('settings').onclick = () => openDialog($('settings-dialog'), $('settings'));
  $$('[data-close-dialog]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
  $$('dialog').forEach(dialog => dialog.addEventListener('close', () => dialogSources.get(dialog)?.focus()));
  $('reduce-motion').onchange = event => { document.documentElement.dataset.motion = event.target.checked ? 'reduced' : 'full'; };
  $('model-options').onclick = event => { const button = event.target.closest('[data-model]'); if (!button) return; $('model-name').value = button.dataset.model; syncDraft(); $('models-dialog').close(); };

  const accountDrafts = { day: { authorized: true, bindings: ['everyday-chat', 'everyday-vision', '', '', ''] }, night: { authorized: false, bindings: ['', '', '', '', ''] } };
  const accountBaselines = structuredClone(accountDrafts); let selectedAccount = 'day';
  function renderAccount() {
    const state = accountDrafts[selectedAccount]; $('account-title').textContent = selectedAccount === 'day' ? '白昼来信' : '晚风电台'; $('authorize-provider').checked = state.authorized;
    $('binding-rows').innerHTML = capabilities.map((capability, index) => `<div class="binding-row">${icon(capability.icon)}<div><h3 id="binding-label-${index}">${capability.name}</h3><p>${capability.short}</p></div><select data-binding="${index}" aria-labelledby="binding-label-${index}" ${state.authorized ? '' : 'disabled'}><option value="">不启用</option>${state.authorized ? `<option value="${capability.model}" ${state.bindings[index] === capability.model ? 'selected' : ''}>${capability.model}</option>` : ''}</select></div>`).join('');
    $('account-save-note').textContent = JSON.stringify(state) === JSON.stringify(accountBaselines[selectedAccount]) ? '本页使用独立的示例账号数据' : '当前示例账号有修改尚未保存';
  }
  $('account-select').onchange = () => { selectedAccount = $('account-select').value; renderAccount(); };
  $('authorize-provider').onchange = () => { accountDrafts[selectedAccount].authorized = $('authorize-provider').checked; renderAccount(); };
  $('binding-rows').onchange = event => { if (event.target.matches('[data-binding]')) { accountDrafts[selectedAccount].bindings[Number(event.target.dataset.binding)] = event.target.value; $('account-save-note').textContent = '当前示例账号有修改尚未保存'; } };
  $('account-form').onsubmit = event => { event.preventDefault(); accountBaselines[selectedAccount] = structuredClone(accountDrafts[selectedAccount]); $('account-save-note').textContent = '示例账号配置已保存 · 本页内有效'; };
  $$('.ui-page-dock button').forEach(button => { button.onclick = () => { if (button.dataset.page === 'model-config') { $('main').focus(); return; } showToast(`这里只展示模型配置；“${button.textContent.trim()}”是全局导航的位置示意。`); }; });
  function alignDock() {
    const nav = document.querySelector('.ui-page-dock'), item = nav.querySelector('[aria-current=page]'), marker = nav.querySelector('.ui-dock-marker');
    Object.assign(marker.style, { width: item.offsetWidth + 'px', height: item.offsetHeight + 'px', top: item.offsetTop + 'px', transform: `translateX(${item.offsetLeft}px)` });
  }
  new ResizeObserver(alignDock).observe(document.querySelector('.ui-page-dock'));
  renderIndex(); renderEditor(); renderAccount(); alignDock();
})();
