import { ControlButton, Icon, type IconName } from '../../ui';
import { MoreMenu } from './MoreMenu';
import { PAGES } from '../../lib/navigation';
const destinations:Array<{id:string;label:string;icon:IconName}>=[
  {id:'home',label:'桌面',icon:'user'},{id:'roles',label:'关系',icon:'accounts'},
  {id:'model-config',label:'模型',icon:'bolt'},{id:'artifacts',label:'收藏',icon:'artifacts'}
];
export function PageDock({page,onNavigate}:{page:string;onNavigate:(page:string)=>void}) {
  return <nav className="ui-page-dock" aria-label="主导航">
    {destinations.map(item=><ControlButton key={item.id} aria-current={page===item.id?'page':undefined} onClick={()=>onNavigate(item.id)}><Icon name={item.icon} size={20}/><span>{item.label}</span></ControlButton>)}
    <MoreMenu label="更多" currentLabel={destinations.some(item=>item.id===page)?undefined:PAGES.find(item=>item.id===page)?.title} onNavigate={onNavigate}/>
  </nav>;
}
