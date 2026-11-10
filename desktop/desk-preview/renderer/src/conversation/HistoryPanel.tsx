import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, useMotionPolicy } from '../ui';
import { buildDays, calendarDays, dateLabel, dayKey, daySnippets, dotTier, findHits, keyToDate, rangesFor, snippet, termsFor, textFor } from './history.js';
import type { DaySummary, PerfRow } from './history.js';
import type { PerfScene } from './performance.js';

const WEEK = '日一二三四五六';
const weekday = (key: string) => `周${WEEK[keyToDate(key).getDay()]}`;
const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function MarkedText({ text, query }: { text: string; query: string }) {
  const ranges = rangesFor(text, query);
  if (!ranges.length) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    if (start > from) nodes.push(<span key={`${from}-${start}`}>{text.slice(from, start)}</span>);
    nodes.push(<mark key={`hit-${start}`}>{text.slice(start, end)}</mark>);
    from = end;
  }
  if (from < text.length) nodes.push(<span key={`tail-${from}`}>{text.slice(from)}</span>);
  return <>{nodes}</>;
}

function lineText(line: PerfRow, query: string, main?: boolean) {
  if (line.text) return snippet(line.text, query, main ? 150 : 64);
  return '还没来得及写下。';
}

function CardBody({ card, query }: { card: { key: string; lines: Array<PerfRow & { main: boolean }> }; query: string }) {
  const target = card.lines.find(line => line.main) ?? card.lines[0];
  if (!target) return null;
  return <>
    <span className="dialogue-snippet-meta">
      <span>{time(target.createdAt)} · {target.role === 'user' ? '你说' : '角色'}</span>
      {target.status === 'interrupted' ? <span className="dialogue-snippet-state">未说完</span> : null}
    </span>
    {card.lines.map((line, index) => <span key={index} className={`dialogue-snippet-line${line.main ? ' main' : ''}`}>
      <span className="dialogue-snippet-who">{line.role === 'user' ? '你' : '角色'}</span>
      <span className="dialogue-snippet-body">
        {line.actionVisible && line.action ? <span className="dialogue-snippet-cue"><i aria-hidden="true" /><span className="sr-only">动作：</span>{line.action}</span> : null}
        {line.text || !line.actionVisible ? <span className="dialogue-snippet-text"><MarkedText text={lineText(line, query, line.main)} query={query} /></span> : null}
      </span>
    </span>)}
  </>;
}

function cardLabel(card: { key: string; lines: Array<PerfRow & { main: boolean }> }, query: string): string {
  const target = card.lines.find(line => line.main) ?? card.lines[0];
  if (!target) return '片段';
  return `${dateLabel(card.key)} ${time(target.createdAt)}，${target.role === 'user' ? '你' : '角色'}：${snippet(textFor(target) || lineText(target, query, true), query, 90)}。按 Enter 回到这句话`;
}

