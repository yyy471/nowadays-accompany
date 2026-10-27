import { afterAll,beforeEach,expect,it,vi } from 'vitest';
import * as React from 'react';
vi.stubGlobal('React',React);afterAll(()=>vi.unstubAllGlobals());
const h=vi.hoisted(()=>({cells:[] as any[],index:0}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),
  useState:(initial:any)=>{const i=h.index++;if(!(i in h.cells))h.cells[i]=initial;return[h.cells[i],(value:any)=>{h.cells[i]=typeof value==='function'?value(h.cells[i]):value;}];},
  useRef:(initial:any)=>{const i=h.index++;return h.cells[i]??={current:initial};}
}));
vi.mock('../desktop/renderer/src/ui',()=>({ControlButton:'ControlButton',Icon:'Icon',IconButton:'IconButton',Modal:'Modal',SearchInput:'SearchInput'}));
import { AccountSwitcher } from '../desktop/renderer/src/components/shell/AccountSwitcher';
let selected:string,accepted:boolean;const focus=vi.fn();
const accounts=['10001','10002','10003'].map(accountId=>({accountId,nickname:`昵称${accountId}`})) as any;
function find(node:any,predicate:(node:any)=>boolean):any {if(!node||typeof node!=='object')return;if(predicate(node))return node;for(const child of [node.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found;}}
function render(){h.index=0;const tree=AccountSwitcher({accounts,selected,loading:false,onSelect:async id=>{if(accepted)selected=id;return accepted;}});const rows=find(tree,(node:any)=>node.props?.role==='toolbar').props.children as React.ReactElement<any>[];rows.forEach(row=>row.props.ref({focus}));return rows;}
async function key(row:React.ReactElement<any>,key:string,extra={}){const event={key,preventDefault:vi.fn(),...extra};row.props.onKeyDown(event);await Promise.resolve();await Promise.resolve();return event;}
beforeEach(()=>{h.cells=[];selected='10001';accepted=true;focus.mockClear();});
it('keeps one tab stop and uses guarded arrow wrapping, Home and End',async()=>{
  let rows=render();expect(rows.map(row=>row.props.tabIndex)).toEqual([0,-1]);
  await key(rows[0]!,'ArrowLeft');rows=render();expect(selected).toBe('10002');expect(rows[1]!.props['aria-pressed']).toBe(true);
  await key(rows[1]!,'Home');expect(selected).toBe('10001');await key(render()[0]!,'End');expect(selected).toBe('10002');
  await key(render()[1]!,'ArrowRight');expect(selected).toBe('10001');expect(focus).toHaveBeenCalledWith({preventScroll:true});
});
it('preserves native activation/shortcuts and does not move selection or focus when the guard rejects',async()=>{
  const rows=render();expect((await key(rows[0]!,'Enter')).preventDefault).not.toHaveBeenCalled();
  expect((await key(rows[0]!,'ArrowRight',{ctrlKey:true})).preventDefault).not.toHaveBeenCalled();
  accepted=false;await key(rows[0]!,'ArrowRight');expect(selected).toBe('10001');expect(focus).not.toHaveBeenCalled();
});
it('keeps an overflow selection visible and never silently substitutes a removed selection',()=>{
  selected='10003';expect(render().map(row=>row.props['aria-pressed'])).toEqual([false,false,true]);
  selected='removed';const rows=render();expect(selected).toBe('removed');expect(rows.some(row=>row.props['aria-pressed'])).toBe(false);expect(rows[0]!.props.tabIndex).toBe(0);
});
