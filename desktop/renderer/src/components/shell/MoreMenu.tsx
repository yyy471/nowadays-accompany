import { DropdownMenu } from '../../ui';
import { ALL_PAGES } from '../../lib/navigation';
export function MoreMenu({label='全部菜单',onNavigate,currentLabel}:{label?:string;currentLabel?:string;onNavigate:(page:string)=>void}) {
  return <DropdownMenu label={label} currentLabel={currentLabel} items={ALL_PAGES.map(page=>({id:page.id,label:page.label,icon:page.icon,onSelect:()=>onNavigate(page.id)}))}/>;
}
