import { errorText } from '../lib/error-text';
import { PaperSkeleton } from '../components/PaperSkeleton';
import { Fragment, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { RoleListItem } from '../types';
import { Button, IconButton, UiThemeScope, readMotionTime, useMotionPolicy } from '../ui';
import { EvidenceRecord } from '../relations/EvidenceRecord';
import { MemoryCorrection, type MemoryTarget } from '../relations/MemoryCorrection';
import { useThemePreset, useThemeTransitionStrategy } from '../ui/presets';
import { createRoleRequestGate, initialRelationUi, profileModel, reduceRelation, splitDefinition, visiblePacket, type RelationUi } from '../relations/dossier';
import { loadRelationPacket } from '../relations/load-dossier';
import { exlibrisThemeTransition } from '../relations/exlibris-theme';

type Props = {
  roles: RoleListItem[];
  loading: boolean;
  retrying: boolean;
  onRetry: () => Promise<void>;
  error: string;
  currentId: string;
  visit: number;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
};

const views = ['home', 'experiences', 'diary', 'profile'] as const;
const viewTitle = { experiences: '经历', diary: '日记', profile: '角色介绍' } as const;
const viewEyebrow = { experiences: '经历 · 回看', diary: '日记 · 随笔', profile: '眼前这个人' } as const;

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

export function Relations({ roles, loading, error, retrying, onRetry, currentId, visit, onSelect, onOpenSettings }: Props) {
  const { preset } = useThemePreset();
  const motion = useMotionPolicy();
  useThemeTransitionStrategy(exlibrisThemeTransition);
  const [ui, dispatch] = useReducer(reduceRelation, currentId, initialRelationUi);
  const [selector, setSelector] = useState(false);
  const [turning, setTurning] = useState(false);
  const [portraitFailed, setPortraitFailed] = useState(false);
  const [correction, setCorrection] = useState<{ roleId: string; target: MemoryTarget | null; source: HTMLElement; closing?: boolean } | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [loadingPacket, setLoadingPacket] = useState(false);
  const [correctionStatus, setCorrectionStatus] = useState('');
  const [fold, setFold] = useState({ on: false, reverse: false });
  const [enter, setEnter] = useState('');
  const gate = useRef(createRoleRequestGate());
  const homeTabs = useRef<Partial<Record<Exclude<RelationUi['view'], 'home'>, HTMLButtonElement>>>({});
  const lastHomeTab = useRef<Exclude<RelationUi['view'], 'home'>>('experiences');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bookRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const evidenceButton = useRef<HTMLButtonElement>(null);
  const evidencePanelId = useId();
  const switchButtonRef = useRef<HTMLButtonElement>(null);
  const selectorRef = useRef<HTMLDivElement>(null);
  const enterTimer = useRef<number | undefined>(undefined);
  const finishEntering = useRef<(() => void) | null>(null);
  const night = preset === 'nightwave';
  const displayedUi = ui.roleId === currentId ? ui : initialRelationUi(currentId);
  const packet = visiblePacket(displayedUi);
  const packetRef = useRef(packet);
  packetRef.current = packet;
  const listRole = roles.find(role => role.roleId === currentId);
  const profile = profileModel(displayedUi, listRole?.displayName ?? '');
  const definition = packet ? splitDefinition(packet.definitionText) : { quote: '', body: '' };
  const diary = packet?.diaries[ui.diaryIndex] ?? packet?.diaries[0];

  useEffect(() => { if (visit > 0) dispatch({ type: 'view', view: 'home' }); }, [visit]);
  useEffect(() => () => { if (enterTimer.current !== undefined) window.clearTimeout(enterTimer.current); }, []);
  useLayoutEffect(() => {
    if (!motion.reduced || !finishEntering.current) return;
    window.clearTimeout(enterTimer.current);
    finishEntering.current();
  }, [motion.reduced]);
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
    const changedRole = gate.current.currentRoleId() !== currentId;
    const ticket = gate.current.begin(currentId);
    if (changedRole) {
      dispatch({ type: 'switch', roleId: currentId });
      setCorrection(null); setCorrectionStatus('');
    }
    setPortraitFailed(false);
    setSelector(false);
    setLoadingPacket(!!currentId);
    if (!currentId) return;
    const controller = new AbortController();
    // 刷新期间保留正在阅读的资料；首次进入时仍逐批展示。
    const hadPacket = packetRef.current?.roleId === currentId;
    loadRelationPacket(currentId, controller.signal, next => {
      if (hadPacket || controller.signal.aborted || !gate.current.accept(ticket)) return;
      dispatch({ type: 'loaded', roleId: currentId, packet: next });
    }).then(next => {
      if (controller.signal.aborted || !gate.current.accept(ticket)) return;
      dispatch({ type: 'loaded', roleId: currentId, packet: next });
    }).catch(reason => {
      if (controller.signal.aborted || !gate.current.accept(ticket)) return;
      dispatch({ type: 'failed', roleId: currentId, error: errorText(reason) });
    }).finally(() => {
      if (!controller.signal.aborted && gate.current.accept(ticket)) setLoadingPacket(false);
    });
    return () => controller.abort();
  }, [currentId, loadRevision]);

  useEffect(() => {
    const willTurn = !!currentId && !motion.reduced;
    setTurning(willTurn);
    if (!willTurn) return;
    const timer = window.setTimeout(() => setTurning(false), readMotionTime(bookRef.current, '--nd-semantic-motion-scene', 900));
    return () => window.clearTimeout(timer);
  }, [currentId, motion.reduced]);

  const closeSelector = (restoreFocus: boolean) => {
    setSelector(false);
    if (restoreFocus) switchButtonRef.current?.focus();
  };

  const closeCorrection = () => setCorrection(value => value && { ...value, closing: true });

  const openView = (view: RelationUi['view'], focus?: HTMLButtonElement | null) => {
    if (ui.view === 'home' && view !== 'home' && focus) lastHomeTab.current = view;
    if (enterTimer.current !== undefined) window.clearTimeout(enterTimer.current);
    const previousFocus = document.activeElement;
    setEnter(motion.reduced ? '' : view);
    dispatch({ type: 'view', view });
    const finish = () => {
      finishEntering.current = null;
      enterTimer.current = undefined;
      setEnter('');
      if (document.activeElement !== previousFocus && document.activeElement !== document.body) return;
      if (view === 'home') homeTabs.current[lastHomeTab.current]?.focus();
      else titleRef.current?.focus();
    };
    finishEntering.current = finish;
    const duration = view === 'home' ? readMotionTime(bookRef.current, '--nd-semantic-motion-page', 360)
      : readMotionTime(bookRef.current, '--nd-semantic-motion-scene', 900);
    enterTimer.current = window.setTimeout(finish, motion.reduced ? 0 : duration);
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

  const firstPacketRead = loadingPacket && !packet && !displayedUi.error;
  const coverError = error || displayedUi.error;
  const missingRoleName = coverError ? '暂时读不到角色' : loading ? '正在读取角色…' : '还没有角色';
  const retryCover = () => {
    if (error) void onRetry();
    if (currentId) setLoadRevision(value => value + 1);
  };
  const memoriesLoading = !!packet && (packet.pending.events || packet.pending.summaries);
  const previewEvent = packet?.events[0]?.title || (packet ? (memoriesLoading ? '正在读取' : packet.memoryError ? '经历暂时无法读取' : '还没有经历') : '正在读取');
  const previewDiary = packet?.diaries[0]?.title ? `「${packet.diaries[0].title}」` : (packet ? (packet.pending.diaries ? '正在读取' : packet.diaryError ? '日记暂时无法读取' : '还没有日记') : '正在读取');
  const pageCode = ui.view === 'home' ? '001' : String(views.indexOf(ui.view) + 1).padStart(3, '0');
  const sentence = packet ? (packet.sentence || '暂未写下近况') : coverError || (currentId ? '正在读取近况…' : missingRoleName);
  const personSwitch = (rail = false) => roles.length < 2 ? null : <div className={'plate-switch' + (rail ? ' in-rail' : '')}>
    <button type="button" ref={switchButtonRef} className="wj-action" aria-expanded={selector} onClick={() => setSelector(value => !value)}><AccountsIcon />换一位</button>
    {selector && <div className="person-selector" ref={selectorRef}>
      <div className="selector-head"><span>翻到另一位</span><button type="button" aria-label="关闭人物选择" onClick={() => closeSelector(true)}>×</button></div>
      <div className="person-options">{roles.map((role, index) => <button type="button" key={role.roleId} className="person-option" title={role.displayName} aria-pressed={role.roleId === currentId} onClick={() => { if (role.roleId !== currentId) onSelect(role.roleId); closeSelector(true); }}><span>{role.displayName}</span><small>{String(index + 1).padStart(2, '0')}</small></button>)}</div>
    </div>}
  </div>;

  return <UiThemeScope theme="xiacheng" preset={preset} motion={motion.reduced ? 'reduced' : 'full'} className="exlibris-host">
    {correction?.roleId === currentId && <MemoryCorrection open={!correction.closing} roleId={currentId} target={correction.target} source={correction.source}
      onClose={closeCorrection} onExited={() => setCorrection(null)}
      onSaved={() => { closeCorrection(); setCorrectionStatus('已保存更正。'); setLoadRevision(n => n + 1); }} />}
    <div className="exlibris" data-theme={night ? 'night' : 'day'} data-motion={motion.reduced ? 'reduced' : 'full'}>
    <div className="relationship-stage">
      <div ref={bookRef} className={'book collection' + (fold.on ? ' illuminating' : '') + (fold.reverse ? ' reverse' : '')} data-view={ui.view} id="collection">
        <div className="spread book-surface" aria-hidden="true"><div className="leaf left" /><div className="gutter" /><div className="leaf right" /></div>
        <div className="ribbon" aria-hidden="true" />
        <div className="book-thread" aria-hidden="true"><i /><i /></div>
        <div className="sheet-grain" aria-hidden="true" />
        <div className="backlight" aria-hidden="true"><div className="light-beam" /><div className="reverse-print"><span>日常来信</span><em>所藏的，是相遇。</em><svg viewBox="0 0 64 80"><path d="M31 74C15 48 22 27 45 8c8 29 0 50-17 52M29 61 45 8M32 48 23 35m13-1 11-9M31 57l12-10" /></svg></div></div>
        <div className="plate-heading">
          <nav className="breadcrumb" aria-label="当前位置">
            <button type="button" onClick={() => openView('home')}>关系</button>
            {ui.view !== 'home' && <><span>/</span><span>{viewTitle[ui.view]}</span></>}
          </nav>
          <div className="edition-strip strip" aria-hidden="true">
            <div className="letter-strip"><svg viewBox="0 0 450 70" preserveAspectRatio="none"><path d="M10 37h100l40-26 40 26 40-26 40 26h170M110 37l40 26 40-26 40 26 40-26" /></svg><span>留白，也是相处的一部分。</span><i>来信</i></div>
            <div className="glass"><div className="scale-caption"><span>晚风电台 · 日常藏本</span><span>书页刻度</span></div><div className="scale-ticks">{Array.from({ length: 41 }, (_, index) => <i key={index} />)}</div><span className="scale-needle" /></div>
          </div>
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
              <button type="button" className="paper-tab tab-profile" ref={element => { if (element) homeTabs.current.profile = element; else delete homeTabs.current.profile; }} onClick={event => openView('profile', event.currentTarget)}><span className="tab-number">03</span><span className="tab-title">角色介绍</span><span className="tab-caption">关于这个人</span><span className="tab-preview">人物设定与近况</span><Arrow /><i className="tab-led" aria-hidden="true" /></button>
            </div>
            <article className={'portrait-plate' + (turning ? ' turning' : '')} aria-label={profile.name ? `${profile.name}的人物藏书票` : '人物藏书票'}>
              <div className="plate-topline"><span>人物藏书票 <b className="person-number">{String(Math.max(1, roles.findIndex(role => role.roleId === currentId) + 1)).padStart(2, '0')}</b></span><span>{packet?.portraitUrl && !portraitFailed ? '当前服饰' : '外观'}</span></div>
              <div className="portrait-mat">
                <i className="tape" aria-hidden="true" />
                {packet?.portraitUrl && !portraitFailed
                  ? <img key={packet.portraitUrl} src={packet.portraitUrl} alt={`${profile.name}的主页立绘`} onError={() => setPortraitFailed(true)} />
                  : firstPacketRead ? <div className="portrait-empty">正在读取立绘…</div>
                  : <div className="portrait-empty">{currentId ? '暂无立绘' : coverError || loading ? '' : '还没有角色'}</div>}
                <span className="portrait-tint" aria-hidden="true" />
                <span className="photo-caption"><span className="day-only">本页请来的人</span><span className="night-only">留在这一页的人</span></span>
              </div>
              <div className="portrait-name"><h2 data-testid="plate-name">{profile.name || missingRoleName}</h2><span className="edition-seal" aria-hidden="true">藏</span></div>
              <p className="current-state" data-testid="plate-state">{sentence}</p>
              <div className="plate-baseline"><span>{packet ? `设定 · 第 ${packet.definitionRevision} 版` : '此刻'}</span><span>{listRole && listRole.status !== 'ready' ? (listRole.initError || '准备中') : '共同的一页'}</span></div>
              <div className="plate-reverse" aria-hidden="true"><FoldIcon /><span>在每一个普通日子里。</span></div>
            </article>
            {personSwitch()}
          </div>
          <div className="home-copy">
            <div className="home-eyebrow"><span className="day-only">A NOTE FOR OUR DAYS</span><span className="night-only">STAY A LITTLE, LISTEN A LITTLE</span></div>
            <h1>关系</h1>
            <p>一张人物藏书票，几页一起走过的日常。</p>
            {firstPacketRead && <PaperSkeleton label="正在读取这一页…"/>}
            <div className="postmark" aria-hidden="true"><div>日常<br /><b>藏本</b></div><svg viewBox="0 0 160 50"><path d="M0 14c25-18 35 18 65 0s40 18 90 0M0 26c25-18 35 18 65 0s40 18 90 0M0 38c25-18 35 18 65 0s40 18 90 0" /></svg></div>
          </div>
        </div> : <section className={'inner-view view' + (enter && enter !== 'home' ? ` enter-${enter}` : '')} aria-labelledby="inner-title">
          <div className="inner-rail">
            <button type="button" className="back-button wj-action ghost" onClick={() => openView('home')}><Back />合上藏页</button>
            <div className="rail-identity">
              {packet?.portraitUrl && !portraitFailed ? <img src={packet.portraitUrl} alt="" /> : <div className="portrait-empty">暂无立绘</div>}
              <span className="eyebrow">这一页 · 关于她</span>
              <h2 data-testid="rail-name">{profile.name}</h2>
              <p>{sentence}</p>
              {personSwitch(true)}
            </div>
            <nav className="inner-nav" aria-label="藏页目录">
              {(['experiences', 'diary', 'profile'] as const).map((view, index) => <button type="button" key={view} aria-current={ui.view === view ? 'page' : undefined} onClick={() => openView(view)}>{String(index + 1).padStart(2, '0')} <span>{viewTitle[view]}</span></button>)}
            </nav>
          </div>
          <div className="reading-sheet" ref={sheetRef} tabIndex={0} role="region" aria-label="藏页阅读区">
            <header className="reading-heading">
              <div>
                <span className="eyebrow" id="inner-eyebrow">{viewEyebrow[ui.view]}</span>
                <h1 id="inner-title" tabIndex={-1} ref={titleRef} data-testid="inner-title">{ui.view === 'experiences' ? '一起经过' : ui.view === 'diary' ? '留在纸上' : '关于她'}</h1>
              </div>
              <div className="reading-heading-tools">
                <span className="reading-pagination">{String(views.indexOf(ui.view)).padStart(2, '0')} / 03</span>
                {currentId && <IconButton icon="refresh" label="刷新藏页" size={15} busy={loadingPacket} onClick={() => setLoadRevision(n => n + 1)} />}
              </div>
            </header>
            <div id="reading-content" data-testid="reading" data-role-id={packet?.roleId ?? ''}>
              {(error || (!loadingPacket && ui.error)) && <p className="status-line error" role="alert">{error || ui.error}</p>}
              {loadingPacket && (packet || displayedUi.error ? <p className="sr-only" role="status">正在更新藏页…</p> : <PaperSkeleton label="正在读取这一页…"/>)}
              {ui.view === 'experiences' && packet && <>
                <p className="chapter-intro">翻开一条经历，可以回看其中记下的感受和原始记录。</p>
                <Button size="sm" onClick={e => setCorrection({ roleId: currentId, target: null, source: e.currentTarget })}>查找并更正记忆</Button>
                {correctionStatus && <p role="status">{correctionStatus}</p>}
                {memoriesLoading && <p className="status-line">{packet.events.length || packet.summaries.length ? '还有记录正在读取…' : '正在读取经历与日常摘要…'}</p>}
                {packet.memoryError && <p className="status-line error">{packet.memoryError}</p>}
                {!packet.events.length && !packet.summaries.length && !packet.memoryError && !memoriesLoading && <p className="status-line">还没有留下经历或日常摘要。</p>}
                <div className="moments">{packet.events.map(event => <article className="moment" key={event.id}>
                  <button type="button" className="moment-open" aria-expanded={ui.openEventId === event.id} onClick={() => dispatch({ type: 'event', eventId: event.id })}>
                    <time className="moment-date">{event.date || '日期未记'}</time>
                    <span><strong className="moment-title">{event.title}</strong><span className="moment-summary">{event.summary}</span></span>
                    <Arrow />
                  </button>
                  {ui.openEventId === event.id && <div className="moment-detail">
                    {event.subjective && <p>当时的感受：{event.subjective}</p>}
                    {!event.subjective && <p>{event.summary}</p>}
                    <div className="moment-actions">
                      <button type="button" ref={evidenceButton} className="evidence-button" aria-expanded={ui.evidenceId === event.id}
                        aria-controls={ui.evidenceId === event.id ? evidencePanelId : undefined} onClick={() => dispatch({ type: 'evidence', evidenceId: event.id })}>{ui.evidenceId === event.id ? '收起依据' : '看依据'}</button>
                      <Button size="sm" onClick={e => setCorrection({ roleId: currentId, target: { type: 'event', id: event.id }, source: e.currentTarget })}>更正经历</Button>
                    </div>
                    {ui.evidenceId === event.id && <EvidenceRecord key={`${packet.roleId}:${event.evidenceIds[0] ?? event.id}`}
                      id={evidencePanelId} roleId={packet.roleId} evidenceId={event.evidenceIds[0]} trigger={evidenceButton} />}
                  </div>}
                </article>)}
                {packet.summaries.map(summary => <article className="moment" key={summary.id}>
                  <div className="moment-open" aria-hidden="true"><time className="moment-date">{summary.date}</time><span><strong className="moment-title">{summary.title}</strong><span className="moment-summary">{summary.summary}</span></span></div>
                  <p className="status-line">日常概况</p>
                  <Button size="sm" onClick={e => setCorrection({ roleId: currentId, target: { type: 'daily_summary', id: summary.id }, source: e.currentTarget })}>更正摘要</Button>
                </article>)}
                </div>
              </>}
              {ui.view === 'diary' && packet && <>
                {packet.diaryError && <p className="status-line error" role="alert">{packet.diaryError}</p>}
                {!packet.diaries.length && !packet.diaryError && (packet.pending.diaries ? <p className="status-line">正在读取日记…</p> : <p className="status-line">还没有写下日记。</p>)}
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
                {!!packet.diaries.length && packet.pending.diaries && <p className="status-line">还有日记正在读取…</p>}
              </>}
              {ui.view === 'profile' && <div className="profile-layout" data-testid="profile">
                <div>
                  <p className="profile-title" data-testid="profile-name">{profile.name}</p>
                  {packet?.isBuiltin && packet.bioText.trim() && <section className="profile-official" data-testid="profile-official-intro">
                    <span className="eyebrow">主角色 · 人物介绍</span>
                    <p>{packet.bioText}</p>
                  </section>}
                  {definition.quote && <h2 className="profile-quote">{definition.quote}</h2>}
                  <p className="profile-text" data-testid="profile-definition">{profile.loading ? '正在读取角色介绍…' : (definition.body || definition.quote || '暂未写下角色设定。')}</p>
                  {!!profile.lines.length && <dl className="profile-lines">{profile.lines.map(line => <Fragment key={line.key}><dt>{line.label}</dt><dd>{line.value}</dd></Fragment>)}</dl>}
                </div>
                <figure className="profile-image">{packet?.portraitUrl && !portraitFailed ? <img src={packet.portraitUrl} alt={`${profile.name}的主页立绘`} /> : <div className="portrait-empty">暂无立绘</div>}<span>{profile.name}</span></figure>
              </div>}
            </div>
            <div className="reading-foot"><span>{ui.view === 'profile' ? '不是一份配置，是一个有自己节奏的人。' : ui.view === 'diary' ? '有些话，适合留在慢一点的地方。' : '不是所有日常都要有意义，留下就好。'}</span><FoldIcon /></div>
          </div>
          <div className="unfold-trace" aria-hidden="true"><i /><i /><i /></div>
        </section>}
        <footer className="sheet-footer">
          {coverError ? <><span role="status">{roles.length ? '暂时无法更新，仍显示上次的内容。' : '角色资料暂时无法更新。'}</span>
            <Button size="sm" busy={retrying || loadingPacket} onClick={retryCover}>重试</Button></>
            : <><span>{roles.length ? `${roles.length} 位角色` : missingRoleName}</span>
              <button type="button" className="footer-hint" onClick={onOpenSettings}>打开角色配置</button></>}
          <span className="sheet-code">本地藏页 / {pageCode}</span>
        </footer>
      </div>
    </div>
    <div className="fold-morph" aria-hidden="true" />
    </div>
  </UiThemeScope>;
}
