import { api } from '../../api';

export interface RunningJob { jobId: string; extId: string; title: string; startedAt: string }

export function subscribeEngineering(base: string, update: (jobs: RunningJob[]) => void) {
  const stream = new EventSource(base + '/v1/engineering/events');
  stream.addEventListener('snapshot', event => update(JSON.parse(event.data)));
  return () => stream.close();
}

export function cancelEngineering(jobId: string) {
  return api('/v1/engineering/jobs/' + encodeURIComponent(jobId) + '/cancel', {method: 'POST'});
}

export function engineeringElapsed(startedAt: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}
