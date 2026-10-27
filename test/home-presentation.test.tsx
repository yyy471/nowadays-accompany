import { describe,expect,it } from 'vitest';
import { bindingElementId,homeConnection } from '../desktop/renderer/src/lib/home-presentation';
describe('homepage identity and state mapping',()=>{
  it('keeps account, kind and peer separate, including separators and Unicode',()=>{
    const keys=[{accountId:'A',kind:'group' as const,peerId:'42'},{accountId:'A',kind:'private' as const,peerId:'42'},{accountId:'B',kind:'group' as const,peerId:'42'},{accountId:'A/B',kind:'group' as const,peerId:'名字/# ?'}].map(bindingElementId);
    expect(new Set(keys).size).toBe(4);expect(keys.every(key=>!key.includes(' '))).toBe(true);
  });
  it('distinguishes missing/failed snapshots from a successful offline result',()=>{
    expect(homeConnection('A').label).toBe('正在读取连接状态');
    expect(homeConnection('A',{slots:[]} as any,'failed').label).toBe('连接状态待更新');
    expect(homeConnection('A',{slots:[]} as any).label).toBe('QQ 未连接');
  });
  it('only reports a confirmed connection belonging to the selected account',()=>{
    const slots={slots:[{accountId:'A',state:'online',connected:true},{accountId:'B',state:'online',connected:false}]} as any;
    expect(homeConnection('A',slots).connected).toBe(true);expect(homeConnection('B',slots).connected).toBe(false);expect(homeConnection('missing',slots).connected).toBe(false);
  });
});
