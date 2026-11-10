import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { RoleListItem } from './types';
import { UiThemeScope, useMotionPolicy } from './ui';
import { useThemePreset, useThemeTransitionStrategy } from './ui/presets';
import { createRoleRequestGate, initialRelationUi, profileModel, reduceRelation, splitDefinition, visiblePacket, type RelationUi } from './relations/dossier.js';
import { loadRelationPacket } from './relations/load-dossier';
import { exlibrisThemeTransition } from './relations/exlibris-theme';

type Props = {
  roles: RoleListItem[];
  error: string;
  currentId: string;
  visit: number;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
};

const views = ['home', 'experiences', 'diary', 'profile'] as const;
const viewTitle = { experiences: '经历', diary: '日记', profile: '角色介绍' } as const;

function Arrow() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>;
}
function Back() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6-6-6 6 6 6" /></svg>;
}
function AccountsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20c.5-3.5 2.7-5.4 5.5-5.4s5 1.9 5.5 5.4M16 5.5a3 3 0 0 1 0 5.8M17.5 14.8c1.8.5 2.9 2.2 3 5.2" /></svg>;
}
function FoldIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h12l4 4v12H4V4Zm12 0v5h4M7 12h10M7 16h7" /></svg>;
}

export function Relations({ roles, error, currentId, visit, onSelect, onOpenSettings }: Props) {
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  useThemeTransitionStrategy(exlibrisThemeTransition);
  const [ui, dispatch] = useReducer(reduceRelation, currentId, initialRelationUi);
  const [selector, setSelector] = useState(false);
  const [turning, setTurning] = useState(false);
  const [portraitFailed, setPortraitFailed] = useState(false);
  const [evidenceText, setEvidenceText] = useState('');
  const [evidenceError, setEvidenceError] = useState('');
  const [fold, setFold] = useState({ on: false, reverse: false });
  const [enter, setEnter] = useState('');
  const gate = useRef(createRoleRequestGate());
  const homeTabs = useRef<Partial<Record<Exclude<RelationUi['view'], 'home'>, HTMLButtonElement>>>({});
  const lastHomeTab = useRef<Exclude<RelationUi['view'], 'home'>>('experiences');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const switchButtonRef = useRef<HTMLButtonElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number | undefined>(undefined);
  const night = preset === 'nightwave';
  const displayedUi = ui.roleId === currentId ? ui : initialRelationUi(currentId);
  const packet = visiblePacket(displayedUi);
  const listRole = roles.find(role => role.roleId === currentId);
  const profile = profileModel(displayedUi, listRole?.displayName ?? '');
  const definition = packet ? splitDefinition(packet.definitionText) : { quote: '', body: '' };
  const diary = packet?.diaries[ui.diaryIndex] ?? packet?.diaries[0];

  useEffect(() => { if (visit > 0) dispatch({ type: 'view', view: 'home' }); }, [visit]);
  useEffect(() => () => { if (enterTimer.current !== undefined) window.clearTimeout(enterTimer.current); }, []);
  useLayoutEffect(() => { if (sheetRef.current) sheetRef.current.scrollTop = 0; }, [ui.view, currentId]);
  useEffect(() => {
    if (!selector) return;
    const panel = selectorRef.current;
    if (!panel) return;
    const options = panel.querySelectorAll<HTMLButtonElement>('.person-option');
    const current = panel.querySelector<HTMLButtonElement>('.person-option[aria-pressed="true"]');
    (current ?? options[0])?.focus();
  }, [selector]);
  useEffect(() => {
    if (!selector) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.plate-switch')) setSelector(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [selector]);
  useEffect(() => {
    const onFold = (event: Event) => setFold((event as CustomEvent<{ on: boolean; reverse: boolean }>).detail);
    document.addEventListener('exlibris-fold', onFold);
    return () => document.removeEventListener('exlibris-fold', onFold);
  }, []);

  useEffect(() => {
    const ticket = gate.current.begin(currentId);
    dispatch({ type: 'switch', roleId: currentId });
    setPortraitFailed(false);
    setEvidenceText('');
    setEvidenceError('');
    setSelector(false);
    if (!currentId) return;
    const controller = new AbortController();
    setTurning(true);
    const motionTimer = window.setTimeout(() => setTurning(false), motion.reduced ? 0 : 950);
    loadRelationPacket(currentId, controller.signal, next => {
      if (!gate.current.accept(ticket)) return;
      dispatch({ type: 'loaded', roleId: currentId, packet: next });
    }).then(next => {
      if (!gate.current.accept(ticket)) return;
      dispatch({ type: 'loaded', roleId: currentId, packet: next });
    }).catch(reason => {
      if (controller.signal.aborted || !gate.current.accept(ticket)) return;
      dispatch({ type: 'failed', roleId: currentId, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => { controller.abort(); window.clearTimeout(motionTimer); };
  }, [currentId, motion.reduced]);

  // 资料分批到达时 packet 会多次更新；依据只在目标变化时重取，避免重复请求和闪动。
  const evidenceRoleId = packet?.roleId ?? '';
  const evidenceTarget = ui.evidenceId ? packet?.events.find(event => event.id === ui.evidenceId)?.evidenceIds[0] ?? '' : '';

  useEffect(() => {
    if (!ui.evidenceId || !packet) { setEvidenceText(''); return; }
    if (!evidenceTarget) { setEvidenceError('这条经历没有保存依据。'); return; }
    const controller = new AbortController();
    let active = true;
    setEvidenceText('');
    setEvidenceError('');
    void import('./api').then(({ api }) => api<{ content: string; occurredAt: string }>(
      `/v1/roles/${encodeURIComponent(evidenceRoleId)}/memory/evidence/${encodeURIComponent(evidenceTarget)}`,
      { signal: controller.signal }
    )).then(evidence => {
      if (active) setEvidenceText(`${evidence.occurredAt}\n${evidence.content}`);
    }).catch(reason => {
      if (!active || controller.signal.aborted) return;
      setEvidenceError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; controller.abort(); };
  }, [ui.evidenceId, evidenceTarget, evidenceRoleId]);

  const closeSelector = (restoreFocus: boolean) => {
    setSelector(false);
    if (restoreFocus) switchButtonRef.current?.focus();
  };

  const openView = (view: RelationUi['view'], focus?: HTMLButtonElement | null) => {
    if (ui.view === 'home' && view !== 'home' && focus) lastHomeTab.current = view;
    if (enterTimer.current !== undefined) window.clearTimeout(enterTimer.current);
    if (!motion.reduced) setEnter(view === 'home' ? 'home' : view);
    dispatch({ type: 'view', view });
    enterTimer.current = window.setTimeout(() => {
      setEnter('');
      if (view === 'home') homeTabs.current[lastHomeTab.current]?.focus();
      else titleRef.current?.focus();
    }, motion.reduced ? 0 : view === 'home' ? 360 : 900);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selector) { event.preventDefault(); closeSelector(true); return; }
      if (ui.view !== 'home') { event.preventDefault(); openView('home'); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const memoriesLoading = !!packet && (packet.pending.events || packet.pending.summaries);
  const previewEvent = packet?.events[0]?.title || (packet ? (memoriesLoading ? '正在读取' : packet.memoryError ? '经历暂时无法读取' : '还没有经历') : '正在读取');
  const previewDiary = packet?.diaries[0]?.title ? `「${packet.diaries[0].title}」` : (packet ? (packet.pending.diaries ? '正在读取' : packet.diaryError ? '日记暂时无法读取' : '还没有日记') : '正在读取');
  const pageCode = ui.view === 'home' ? '001' : String(views.indexOf(ui.view) + 1).padStart(3, '0');
  const sentence = packet ? (packet.sentence || '还没有写下近况') : (ui.error ? '' : currentId ? '正在读取近况' : '还没有角色');
  const personSwitch = (rail = false) => roles.length < 2 ? null : <div className={'plate-switch' + (rail ? ' in-rail' : '')}>
    <button type="button" ref={switchButtonRef} className="wj-action" aria-expanded={selector} onClick={() => setSelector(value => !value)}><AccountsIcon />换一位</button>
    {selector && <div className="person-selector" ref={selectorRef}>
      <div className="selector-head"><span>翻到另一位</span><button type="button" aria-label="关闭人物选择" onClick={() => closeSelector(true)}>×</button></div>
      <div className="person-options">{roles.map((role, index) => <button type="button" key={role.roleId} className="person-option" title={role.displayName} aria-pressed={role.roleId === currentId} onClick={() => { if (role.roleId !== currentId) onSelect(role.roleId); closeSelector(true); }}><span>{role.displayName}</span><small>{String(index + 1).padStart(2, '0')}</small></button>)}</div>
    </div>}
  </div>;

  return <UiThemeScope theme="xiacheng" preset={preset} motion={motion.reduced ? 'reduced' : 'full'} className="exlibris-host">
    <div className={'exlibris' + (enter === 'home' ? ' home-enter' : '')} data-theme={night ? 'night' : 'day'} data-motion={motion.reduced ? 'reduced' : 'full'}>
    <div className="relationship-stage">
      <div className={'book collection' + (fold.on ? ' illuminating' : '') + (fold.reverse ? ' reverse' : '') + (turning ? '' : '')} data-view={ui.view} id="collection">
        <div className="spread book-surface" aria-hidden="true"><div className="leaf left" /><div className="gutter" /><div className="leaf right" /></div>
        <div className="ribbon" aria-hidden="true" />
        <div className="book-thread" aria-hidden="true"><i /><i /></div>
        <div className="sheet-grain" aria-hidden="true" />
        <div className="backlight" aria-hidden="true"><div className="light-beam" /><div className="reverse-print"><span>日常来信</span><em>所藏的，是相遇。</em><svg viewBox="0 0 64 80"><path d="M31 74C15 48 22 27 45 8c8 29 0 50-17 52M29 61 45 8M32 48 23 35m13-1 11-9M31 57l12-10" /></svg></div></div>
        <div className="edition-strip strip" aria-hidden="true">
          <div className="letter-strip"><svg viewBox="0 0 450 70" preserveAspectRatio="none"><path d="M10 37h100l40-26 40 26 40-26 40 26h170M110 37l40 26 40-26 40 26 40-26" /></svg><span>留白，也是相处的一部分。</span><i>来信</i></div>
          <div className="glass"><div className="scale-caption"><span>晚风电台 · 日常藏本</span><span>装帧刻度 / 非状态数据</span></div><div className="scale-ticks">{Array.from({ length: 41 }, (_, index) => <i key={index} />)}</div><span className="scale-needle" /></div>
        </div>
        <div className="plate-heading">
          <nav className="breadcrumb" aria-label="当前位置">
            <button type="button" onClick={() => openView('home')}>关系</button>
            {ui.view !== 'home' && <><span>/</span><span>{viewTitle[ui.view]}</span></>}
          </nav>
          <span className="folio">{packet?.createdAt ? packet.createdAt.slice(0, 10) : '本页'} / {String(Math.max(1, roles.findIndex(role => role.roleId === currentId) + 1)).padStart(2, '0')}</span>
        </div>
        {ui.view === 'home' ? <div className={'page-home view' + (enter === 'home' ? ' home-enter' : '')}>
          <div className="bookplate-stage">
            <div className="plate-shadow" aria-hidden="true" />
            <div className="backing-leaf back-leaf-two" aria-hidden="true" />
            <div className="backing-leaf back-leaf-one" aria-hidden="true" />
            <div className="leaves" aria-label="打开藏页">
              <button type="button" className="paper-tab tab-experiences" ref={element => { if (element) homeTabs.current.experiences = element; else delete homeTabs.current.experiences; }} onClick={event => openView('experiences', event.currentTarget)}><span className="tab-number">01</span><span className="tab-title">经历</span><span className="tab-caption">共同的片刻</span><span className="tab-preview">{previewEvent}</span><Arrow /><i className="tab-led" aria-hidden="true" /></button>
              <button type="button" className="paper-tab tab-diary" ref={element => { if (element) homeTabs.current.diary = element; else delete homeTabs.current.diary; }} onClick={event => openView('diary', event.currentTarget)}><span className="tab-number">02</span><span className="tab-title">日记</span><span className="tab-caption">纸上的心绪</span><span className="tab-preview">{previewDiary}</span><Arrow /><i className="tab-led" aria-hidden="true" /></button>
              <button type="button" className="paper-tab tab-profile" ref={element => { if (element) homeTabs.current.profile = element; else delete homeTabs.current.profile; }} onClick={event => openView('profile', event.currentTarget)}><span className="tab-number">03</span><span className="tab-title">角色介绍</span><span className="tab-caption">关于这个人</span><span className="tab-preview">从她的设定读起</span><Arrow /><i className="tab-led" aria-hidden="true" /></button>
            </div>
            <article className={'portrait-plate' + (turning ? ' turning' : '')} aria-label={profile.name ? `${profile.name}的人物藏书票` : '人物藏书票'}>
              <div className="plate-topline"><span>人物藏书票 <b className="person-number">{String(Math.max(1, roles.findIndex(role => role.roleId === currentId) + 1)).padStart(2, '0')}</b></span><span>{packet?.portraitUrl && !portraitFailed ? '当前服饰' : '外观'}</span></div>
              <div className="portrait-mat">
                <i className="tape" aria-hidden="true" />
                {packet?.portraitUrl && !portraitFailed
                  ? <img key={packet.portraitUrl} src={packet.portraitUrl} alt={`${profile.name}的主页立绘`} onError={() => setPortraitFailed(true)} />
                  : <div className="portrait-empty">{currentId ? '外观还没配置' : '还没有角色'}</div>}
                <span className="portrait-tint" aria-hidden="true" />
                <span className="photo-caption"><span className="day-only">本页请来的人</span><span className="night-only">留在这一页的人</span></span>
              </div>
              <div className="portrait-name"><h2 data-testid="plate-name">{profile.name || '还没有角色'}</h2><span className="edition-seal" aria-hidden="true">藏</span></div>
              <p className="current-state" data-testid="plate-state">{sentence}</p>
              <div className="plate-baseline"><span>{packet ? `设定 · 第 ${packet.definitionRevision} 版` : '此刻'}</span><span>{listRole && listRole.status !== 'ready' ? (listRole.initError || '尚未就绪') : '共同的一页'}</span></div>
              <div className="plate-reverse" aria-hidden="true"><FoldIcon /><span>在每一个普通日子里。</span></div>
            </article>
            {personSwitch()}
            <div className="plate-under"><span className="hand-note day-only">先把这一页留给你。</span><span className="night-only">不急着说话，听一会儿也好。</span></div>
          </div>
          <div className="home-copy">
            <div className="home-eyebrow"><span className="day-only">A NOTE FOR OUR DAYS</span><span className="night-only">STAY A LITTLE, LISTEN A LITTLE</span></div>
            <h1>把日常，<br /><span>收进这一页。</span></h1>
            <p>不必给陪伴打分。<br />一张人物票，几页一起经过的日常。</p>
            <div className="quiet-note"><span className="day-only">还有一些空白，留给以后。</span><span className="night-only">白天没说完的话，今晚也有人听。</span></div>
            <div className="postmark" aria-hidden="true"><div>日常<br /><b>藏本</b></div><svg viewBox="0 0 160 50"><path d="M0 14c25-18 35 18 65 0s40 18 90 0M0 26c25-18 35 18 65 0s40 18 90 0M0 38c25-18 35 18 65 0s40 18 90 0" /></svg></div>
          </div>
        </div> : <section className={'inner-view view' + (enter && enter !== 'home' ? ` enter-${enter}` : '')} aria-labelledby="inner-title">
          <div className="inner-rail">
            <button type="button" className="back-button wj-action ghost" onClick={() => openView('home')}><Back />合上藏页</button>
            <div className="rail-identity">
              {packet?.portraitUrl && !portraitFailed ? <img src={packet.portraitUrl} alt="" /> : <div className="portrait-empty">外观还没配置</div>}
              <span className="eyebrow">这一页 · 关于她</span>
              <h2 data-testid="rail-name">{profile.name}</h2>
              <p>{sentence}</p>
              {personSwitch(true)}
            </div>
            <nav className="inner-nav" aria-label="藏页目录">
              {(['experiences', 'diary', 'profile'] as const).map((view, index) => <button type="button" key={view} aria-current={ui.view === view ? 'page' : undefined} onClick={() => openView(view)}>{String(index + 1).padStart(2, '0')} <span>{viewTitle[view]}</span></button>)}
            </nav>
            <div className="rail-bottom"><span className="day-only">这一页，留给你。</span><span className="night-only">让日常，留下回声。</span></div>
          </div>
          <div className="reading-sheet" ref={sheetRef} tabIndex={0} role="region" aria-label="藏页阅读区">
            <header className="reading-heading">
              <div>
                <span className="eyebrow" id="inner-eyebrow">{ui.view === 'experiences' ? '一起经过' : ui.view === 'diary' ? '留在纸上' : '眼前这个人'}</span>
                <h1 id="inner-title" tabIndex={-1} ref={titleRef} data-testid="inner-title">{ui.view === 'experiences' ? '一起经过' : ui.view === 'diary' ? '留在纸上' : '关于她'}</h1>
              </div>
              <span className="reading-pagination">{String(views.indexOf(ui.view)).padStart(2, '0')} / 03</span>
            </header>
            <div id="reading-content" data-testid="reading" data-role-id={packet?.roleId ?? ''}>
              {(error || ui.error) && <p className="status-line error" role="alert">{error || ui.error}</p>}
              {profile.loading && !ui.error && <p className="status-line">正在读取这一页。</p>}
              {ui.view === 'experiences' && packet && <>
                <p className="chapter-intro">整理之后留下的经历。点开一条，可以再看她当时写下的感受和依据。</p>
                {memoriesLoading && <p className="status-line">{packet.events.length || packet.summaries.length ? '还有记录正在整理。' : '正在整理经历。'}</p>}
                {packet.memoryError && <p className="status-line error">{packet.memoryError}</p>}
                {!packet.events.length && !packet.summaries.length && !packet.memoryError && !memoriesLoading && <p className="status-line">还没有整理出经历。</p>}
                <div className="moments">{packet.events.map(event => <article className="moment" key={event.id}>
                  <button type="button" className="moment-open" aria-expanded={ui.openEventId === event.id} onClick={() => dispatch({ type: 'event', eventId: event.id })}>
                    <time className="moment-date">{event.date || '日期未记'}</time>
                    <span><strong className="moment-title">{event.title}</strong><span className="moment-summary">{event.summary}</span></span>
                    <Arrow />
                  </button>
                  {ui.openEventId === event.id && <div className="moment-detail">
                    {event.subjective && <p>她记下的感受：{event.subjective}</p>}
                    {!event.subjective && <p>{event.summary}</p>}
                    <button type="button" className="evidence-button" aria-expanded={ui.evidenceId === event.id} onClick={() => dispatch({ type: 'evidence', evidenceId: event.id })}>看依据</button>
                    {ui.evidenceId === event.id && <div className="evidence">{evidenceError && <small>{evidenceError}</small>}{evidenceText && <blockquote>{evidenceText}</blockquote>}<cite>来自这条经历保存的原始记录。</cite></div>}
                  </div>}
                </article>)}
                {packet.summaries.map(summary => <article className="moment" key={summary.id}>
                  <div className="moment-open" aria-hidden="true"><time className="moment-date">{summary.date}</time><span><strong className="moment-title">{summary.title}</strong><span className="moment-summary">{summary.summary}</span></span></div>
                  <p className="status-line">日常概况</p>
                </article>)}
                </div>
              </>}
              {ui.view === 'diary' && packet && <>
                {packet.diaryError && <p className="status-line error" role="alert">{packet.diaryError}</p>}
                {!packet.diaries.length && !packet.diaryError && (packet.pending.diaries ? <p className="status-line">正在读取日记。</p> : <p className="status-line">还没有日记。</p>)}
                {!!packet.diaries.length && <div className="diary-layout">
                  <nav className="date-index" role="tablist" aria-label="选择日记日期">{packet.diaries.map((item, index) => <button type="button" key={item.id} role="tab" aria-selected={index === ui.diaryIndex} tabIndex={index === ui.diaryIndex ? 0 : -1} onClick={() => dispatch({ type: 'diary', index })} onKeyDown={event => {
                    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const last = packet.diaries.length - 1;
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : Math.min(last, Math.max(0, ui.diaryIndex + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1)));
                    dispatch({ type: 'diary', index: next });
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                  }}><span>{item.date}</span></button>)}</nav>
                  {diary && <article className="diary-paper" role="tabpanel" data-testid="diary-paper"><div className="diary-meta">{diary.date}</div><h2>{diary.title}</h2><div className="diary-body">{diary.paragraphs.map(paragraph => <p key={paragraph.slice(0, 24)}>{paragraph}</p>)}</div><div className="diary-signature">—— {packet.displayName}</div></article>}
                </div>}
                {!!packet.diaries.length && packet.pending.diaries && <p className="status-line">还有日记正在读取。</p>}
              </>}
              {ui.view === 'profile' && <div className="profile-layout" data-testid="profile">
                <div>
                  <p className="profile-title" data-testid="profile-name">{profile.name}</p>
                  {definition.quote && <h2 className="profile-quote">{definition.quote}</h2>}
                  <p className="profile-text" data-testid="profile-definition">{profile.loading ? '正在读取角色介绍。' : (definition.body || definition.quote || '还没有写下角色设定。')}</p>
                  {!!profile.lines.length && <dl className="profile-lines">{profile.lines.map(line => <Fragment key={line.key}><dt>{line.label}</dt><dd>{line.value}</dd></Fragment>)}</dl>}
                  <p className="profile-note">设定、近况和外观都来自已经保存的资料。服饰和模型放在设置里。</p>
                </div>
                <figure className="profile-image">{packet?.portraitUrl && !portraitFailed ? <img src={packet.portraitUrl} alt={`${profile.name}的主页立绘`} /> : <div className="portrait-empty">外观还没配置</div>}<span>{profile.name}</span></figure>
              </div>}
            </div>
            <div className="reading-foot"><span>{ui.view === 'profile' ? '不是一份配置，是一个有自己节奏的人。' : ui.view === 'diary' ? '有些话，适合留在慢一点的地方。' : '不是所有日常都要有意义，留下就好。'}</span><FoldIcon /></div>
          </div>
          <div className="unfold-trace" aria-hidden="true"><i /><i /><i /></div>
        </section>}
        <footer className="sheet-footer"><span>{roles.length ? `${roles.length} 位角色` : '还没有角色'}</span><button type="button" className="footer-hint" onClick={onOpenSettings}>角色资料在设置里</button><span className="sheet-code">本地藏页 / {pageCode}</span></footer>
      </div>
    </div>
    <div className="fold-morph" aria-hidden="true" />
    </div>
  </UiThemeScope>;
}
