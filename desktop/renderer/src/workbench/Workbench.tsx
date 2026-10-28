import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AsyncBoundary, BrandMark, Button, CancelButton, Checkbox, ConfirmButton, ConfirmProvider, ControlButton, Disclosure, DropdownMenu, Empty, Field, Icon, IconButton, Input, Modal, SearchInput, Select, Switch, Tag, Textarea, UiThemeScope, useConfirm, type IconName } from '../ui';
import { DraftProtectionProvider, useDraftProtection } from '../components/DraftProtectionProvider';
import { useDraftRegistration } from '../lib/use-draft-registration';
import { hashRevision } from '../lib/drafts/registry';
import character from '../../../../devDoc/design/character-studio/xiacheng.png';
import scene from '../../../../devDoc/design/character-studio/scene-ink.png';

const sections = [['type', '字体'], ['actions', '动作'], ['fields', '输入'], ['behavior', '交互'], ['states', '状态']] as const;
const navItems: Array<{ id: string; label: string; icon: IconName }> = [
  { id: 'home', label: '桌面', icon: 'overview' }, { id: 'roles', label: '关系', icon: 'accounts' },
  { id: 'models', label: '模型', icon: 'bolt' }, { id: 'library', label: '收藏', icon: 'artifacts' }
];
const menuLabels = ['主页', '总览', '实例与监听', '资料与角色', '插件与 Skill', '模型配置', '事件诊断', '应用设置', '资源库'];
const originalNote = '喜欢傍晚的光，也喜欢听你慢慢说。';
const sampleAccounts = ['白昼来信', '晚风电台', '一个名字很长但仍然应该完整展示的样例账号'];

function Section({ id, number, title, description, children }: { id: string; number: string; title: string; description: string; children: ReactNode }) {
  return <section className="wb-section" id={id} aria-labelledby={`${id}-title`}>
    <header className="wb-section-head"><span className="wb-number">{number}</span><div><h2 id={`${id}-title`}>{title}</h2><p>{description}</p></div></header>
    <div className="wb-section-body">{children}</div>
  </section>;
}

function DraftEditor({ open, onClosed }: { open: boolean; onClosed: () => void }) {
  const [note, setNote] = useState(originalNote);
  const [saved, setSaved] = useState(originalNote);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { requestTransition } = useDraftProtection();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useDraftRegistration({ id: 'workbench-editor', owner: 'page', label: '便签样例', enabled: open,
    dirty: note !== saved, busy: saving, revision: hashRevision(note), discard: () => setNote(saved) });
  const close = async () => {
    const result = await requestTransition({ scope: { kind: 'ids', ids: ['workbench-editor'] }, actionLabel: '关闭便签' });
    if (result.ok) { setMessage(''); onClosed(); }
    else if (result.reason !== 'cancelled') setMessage(result.message ?? '暂时无法关闭，请稍后重试。');
  };
  const save = () => {
    if (timer.current || !note.trim()) return;
    setSaving(true); setMessage('');
    timer.current = setTimeout(() => { timer.current = undefined; setSaved(note); setSaving(false); setMessage('样例已保存，仅保留在本页。'); }, 650);
  };
  return <Modal open={open} title="给日常留一句话" description="编辑后尝试关闭，检查未保存提醒和嵌套确认。这里只保存本页样例。"
    onClose={() => { void close(); }} closeDisabled={saving}>
    <div className="ui-modal-content wb-editor">
      <Field label="便签内容" hint="关闭确认取消后，输入和光标上下文应保留。" error={!note.trim() ? '请写一句话，再保存样例。' : undefined}>
        <Textarea data-autofocus value={note} disabled={saving} onChange={event => setNote(event.target.value)} />
      </Field>
      <p role="status" className="wb-caption">{message || (note !== saved ? '有未保存的修改' : '当前没有未保存的修改')}</p>
    </div>
    <footer className="ui-dialog-actions"><CancelButton disabled={saving} onClick={() => { void close(); }}>关闭便签</CancelButton>
      <ConfirmButton busy={saving} disabled={!note.trim()} onClick={save}>{saving ? '保存中…' : '保存样例'}</ConfirmButton></footer>
  </Modal>;
}