export function HistoryPanel({
  open,
  messages,
  scenes,
  loading,
  complete,
  error,
  onRetry,
  onOpenScene,
  onLocate,
  onClose,
}: {
  open: boolean;
  messages: PerfRow[];
  scenes: PerfScene[];
  loading: boolean;
  complete: boolean;
  error: string;
  onRetry: () => void;
  onOpenScene: (scene: PerfScene) => void;
  onLocate: (targetId: number) => void;
  onClose: () => void;
}) {
  const policy = useMotionPolicy();
  const [present, setPresent] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [cardIndex, setCardIndex] = useState(0);
  const [hitIndex, setHitIndex] = useState(-1);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const suppressClick = useRef(false);
  const search = useRef<HTMLInputElement>(null);
  const timelineScroll = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  const opener = useRef<HTMLElement | null>(null);
  const locating = useRef(false);
  const selectedHit = useRef<number | null>(null);
  const restoreFocus = () => {
    if (locating.current) { locating.current = false; return; }
    const target = opener.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
  };

  const days = useMemo(() => buildDays(messages), [messages]);
  const dayMap = useMemo(() => new Map(days.map(day => [day.key, day])), [days]);
  const terms = termsFor(query);
  const hits = useMemo(() => (terms.length ? findHits(messages, query) : []), [messages, query, terms]);
  const hitCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of hits) {
      const key = dayKey(hit.createdAt);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [hits]);
  const latestKey = useMemo(() => days.at(-1)?.key ?? '', [days]);
  const selectedDay = dayMap.get(selectedKey);
  // 有命中的日期展示命中片段；没有命中的日期仍可查看当天会话片段。
  const cardsFor = (key: string) => {
    const searching = terms.length > 0 && (hitCounts.get(key) ?? 0) > 0;
    return key ? daySnippets(messages, key, searching ? query : '') : [];
  };
  const cards = useMemo(() => (selectedKey ? cardsFor(selectedKey) : []), [messages, selectedKey, query, terms]);

  // 打开：记录触发点、初始化到最近一天的末张片段。关闭：动画结束后恢复焦点。
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPresent(true);
    setLeaving(false);
    const key = selectedKey && dayMap.has(selectedKey) ? selectedKey : latestKey;
    if (key) {
      const list = cardsFor(key);
      if (!selectedKey || !dayMap.has(selectedKey)) setSelectedKey(key);
      setCardIndex(terms.length ? 0 : Math.max(0, list.length - 1));
    }
    const timer = window.setTimeout(() => search.current?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(timer);
    // 只在打开时初始化一次；之后的实时增补不重排阅读位置。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && !selectedKey && latestKey) setSelectedKey(latestKey);
  }, [open, selectedKey, latestKey]);
  useEffect(() => {
    if (!open || loading || !query.trim() || !hits.length || hitIndex >= 0) return;
    const index = hits.length - 1;
    const hit = hits[index];
    selectedHit.current = hit.id;
    setHitIndex(index);
    setSelectedKey(dayKey(hit.createdAt));
    const nextCards = daySnippets(messages, dayKey(hit.createdAt), query);
    const card = nextCards.findIndex(item => item.targetId === hit.id);
    setCardIndex(Math.max(0, card));
  }, [open, loading, query, hits, hitIndex, messages]);
  useEffect(() => {
    if (!open || !query.trim() || selectedHit.current === null) return;
    const index = hits.findIndex(hit => hit.id === selectedHit.current);
    if (index < 0) return;
    setHitIndex(index);
    const hit = hits[index];
    const nextCards = daySnippets(messages, dayKey(hit.createdAt), query);
    const card = nextCards.findIndex(item => item.targetId === hit.id);
    if (card >= 0 && selectedKey === dayKey(hit.createdAt)) setCardIndex(card);
  }, [open, query, hits, messages, selectedKey]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (open || !present) return;
    if (policy.reduced) { setPresent(false); setLeaving(false); restoreFocus(); return; }
    setLeaving(true);
    const timer = window.setTimeout(() => { setPresent(false); setLeaving(false); restoreFocus(); }, 180);
    return () => window.clearTimeout(timer);
    // restoreFocus 只读取 ref，不进入依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, present, policy.reduced]);

  const syncHitFor = (list: Array<{ targetId: number }>, index: number) => {
    if (!terms.length || !list.length) return;
    const card = list[index];
    const hit = hits.findIndex(entry => entry.id === card?.targetId);
    if (hit >= 0) { selectedHit.current = hits[hit].id; setHitIndex(hit); }
  };

  const selectDay = (key: string, card: 'last' | number = 'last') => {
    if (!dayMap.has(key)) return;
    const list = cardsFor(key);
    const index = card === 'last' ? Math.max(0, list.length - 1) : Math.min(Math.max(0, card), Math.max(0, list.length - 1));
    setSelectedKey(key);
    setCardIndex(index);
    syncHitFor(list, index);
  };

  // 命中跳转：定位到某处命中的日期与片段卡。
  const gotoHit = (index: number) => {
    if (!hits.length) return;
    const target = Math.max(0, Math.min(hits.length - 1, index));
    setHitIndex(target);
    const hit = hits[target];
    selectedHit.current = hit.id;
    const key = dayKey(hit.createdAt);
    setSelectedKey(key);
    const nextCards = daySnippets(messages, key, query);
    const cardAt = nextCards.findIndex(card => card.targetId === hit.id);
    setCardIndex(cardAt >= 0 ? cardAt : 0);
  };

  const onQuery = (value: string) => {
    const nextTerms = termsFor(value);
    setQuery(value);
    if (!nextTerms.length) {
      selectedHit.current = null;
      setHitIndex(-1);
      const key = selectedDay?.key ?? latestKey;
      setSelectedKey(key);
      const dayCards = key ? daySnippets(messages, key, '') : [];
      setCardIndex(Math.max(0, dayCards.length - 1));
      return;
    }
    const nextHits = findHits(messages, value);
    if (!nextHits.length) {
      selectedHit.current = null;
      setHitIndex(-1);
      setSelectedKey(latestKey);
      return;
    }
    const index = nextHits.length - 1;
    const hit = nextHits[index];
    selectedHit.current = hit.id;
    setHitIndex(index);
    setSelectedKey(dayKey(hit.createdAt));
    const nextCards = daySnippets(messages, dayKey(hit.createdAt), value);
    const cardAt = nextCards.findIndex(card => card.targetId === hit.id);
    setCardIndex(cardAt >= 0 ? cardAt : 0);
  };

  const moveCard = (step: number) => {
    const next = cardIndex + step;
    if (next < 0 || next >= cards.length) return;
    setCardIndex(next);
    syncHitFor(cards, next);
    const hadFocus = stack.current?.contains(document.activeElement);
    if (hadFocus) window.setTimeout(() => stack.current?.querySelector<HTMLElement>('.front')?.focus({ preventScroll: true }), 0);
  };

  const locateCard = (targetId: number) => {
    locating.current = true;
    onLocate(targetId);
  };

  const stepDay = (delta: number, edge?: 'home' | 'end') => {
    const keys = [...dayButtons.current.keys()].filter(key => !terms.length || hitCounts.has(key));
    if (!keys.length) return;
    let at = keys.indexOf(selectedKey);
    let next = edge === 'home' ? 0 : edge === 'end' ? keys.length - 1 : at + delta;
    if (at < 0) next = delta > 0 ? 0 : keys.length - 1;
    next = Math.max(0, Math.min(keys.length - 1, next));
    const key = keys[next];
    const list = cardsFor(key);
    const index = terms.length ? 0 : Math.max(0, list.length - 1);
    setSelectedKey(key);
    setCardIndex(index);
    syncHitFor(list, index);
    window.setTimeout(() => dayButtons.current.get(key)?.focus({ preventScroll: true }), 0);
  };

  const reset = () => {
    selectedHit.current = null;
    setQuery('');
    setHitIndex(-1);
    setSelectedKey(latestKey);
    const list = latestKey ? daySnippets(messages, latestKey, '') : [];
    setCardIndex(Math.max(0, list.length - 1));
    search.current?.focus({ preventScroll: true });
  };

  // 时间轴：让选中日保持可见。
  useLayoutEffect(() => {
    if (!present) return;
    const button = dayButtons.current.get(selectedKey);
    const scroll = timelineScroll.current;
    if (!button || !scroll) return;
    const box = button.getBoundingClientRect();
    const host = scroll.getBoundingClientRect();
    const target = scroll.scrollLeft + (box.left - host.left) - host.width / 2 + box.width / 2;
    scroll.scrollTo({ left: Math.max(0, target), behavior: policy.reduced ? 'auto' : 'smooth' });
  }, [selectedKey, present, policy.reduced]);

  const timelineGroups = useMemo(() => {
    if (!days.length) return [];
    const first = days[0].key;
    const lastRaw = days.at(-1)!.key;
    const last = lastRaw > dayKey(Date.now()) ? lastRaw : dayKey(Date.now());
    const groups: Array<{ month: string; label: string; cells: Array<{ key: string; day: DaySummary | undefined }> }> = [];
    for (const key of calendarDays(`${first.slice(0, 8)}01`, last)) {
      const month = key.slice(0, 7);
      let group = groups.at(-1);
      if (!group || group.month !== month) {
        const date = keyToDate(key);
        const opening = date.getMonth() === 0 || groups.length === 0;
        group = { month, label: `${opening ? `${date.getFullYear()}年 ` : ''}${date.getMonth() + 1}月`, cells: [] };
        groups.push(group);
      }
      group.cells.push({ key, day: dayMap.get(key) });
    }
    return groups;
  }, [days, dayMap]);

  const behind = (() => {
    const indexes = [cardIndex + 1, cardIndex + 2].filter(index => index < cards.length);
    if (indexes.length < 2) {
      const previous = [cardIndex - 1, cardIndex - 2].filter(index => index >= 0);
      indexes.push(...previous.slice(0, 2 - indexes.length));
    }
    return indexes;
  })();

  if (!present) return null;
  return <section className="dialogue-history" data-leaving={leaving ? '' : undefined} role="dialog" aria-modal="false" aria-labelledby="dialogue-history-title" data-open={open ? '' : undefined}>
    <header className="dialogue-history-head">
      <h2 id="dialogue-history-title"><Icon name="history" size={18} />历史消息</h2>
      <span className="dialogue-history-hint" role="status">{loading ? '正在读取完整窗口历史…' : error ? '历史读取未完成' : complete ? '当前窗口的已保存消息' : '历史读取已暂停'}</span>
      <button type="button" className="dialogue-history-close" aria-label="关闭历史消息" onClick={onClose}><Icon name="close" size={17} /></button>
    </header>
    {error && <div role="alert">{error} <button type="button" onClick={onRetry}>重试读取</button></div>}
    <div className="dialogue-history-search">
      <div className="dialogue-search-field">
        <Icon name="search" size={17} />
        <label className="sr-only" htmlFor="dialogue-history-search">关键词检索</label>
        <input ref={search} id="dialogue-history-search" type="search" placeholder="找一句话，或一个瞬间" autoComplete="off" spellCheck={false} value={query} onChange={event => onQuery(event.target.value)} />
        {query ? <button type="button" className="dialogue-search-clear" aria-label="清除关键词" onClick={() => { setQuery(''); onQuery(''); }}><Icon name="close" size={15} /></button> : null}
      </div>
      <div className="dialogue-hit-nav" hidden={!terms.length}>
        <button type="button" className="dialogue-hit" aria-label="上一处" disabled={hitIndex <= 0} onClick={() => gotoHit(hitIndex - 1)}><Icon name="chev-up" size={17} /></button>
        <span aria-live="polite">{hits.length ? `${hitIndex + 1} / ${hits.length}` : '0 / 0'}</span>
        <button type="button" className="dialogue-hit" aria-label="下一处" disabled={hitIndex < 0 || hitIndex >= hits.length - 1} onClick={() => gotoHit(hitIndex + 1)}><Icon name="chev-down" size={17} /></button>
      </div>
    </div>
    <div className="dialogue-timeline">
      <div className="dialogue-timeline-scroll" ref={timelineScroll}>
        <div className="dialogue-timeline-track" ref={track} role="toolbar" aria-orientation="horizontal" aria-label="对话日期时间轴：左右方向键切换日期，Enter 进入片段" data-searching={terms.length ? '' : undefined}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault();
              stepDay(event.key === 'ArrowLeft' ? -1 : 1);
            } else if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault();
              stepDay(0, event.key === 'Home' ? 'home' : 'end');
            } else if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === ' ') {
              if ((event.target as HTMLElement).closest('.dialogue-tl-day.has')) {
                event.preventDefault();
                stack.current?.querySelector<HTMLElement>('.dialogue-snippet-card.front')?.focus({ preventScroll: true });
              }
            }
          }}>
          {timelineGroups.map(group => <div key={group.month} className="dialogue-tl-month">
            <span className="dialogue-tl-month-label">{group.label}</span>
            <div className="dialogue-tl-days">
              {group.cells.map(({ key, day }) => {
                if (!day) return <span key={key} className="dialogue-tl-day" aria-hidden="true" data-week={keyToDate(key).getDay() === 1 ? '' : undefined} />;
                const on = key === selectedKey;
                const count = day.count;
                const hitCount = hitCounts.get(key) ?? 0;
                const searching = terms.length > 0;
                const dim = searching && !hitCount;
                return <button key={key} type="button" className="dialogue-tl-day has" data-week={keyToDate(key).getDay() === 1 ? '' : undefined}
                  ref={element => { if (element) dayButtons.current.set(key, element); else dayButtons.current.delete(key); }}
                  aria-pressed={on} tabIndex={on ? 0 : -1}
                  aria-label={`${dateLabel(key)} ${weekday(key)}，${count} 条消息${searching ? (hitCount ? `，命中 ${hitCount} 处` : '，没有命中') : ''}`}
                  onClick={() => selectDay(key, searching ? 0 : 'last')}>
                  <i className={`dialogue-tl-dot tier-${dotTier(count)}`} data-hit={hitCount > 0 && !dim ? '' : undefined} data-dim={dim ? '' : undefined} aria-hidden="true" />
                  {on ? <span className="dialogue-tl-num" aria-hidden="true">{keyToDate(key).getDate()}</span> : null}
                </button>;
              })}
            </div>
          </div>)}
        </div>
      </div>
    </div>
    <div className="dialogue-history-day">
      <div className="dialogue-day-title">
        <strong>{selectedDay ? `${dateLabel(selectedDay.key)} · ${weekday(selectedDay.key)}` : ''}</strong>
        <span>{terms.length
          ? (hitCounts.get(selectedKey) ?? 0) ? `这天命中 ${hitCounts.get(selectedKey)} 处` : '这天没有命中，先看这天的片段'
          : selectedDay ? `${selectedDay.count} 条消息 · ${cards.length} 段对话` : ''}</span>
      </div>
      <div className="dialogue-day-tools">
        <span className="dialogue-timeline-legend" aria-hidden="true"><i className="tier-1" /><i className="tier-2" /><i className="tier-3" /><span>消息多少</span></span>
        <button type="button" className="dialogue-clear-filters" onClick={reset}>清空条件</button>
      </div>
    </div>
    <div className="dialogue-snippets" data-empty={terms.length && !hits.length ? '' : undefined}>
      {!days.length
        ? <div className="dialogue-history-empty"><Icon name="history" size={28} /><h3>{loading ? '正在读取历史…' : '还没有可检索的历史。'}</h3><p>{loading ? '已保存的消息会逐页载入。' : '发出第一条消息后，这里会按日期留下对话。'}</p></div>
        : terms.length && !hits.length
          ? <div className="dialogue-history-empty"><Icon name="search" size={28} /><h3>这段时间里，还没找到。</h3><p>换一个词试试，或清空条件看看全部日期。</p><button type="button" className="dialogue-empty-reset" onClick={reset}>清空条件</button></div>
          : <div className="dialogue-card-stack" ref={stack} role="group" aria-roledescription="叠放片段" aria-label="当天片段：左右方向键切换，Enter 回到这句话"
            onKeyDown={event => {
              if (event.key === 'ArrowLeft') { event.preventDefault(); moveCard(-1); }
              else if (event.key === 'ArrowRight') { event.preventDefault(); moveCard(1); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); dayButtons.current.get(selectedKey)?.focus({ preventScroll: true }); }
            }}
            onPointerDown={event => { swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId }; }}
            onPointerUp={event => {
              if (!swipe.current || swipe.current.id !== event.pointerId) return;
              const dx = event.clientX - swipe.current.x;
              const dy = event.clientY - swipe.current.y;
              swipe.current = null;
              if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                suppressClick.current = true;
                window.setTimeout(() => { suppressClick.current = false; }, 0);
                moveCard(dx < 0 ? 1 : -1);
              }
            }}
            onPointerCancel={() => { swipe.current = null; }}
            onClick={event => {
              if (suppressClick.current) { suppressClick.current = false; return; }
              const card = (event.target as HTMLElement).closest('.dialogue-snippet-card') as HTMLElement | null;
              if (!card) return;
              const index = Number(card.dataset.card);
              if (card.classList.contains('front')) locateCard(Number(card.dataset.targetId));
              else moveCard(index - cardIndex);
            }}>
            {behind.map((index, depth) => {
              const card = cards[index];
              if (!card) return null;
              return <div key={`${card.targetId}-${index}`} className={`dialogue-snippet-card behind-${depth + 1}`} data-card={index} data-target-id={card.targetId} aria-hidden="true">
                <CardBody card={card} query={query} />
              </div>;
            })}
            {cards[cardIndex] ? <button type="button" className="dialogue-snippet-card front" data-card={cardIndex} data-target-id={cards[cardIndex].targetId}
              aria-label={cardLabel(cards[cardIndex], query)}>
              <CardBody card={cards[cardIndex]} query={query} />
            </button> : null}
          </div>}
      <div className="dialogue-card-controls">
        <button type="button" className="dialogue-card" aria-label="上一张片段" disabled={cardIndex <= 0} onClick={() => moveCard(-1)}><Icon name="chev-left" size={17} /></button>
        <span>{cards.length ? `${cardIndex + 1} / ${cards.length}` : ''}</span>
        <button type="button" className="dialogue-card" aria-label="下一张片段" disabled={cardIndex >= cards.length - 1} onClick={() => moveCard(1)}><Icon name="chev-right" size={17} /></button>
        <span className="dialogue-card-hint">点片段，回到这句话</span>
      </div>
      {cards[cardIndex] && scenes.filter(scene => {
        const target = cards[cardIndex].lines.find(line => line.main);
        return scene.status === 'succeeded' && !!target?.segmentId && scene.messageId === target.messageId && scene.startSegmentId === target.segmentId;
      }).map(scene =>
        <button key={scene.id} type="button" className="dialogue-scene-chip" onClick={() => onOpenScene(scene)}>查看{scene.mode === 'background' ? '背景图' : '人物场景图'}</button>
      )}
    </div>
  </section>;
}
