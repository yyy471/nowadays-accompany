import { useRef, useState } from 'react';
import { ControlButton, Icon, IconButton, Modal, SearchInput } from '../../ui';
import type { AccountSummary } from '../../types';

export function AccountSwitcher({ accounts, selected, loading, stale, disabled, onSelect }: {
  accounts: AccountSummary[]; selected: string; loading: boolean; stale?: boolean; disabled?: boolean;
  onSelect: (id:string) => Promise<boolean>;
}) {
  const [open,setOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [focused,setFocused] = useState('');
  const [selectionStatus,setSelectionStatus] = useState('');
  const buttons = useRef(new Map<string,HTMLButtonElement>());
  const chosen = accounts.find(account=>account.accountId===selected);
  const visible = accounts.slice(0,2);
  if (chosen && !visible.includes(chosen)) visible.push(chosen);
  const blocked = disabled || stale;
  const select = async (id:string) => { const accepted=await onSelect(id); if(accepted){setOpen(false);setSelectionStatus('');}else setSelectionStatus('账号未切换，当前页面与草稿已保留。');return accepted; };
  const matches = accounts.filter(account=>`${account.nickname??''} ${account.accountId}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const detail = accounts.find(account=>account.accountId===(focused||selected));
  const tabStop = visible.some(account=>account.accountId===selected)?selected:visible[0]?.accountId;
  return <div className="studio-account-switcher">
    <span className="studio-account-caption">主页账号</span>
    {accounts.length ? <div className="ui-account-tabs" role="toolbar" aria-label="选择主页账号" aria-orientation="horizontal">
      {visible.map((account,index)=><ControlButton key={account.accountId} aria-pressed={selected===account.accountId}
        aria-label={`${account.nickname?.trim()||account.accountId}，QQ ${account.accountId}`} title={`QQ ${account.accountId}`}
        disabled={blocked} tabIndex={tabStop===account.accountId?0:-1}
        ref={element=>{if(element)buttons.current.set(account.accountId,element);else buttons.current.delete(account.accountId);}}
        onClick={()=>{void select(account.accountId);}}
        onKeyDown={event=>{
          if(event.ctrlKey||event.metaKey||event.altKey)return;
          const next=event.key==='ArrowRight'?(index+1)%visible.length:event.key==='ArrowLeft'?(index-1+visible.length)%visible.length:event.key==='Home'?0:event.key==='End'?visible.length-1:undefined;
          if(next===undefined)return; event.preventDefault(); const id=visible[next]!.accountId;
          void select(id).then(accepted=>{if(accepted)buttons.current.get(id)?.focus({preventScroll:true});});
        }}>{account.nickname?.trim()||account.accountId}</ControlButton>)}
    </div>:<span className="studio-account-placeholder">{loading?'正在读取账号…':'尚未选择账号'}</span>}
    <IconButton icon="accounts" label="查看全部账号" onClick={()=>{setSearch('');setOpen(true);}} disabled={disabled} />
    <Modal open={open} title="选择主页账号" description="切换后回到对应账号的桌面。业务页保留各自的账号选择。" onClose={()=>setOpen(false)}>
      <div className="ui-modal-content ui-account-picker">
        <SearchInput data-autofocus label="搜索账号" placeholder="昵称或 QQ 号" value={search} onChange={event=>setSearch(event.target.value)} />
        {stale?<p role="status">账号列表更新失败，请先在主页重新读取。</p>:null}
        {selectionStatus?<p role="status">{selectionStatus}</p>:null}
        <p className="ui-account-full-name">{detail?`${detail.nickname?.trim()||'未设置昵称'} · QQ ${detail.accountId}`:'使用昵称或 QQ 号查找账号。'}</p>
        <div className="ui-account-picker-list" role="group" aria-label="全部主页账号">
          {matches.map(account=><ControlButton key={account.accountId} className="ui-account-choice" disabled={blocked}
            aria-pressed={selected===account.accountId} aria-label={`${account.nickname?.trim()||'未设置昵称'}，QQ ${account.accountId}`}
            onFocus={()=>setFocused(account.accountId)} onMouseEnter={()=>setFocused(account.accountId)} onClick={()=>{void select(account.accountId);}}>
            <span>{account.nickname?.trim()||'未设置昵称'}</span><code>{account.accountId}</code>{selected===account.accountId?<Icon name="check" size={16}/>:null}
          </ControlButton>)}
        </div>
        {!matches.length?<p role="status">{loading?'正在读取账号…':accounts.length?'没有匹配的账号。':'还没有账号，请先前往“实例与监听”。'}</p>:null}
      </div>
    </Modal>
  </div>;
}
