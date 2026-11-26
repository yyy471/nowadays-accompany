import { useEffect, useState } from 'react';
import { backendBaseUrl } from '../../conversation/backend-base';
import { Button, UiThemeScope } from '../../ui';
import { cancelEngineering, engineeringElapsed, subscribeEngineering, type RunningJob } from './engineering-progress';
import '../../styles/engineering-capsule.css';

function EngineeringRow({job, now}: {job: RunningJob; now: number}) {
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
  return <div className="engineering-row">
    <div><strong title={job.title}>{job.title || job.extId}</strong>
      <small>{cancelling ? '正在取消' : '工程进行中'} · {engineeringElapsed(job.startedAt, now)}</small></div>
    <Button disabled={cancelling} aria-label={'取消工程 ' + job.extId} onClick={() => void cancel()}>取消</Button>
    {error && <small role="alert">{error}</small>}
  </div>;
}

export function EngineeringCapsule() {
  const [jobs, setJobs] = useState<RunningJob[]>([]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void backendBaseUrl().then(base => {
      if (!active) return;
      unsubscribe = subscribeEngineering(base ?? '', snapshot => {
        setNow(Date.now());
        setJobs(snapshot);
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
  return <UiThemeScope theme="xiacheng" className="engineering-capsule"><aside aria-label="后台工程">
    {jobs.map(job => <EngineeringRow key={job.jobId} job={job} now={now}/>)}
  </aside></UiThemeScope>;
}
