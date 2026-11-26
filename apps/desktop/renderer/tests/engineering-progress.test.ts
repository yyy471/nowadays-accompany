import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelEngineering, engineeringElapsed, subscribeEngineering, type RunningJob } from '../src/components/shell/engineering-progress.ts';

test('工程耗时按桌面时钟推进，校时后不显示负值', () => {
  const start = '2026-11-26T01:00:00Z';
  assert.equal(engineeringElapsed(start, Date.parse(start) - 1000), '0:00');
  assert.equal(engineeringElapsed(start, Date.parse(start) + 65010), '1:05');
});

test('初始快照、跨页更新与完成后的空快照独立于输入通道', t => {
  let emit!: (jobs: RunningJob[]) => void;
  let closed = false;
  class FakeSource extends EventTarget {
    constructor(url: string) {
      super();
      assert.equal(url, 'http://localhost/v1/engineering/events');
      emit = jobs => this.dispatchEvent(new MessageEvent('snapshot', {data:JSON.stringify(jobs)}));
    }
    close() { closed = true; }
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  Object.defineProperty(globalThis, 'EventSource', {value:FakeSource,configurable:true});
  t.after(() => {
    if (original) Object.defineProperty(globalThis,'EventSource',original);
    else Reflect.deleteProperty(globalThis,'EventSource');
  });
  const updates: string[][] = [];
  const unsubscribe = subscribeEngineering('http://localhost', jobs => updates.push(jobs.map(job=>job.jobId)));
  const job = {jobId:'one',title:'工程',extId:'sample',startedAt:new Date().toISOString()};
  emit([job,{...job,jobId:'two'}]);
  emit([job]);
  emit([]);
  unsubscribe();
  assert.deepEqual(updates,[['one','two'],['one'],[]]);
  assert.ok(closed);
});

test('取消按钮提交指定工程编号', async t => {
  const request = t.mock.method(globalThis,'fetch', async () => Response.json({state:'cancelled'}));
  await cancelEngineering('job-2');
  const [url, options] = request.mock.calls[0]!.arguments;
  assert.equal(url,'/v1/engineering/jobs/job-2/cancel');
  assert.equal(options?.method,'POST');
});