export function WorkbenchRoot() {
  const [reduced, setReduced] = useState(false);
  return <ConfirmProvider><UiThemeScope theme="xiacheng" motion={reduced ? 'reduced' : undefined} className="wb-root">
    <DraftProtectionProvider><Workbench reduced={reduced} onReduced={setReduced} /></DraftProtectionProvider>
  </UiThemeScope></ConfirmProvider>;
}

function Workbench({ reduced, onReduced }: { reduced: boolean; onReduced: (value: boolean) => void }) {
  const [account, setAccount] = useState('白昼来信');
  const [navigation, setNavigation] = useState('home');
  const [menuSelection, setMenuSelection] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [reply, setReply] = useState(true);
  const [replyBusy, setReplyBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [search, setSearch] = useState('');
  const [brokenArt, setBrokenArt] = useState(false);
  const [artFailed, setArtFailed] = useState(false);
  const [state, setState] = useState('stale');
  const [name, setName] = useState('白昼来信');
  const [touched, setTouched] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [fileName, setFileName] = useState('尚未选择文件');
  const [iconMessage, setIconMessage] = useState('');
  const [queueMessage, setQueueMessage] = useState('');
  const confirmation = useRef<AbortController | undefined>(undefined);
  const confirm = useConfirm();
  const jobs = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => { for (const timer of jobs.current.values()) clearTimeout(timer); jobs.current.clear(); confirmation.current?.abort(); }, []);
  const checkQueue = async () => {
    if (confirmation.current) return;
    const controller = new AbortController(); confirmation.current = controller;
    setQueueMessage('两个确认按顺序等待处理。');
    const results = await Promise.all([
      confirm({ title: '队列第一项', description: '确认后继续第二项；每项初始焦点都应位于取消。', confirmLabel: '确认第一项', signal: controller.signal }),
      confirm({ title: '队列第二项', description: '第二项应继承调用处主题，并重新聚焦取消按钮。', confirmLabel: '确认第二项', signal: controller.signal })
    ]);
    if (!controller.signal.aborted) { setQueueMessage(`队列已结束：${results.map(result => result ? '确认' : '取消').join('、')}。`); confirmation.current = undefined; }
  };
  const later = (id: string, done: () => void) => {
    if (jobs.current.has(id)) return false;
    jobs.current.set(id, setTimeout(() => { jobs.current.delete(id); done(); }, 650)); return true;
  };
  const save = () => {
    if (later('save', () => setSaveState(failure ? 'error' : 'success'))) setSaveState('saving');
  };
  const toggleReply = (value: boolean) => {
    if (later('reply', () => { setReply(value); setReplyBusy(false); })) setReplyBusy(true);
  };
  return <div className="wb-sheet">
    <header className="wb-header">
      <a href="#top" className="wb-brand" aria-label="Nowadays 组件手账顶部"><BrandMark/><span>Nowadays<small>A NOTE FOR YOUR EVERYDAY.</small></span></a>
      <div className="wb-account-tabs ui-account-tabs" role="group" aria-label="样例账号选择">{(account === sampleAccounts[2] ? [sampleAccounts[0], account] : sampleAccounts.slice(0,2)).map(label => <ControlButton key={label} title={label} aria-pressed={account === label} onClick={() => setAccount(label)}>{label}</ControlButton>)}</div>
      <div className="wb-header-end"><Tag>组件样板 · 本地示例</Tag><DropdownMenu label="全部菜单" items={menuLabels.map((label, index) => ({ id: String(index), label, onSelect: () => setMenuSelection(label) }))} /></div>
    </header>

    <main id="top">
      <section className="wb-intro" aria-labelledby="workbench-title">
        <div className="wb-intro-copy"><p className="wb-eyebrow">CHARACTER STUDIO / UI NOTEBOOK 01</p><h1 id="workbench-title">把设计，<br /><span>写进每一次操作。</span></h1>
          <p className="wb-lead">从一行文字，到一次按下。<br />让日常的每个小动作，都有自己的样子。</p>
          <div className="wb-intro-actions"><Button variant="entry" onClick={() => setEditorOpen(true)}>打开便签样例</Button><a href="#actions" className="wb-text-link">翻到组件页 <span aria-hidden="true">↗</span></a></div>
          <p className="wb-caption">开发用组件手账。操作仅在本页模拟，不连接 QQ、不调用模型。</p>
        </div>
        <figure className={`wb-scene${brokenArt || artFailed ? ' wb-scene-fallback' : ''}`}>
          {brokenArt || artFailed ? <div className="wb-scene-empty"><Icon name="user" size={32} /><p>主题插画暂时不可用</p><span>文字与操作依然可用。</span></div> : <><img className="wb-scene-background" src={scene} alt="" onError={() => setArtFailed(true)} /><img className="wb-character" src={character} alt="夏澄主题插画：穿粉色开衫、手持红色手账的女孩" onError={() => setArtFailed(true)} /></>}
          <figcaption className="wb-scene-label"><span>主页主题 / 夏澄</span><strong>XIA CHENG</strong></figcaption>
          <div className="wb-note" aria-hidden="true">把普通的日子，<br />认真地收藏起来。</div>
        </figure>
      </section>

      <nav className="wb-index" aria-label="组件目录">{sections.map(([id, label], index) => <a key={id} href={`#${id}`}><span>0{index + 1}</span>{label}</a>)}<span className="wb-index-end">PAPER / NAVY / NOTEBOOK RED</span></nav>

      <Section id="type" number="01" title="文字先有秩序" description="一套清楚的层级，比更多装饰更耐看。">
        <div className="wb-type-sheet"><div className="wb-type-row"><code>32 / 40 · 700</code><p className="wb-type-page">给今天，留一点余白。</p></div>
          <div className="wb-type-row"><code>20 / 28 · 600</code><p className="wb-type-section">每段关系，各有角色</p></div>
          <div className="wb-type-row"><code>14 / 22 · 400</code><p>把小事慢慢说，把普通的日子认真过。<br />The little things make an ordinary day yours.</p></div>
          <div className="wb-type-row"><code>12 / 18 · 400</code><p className="wb-caption">辅助说明保持可读。ID <span className="wb-mono">sample/account-01 · v1.0.1</span></p></div></div>
      </Section>

      <Section id="actions" number="02" title="一次按下，也有手感" description="深蓝负责提交，手账红引导进入。焦点、等待和结果各有明确位置。">
        <div className="wb-action-line"><Button variant="entry" onClick={() => setEditorOpen(true)}>进入工作台样例</Button><ConfirmButton onClick={save}>保存配置样例</ConfirmButton><CancelButton>取消返回</CancelButton><Button variant="ghost">查看详情</Button><IconButton icon="copy" label="复制按钮样例" onClick={() => setIconMessage('图标按钮已触发；样板不写入系统剪贴板。')} /></div>
        {iconMessage ? <p className="wb-caption" role="status">{iconMessage}</p> : null}
        <div className="wb-state-grid" aria-label="按钮八种状态">
          <div><span>DEFAULT / 默认</span><Button variant="primary">保存配置</Button></div>
          <div><span>HOVER / 悬停</span><Button variant="primary" data-preview-state="hover">保存配置</Button></div>
          <div><span>FOCUS / 焦点</span><Button variant="primary" data-preview-state="focus">保存配置</Button></div>
          <div><span>PRESSED / 按下</span><Button variant="primary" data-preview-state="pressed">保存配置</Button></div>
          <div><span>DISABLED / 禁用</span><Button variant="primary" disabled>保存配置</Button></div>
          <div><span>LOADING / 进行中</span><Button variant="primary" busy>保存中…</Button></div>
          <div><span>ERROR / 失败</span><Button feedback="error">重试保存</Button></div>
          <div><span>SUCCESS / 完成</span><Button feedback="success">已保存</Button></div>
        </div>
      </Section>

      <Section id="fields" number="03" title="输入时，少一点打扰" description="标签始终在场；说明、错误和输入内容各司其职。">
        <div className="wb-form-grid"><div className="wb-stack">
          <Field label="显示名称" hint="在离开输入框后检查，错误不清空输入。" error={touched && !name.trim() ? '名称不能为空，请填写一个显示名称。' : undefined}><Input value={name} onBlur={() => setTouched(true)} onChange={event => setName(event.target.value)} /></Field>
          <Field label="查找角色" hint="支持键盘操作，搜索有独立可访问名称。"><SearchInput label="查找角色" placeholder="角色名称" value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Field label="账号标识（只读）" hint="可以选中复制。"><Input className="wb-mono" value="sample/account-01" readOnly /></Field>
          <Field label="未配置字段（禁用）"><Input value="请先选择一个账号" disabled /></Field>
          <Field label="完整样例账号列表" hint="较长名称可以在这里完整选择，顶部仍显示当前选中项。"><Select value={account} onChange={event => setAccount(event.target.value)}>{sampleAccounts.map(label => <option key={label} value={label}>{label}</option>)}</Select></Field>
        </div><div className="wb-stack">
          <Field label="选择模型能力"><Select defaultValue="text"><option value="text">文本对话</option><option value="image">图像理解</option><option value="voice">语音</option></Select></Field>
          <Field label="错误样例" hint="错误会关联到对应字段。" error="缺少模型名称，请选择或输入一个可用名称。"><Input placeholder="例如：模型名称" /></Field>
          <Field label="角色便签" hint="正文14px；保留自然换行和编辑空间。"><Textarea defaultValue={originalNote} /></Field>
        </div></div>
        <div className="wb-form-grid wb-extra-fields"><div className="wb-stack">
          <Field label="密钥样例" hint="这是固定演示字符串，默认遮盖，不是真实密钥。"><Input type={showKey ? 'text' : 'password'} value="sample-key-not-a-secret" autoComplete="off" readOnly /></Field>
          <div><Button size="sm" variant="ghost" aria-pressed={showKey} onClick={() => setShowKey(value => !value)}>{showKey ? '隐藏样例密钥' : '显示样例密钥'}</Button></div>
          <Field label="数值样例" hint="整数，范围0–100；使用原生数字输入行为。"><Input type="number" min={0} max={100} step={1} defaultValue={20} /></Field>
        </div><div className="wb-stack">
          <Field label="文件选择样例" hint="使用系统选择器；样板只显示文件名，不读取或上传内容。"><Input type="file" accept=".json,.png" onChange={event => setFileName(event.target.files?.[0]?.name ?? '尚未选择文件')} /></Field>
          <p className="wb-caption" role="status">{fileName}</p>
          <fieldset className="wb-radio-options"><legend>单选样例</legend><label><Input type="radio" name="sample-radio" value="local" defaultChecked />当前账号</label><label><Input type="radio" name="sample-radio" value="global" />公用定义</label></fieldset>
        </div></div>
        <div className="wb-checks"><label><Checkbox checked={reduced} onChange={event => onReduced(event.target.checked)} />减少动态效果</label><label><Checkbox checked={brokenArt} onChange={event => { setBrokenArt(event.target.checked); setArtFailed(false); }} />查看插画失败回退</label></div>
      </Section>

      <Section id="behavior" number="04" title="好看，也要经得起操作" description="真实公共组件和草稿保护机制，配合本页的隔离样例数据。">
        <div className="wb-behavior-grid"><div className="wb-interaction"><h3>反馈留在动作旁边</h3><Switch label="自动回复样例" checked={reply} busy={replyBusy} onCheckedChange={toggleReply} /><p className="wb-caption">开关只改变本页样例。配置开启与实际连接状态分别表达。</p>
          <div className="wb-action-line"><Button variant="primary" busy={saveState === 'saving'} feedback={saveState === 'error' ? 'error' : saveState === 'success' ? 'success' : undefined} onClick={save}>{saveState === 'saving' ? '保存中…' : saveState === 'error' ? '重试保存样例' : saveState === 'success' ? '样例已保存' : '保存样例'}</Button><Button onClick={() => setEditorOpen(true)}>检查弹窗与草稿</Button></div>
          <label className="wb-check-line"><Checkbox checked={failure} onChange={event => setFailure(event.target.checked)} />下次保存模拟失败</label>
          <div><Button size="sm" onClick={() => { void checkQueue(); }}>检查确认队列</Button></div>
          {queueMessage ? <p className="wb-caption" role="status">{queueMessage}</p> : null}
          <p className="wb-caption" role="status">{saveState === 'error' ? '样例保存失败，原内容仍保留，可以重试。' : saveState === 'success' ? '样例已保存，仅保留在当前页面。' : saveState === 'saving' ? '正在处理样例，请稍候。' : '加载时保持按钮宽度与焦点，重复触发不会新增操作。'}</p>
        </div><div className="wb-interaction"><h3>导航与账号各有语义</h3><nav className="ui-page-dock" aria-label="页面导航样例">{navItems.map(item => <ControlButton key={item.id} aria-current={navigation === item.id ? 'page' : undefined} onClick={() => setNavigation(item.id)}><Icon name={item.icon} size={20} /><span>{item.label}</span></ControlButton>)}</nav>
          <p className="wb-caption" role="status">当前样例：{account} / {navItems.find(item => item.id === navigation)?.label}。这里只演示选中状态。</p>
          <div className="wb-tags"><Tag tone="ok">已保存</Tag><Tag tone="warn">等待连接</Tag><Tag tone="bad">读取失败</Tag><Tag tone="busy">正在读取</Tag><Tag>未知</Tag></div>
          <p className="wb-caption">标签同时使用文字。展开、选中、配置开启和连接成功互不冒充。</p>
          <Disclosure title="文本能力 · 抽屉样例" description="收起时保留输入，隐藏内容不参与键盘导航。"><Field label="抽屉内模型样例"><Input defaultValue="sample-model" /></Field></Disclosure>
        </div></div>
      </Section>

      <Section id="states" number="05" title="没有数据时，也说清楚" description="确认无数据、读取失败和上次数据，使用不同表达。">
        <div className="wb-async-controls ui-segmented-controls" role="group" aria-label="异步状态样例">{[['loading', '读取中'], ['empty', '确实为空'], ['error', '首次失败'], ['stale', '旧数据过期'], ['ready', '读取成功']].map(([id, label]) => <ControlButton key={id} aria-pressed={state === id} onClick={() => setState(id)}>{label}</ControlButton>)}</div>
        <div className="wb-async-example"><AsyncBoundary loading={state === 'loading'} hasData={state === 'stale' || state === 'ready'} error={state === 'error' || state === 'stale' ? '样例连接暂时不可用' : undefined} onRetry={() => setState('ready')} empty={<Empty title="还没有角色绑定" description="成功读取后，确认当前账号暂无绑定。" action={<Button onClick={() => setEditorOpen(true)}>打开编辑样例</Button>} />}>
          <div className="wb-ledger-row"><span className="wb-ledger-avatar" aria-hidden="true">澄</span><div><strong>海边放映室 <span aria-hidden="true">→</span> 夏澄</strong><p>明确标记的角色绑定样例 · 群聊 / sample-peer</p></div><Tag tone={state === 'stale' ? 'warn' : 'ok'}>{state === 'stale' ? '上次读取的数据' : '读取成功'}</Tag></div>
        </AsyncBoundary></div>
      </Section>
    </main>
    <footer className="wb-footer"><span>Nowadays / 组件手账</span><span>字体 · 控件 · 行为 · 边界</span><a href="#top">返回页首 ↑</a></footer>
    <DraftEditor open={editorOpen} onClosed={() => setEditorOpen(false)} />
    <Modal open={Boolean(menuSelection)} title={`${menuSelection} · 入口样例`} description="菜单的焦点、键盘和关闭行为来自公共组件。正式页面将在后续迁移时接回，本样板不跳转业务。" onClose={() => setMenuSelection('')}>
      <div className="ui-modal-content"><p>你选择了「{menuSelection}」。关闭后焦点回到菜单触发位置。</p></div><footer className="ui-dialog-actions"><ConfirmButton onClick={() => setMenuSelection('')}>关闭样例</ConfirmButton></footer>
    </Modal>
  </div>;
}
