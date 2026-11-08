import type { ReactNode, Ref } from 'react';
import { DropdownMenu, type IconName } from '../../ui';
import { ALL_PAGES } from '../../lib/navigation';
export function MoreMenu({ label = '全部菜单', onNavigate, currentLabel, triggerIcon, triggerRef, triggerClassName, triggerLayout, triggerDecoration }: {
  label?: string; currentLabel?: string; onNavigate: (page: string) => void;
  triggerIcon?: IconName; triggerRef?: Ref<HTMLButtonElement>; triggerClassName?: string;
  triggerLayout?: 'inline' | 'stacked'; triggerDecoration?: ReactNode;
}) {
  return <DropdownMenu label={label} currentLabel={currentLabel} items={ALL_PAGES.map(page => ({ id: page.id, label: page.label, icon: page.icon, onSelect: () => onNavigate(page.id) }))}
    triggerIcon={triggerIcon} triggerRef={triggerRef} triggerClassName={triggerClassName} triggerLayout={triggerLayout} triggerDecoration={triggerDecoration}/>;
}
