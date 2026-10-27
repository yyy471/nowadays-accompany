import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
const h=vi.hoisted(()=>({cells:[] as any[],index:0,effects:[] as Array<()=>void>,cleanups:new Map<number,()=>void>(),api:vi.fn()}));
vi.mock('../desktop/renderer/src/api',()=>({api:(...args:any[])=>h.api(...args)}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:(initial:any)=>{const i=h.index++;if(!(i in h.cells))h.cells[i]=typeof initial==='function'?initial():initial;return[h.cells[i],(value:any)=>{h.cells[i]=typeof value==='function'?value(h.cells[i]):value;}];},
  useRef:(value:any)=>{const i=h.index++;return h.cells[i]??={current:value};},
  useCallback:(fn:any)=>{h.index++;return fn;},
  useEffect:(fn:()=>any,deps:any[])=>{const i=h.index++;const previous=h.cells[i];if(!previous||deps.some((value,index)=>!Object.is(value,previous[index])))h.effects.push(()=>{h.cleanups.get(i)?.();const cleanup=fn();if(typeof cleanup==='function')h.cleanups.set(i,cleanup);else h.cleanups.delete(i);});h.cells[i]=deps;}
}));
import { updateQueryData,usePoll } from '../desktop/renderer/src/hooks';
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function render(path:string,revalidate=false){h.index=0;h.effects=[];const result=usePoll<{value:string}>(path,0,revalidate);h.effects.forEach(effect=>effect());return result;}
async function settle(){for(let i=0;i<12;i++)await Promise.resolve();}
function unmount(){for(const cleanup of h.cleanups.values())cleanup();h.cleanups.clear();h.cells=[];}
beforeEach(()=>{vi.useFakeTimers();h.cells=[];h.api.mockReset();vi.stubGlobal('document',{hidden:false});});
afterEach(()=>{unmount();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('shared renderer query cache',()=>{
  it('does not let a read started before a confirmed write undo that write',async()=>{
    const pending=deferred<{value:string}>();h.api.mockReturnValueOnce(pending.promise);render('/test/write-order');
    updateQueryData('/test/write-order',{value:'confirmed'});expect(render('/test/write-order').data?.value).toBe('confirmed');
    pending.resolve({value:'old-read'});await settle();expect(render('/test/write-order').data?.value).toBe('confirmed');
    h.api.mockResolvedValueOnce({value:'new-external-state'});await render('/test/write-order').refresh();expect(render('/test/write-order').data?.value).toBe('new-external-state');
  });
  it('does not let an obsolete read failure poison confirmed mutation data',async()=>{
    const pending=deferred<{value:string}>();h.api.mockReturnValueOnce(pending.promise);render('/test/write-error');updateQueryData('/test/write-error',{value:'confirmed'});
    pending.reject(new Error('old failure'));await settle();const result=render('/test/write-error');expect(result.error).toBeUndefined();expect(result.data?.value).toBe('confirmed');
  });
  it('opts into revalidation on return while preserving existing default cache behavior',async()=>{
    h.api.mockResolvedValueOnce({value:'first'});render('/test/reenter');await settle();unmount();render('/test/reenter');expect(h.api).toHaveBeenCalledTimes(1);expect(render('/test/reenter').data?.value).toBe('first');
    unmount();h.api.mockResolvedValueOnce({value:'fresh'});render('/test/reenter',true);await settle();expect(render('/test/reenter',true).data?.value).toBe('fresh');expect(h.api).toHaveBeenCalledTimes(2);
  });
  it('keeps a late A response out of the current B snapshot and refreshes B',async()=>{
    const pending=deferred<{value:string}>();h.api.mockReturnValueOnce(pending.promise).mockResolvedValue({value:'B'});render('/test/account-A');render('/test/account-B');await settle();
    pending.resolve({value:'A'});await settle();expect(render('/test/account-B').data?.value).toBe('B');await render('/test/account-B').refresh();expect(h.api.mock.lastCall?.[0]).toBe('/test/account-B');
  });
  it('deduplicates overlapping refreshes into one trailing read',async()=>{
    const first=deferred<{value:string}>(),second=deferred<{value:string}>();h.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);render('/test/dedupe');
    const result=render('/test/dedupe'),a=result.refresh(),b=result.refresh();expect(h.api).toHaveBeenCalledTimes(1);
    first.resolve({value:'first'});await settle();expect(h.api).toHaveBeenCalledTimes(2);second.resolve({value:'second'});await Promise.all([a,b]);expect(render('/test/dedupe').data?.value).toBe('second');
  });
});
