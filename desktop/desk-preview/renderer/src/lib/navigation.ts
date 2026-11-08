import type { IconName } from '../ui';
export interface PageDef { id:string; label:string; icon:IconName; title:string; subtitle:string }
export const PAGES: PageDef[] = [{id:'home',label:'主页',icon:'user',title:'主页',subtitle:''},{id:'roles',label:'关系',icon:'accounts',title:'关系',subtitle:''},{id:'conversation',label:'对话',icon:'messages',title:'对话',subtitle:''}];
export const ALL_PAGES: PageDef[] = [{id:'settings',label:'设置',icon:'settings',title:'设置',subtitle:''}];
