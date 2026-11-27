import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { backendBaseUrl } from '../../conversation/backend-base';
import { Button, UiThemeScope, useMotionPolicy, readMotionTime } from '../../ui';
import { cancelEngineering, engineeringElapsed, subscribeEngineering, type RunningJob } from './engineering-progress';
import '../../styles/engineering-capsule.css';

type Ticket = RunningJob & { leaving?: boolean };

function EngineeringRow({job, now, remove}: {job: Ticket; now: number; remove: () => void}) {
  const row = useRef<HTMLDivElement>(null);
  const { reduced } = useMotionPolicy();
  useLayoutEffect(() => {
    if (!job.leaving || !row.current) return;
    // 最后一项即使收成单行，也在实际淡出结束后撤下工签。
    const surface = row.current.offsetHeight ? row.current : row.current.closest<HTMLElement>('aside[inert]');
    if (reduced || document.hidden || !surface) { remove(); return; }
    const fade = surface.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: readMotionTime(surface, '--nd-semantic-motion-micro-exit', 90), fill: 'forwards'
    });
    fade.onfinish = remove;
    return () => { fade.onfinish = null; fade.cancel(); };
  }, [job.leaving, reduced]);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  async function cancel() {
    setCancelling(true);
    setError('');
    try { await cancelEngineering(job.jobId); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : '工程取消失败');
      setCancelling(false);
    }
  }
  return <div className="engineering-row" ref={row} inert={job.leaving}>
    <div><strong title={job.title}>{job.title || job.extId}</strong>
      <small>{cancelling ? '正在取消' : '工程进行中'} · {engineeringElapsed(job.startedAt, now)}</small></div>
    <Button busy={cancelling} aria-label={'取消工程 ' + job.extId} onClick={() => void cancel()}>取消</Button>
    {error && <small role="alert">{error}</small>}
  </div>;
}

export function EngineeringCapsule() {
  const [jobs, setJobs] = useState<Ticket[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void backendBaseUrl().then(base => {
      if (!active) return;
      unsubscribe = subscribeEngineering(base ?? '', snapshot => {
        setNow(Date.now());
        setJobs(previous => [...snapshot, ...previous.filter(job => !snapshot.some(item => item.jobId === job.jobId))
          .map(job => ({ ...job, leaving: true }))]);
        if (!snapshot.length) setExpanded(false);
      });
    }).catch(error => console.warn('ENGINEERING_STREAM_UNAVAILABLE', error));
    return () => { active = false; unsubscribe?.(); };
  }, []);
  const visible = jobs.length > 0;
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);
  if (!visible) return null;
  const count = jobs.filter(job => !job.leaving).length;
  return <UiThemeScope theme="xiacheng" className="engineering-capsule"><aside className="ui-floating-surface" aria-label="后台工程" data-expanded={expanded} inert={!count}>
    <Button className="engineering-summary" variant="ghost" aria-expanded={expanded} aria-controls="engineering-jobs"
      onClick={() => setExpanded(value => !value)}>后台工程 {count || jobs.length} 项</Button>
    <div className="engineering-jobs" id="engineering-jobs">{jobs.map(job => <EngineeringRow key={job.jobId} job={job} now={now}
      remove={() => setJobs(previous => previous.filter(item => item.jobId !== job.jobId || !item.leaving))}/>)}</div>
  </aside></UiThemeScope>;
}
