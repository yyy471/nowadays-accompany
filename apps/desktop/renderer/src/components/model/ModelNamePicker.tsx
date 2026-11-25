import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Button, Field, Input } from '../../ui';
import { filterModelNames, visibleProbeNotice, type ProbeNotice } from './model-picker';

export interface ModelNamePickerProps {
  value: string;
  settings?: boolean;
  roleLayout?: 'service' | 'memory';
  onChange: (value: string) => void;
  models: readonly string[];
  presets?: readonly string[];
  listBusy: boolean;
  listError: string;
  listLoaded: boolean;
  onRefresh: () => void;
  onTest: () => void;
  testBusy: boolean;
  /** 调用方按当前模型名过滤后的测试结果。 */
  testNote: string;
  /** 读取列表与测试连接共享的互斥点击日志（存在时优先于分散字段）。 */
  notice?: ProbeNotice | null;
  disabled?: boolean;
  testDisabled?: boolean;
  label?: string;
  hint?: string;
}

/**
 * 「选择或输入模型名称」控件：候选来自服务返回的列表，手填始终可用。
 *
 * 已选值与搜索词分开：重新聚焦或点击字段时打开完整候选；打字时按输入筛选；
 * 方向键移动、Enter 选中、Esc 关闭。列表与测试由按钮主动触发。
 */
export function ModelNamePicker({
  value,
  settings = false,
  roleLayout,
  onChange,
  models,
  presets,
  listBusy,
  listError,
  listLoaded,
  onRefresh,
  onTest,
  testBusy,
  testNote,
  notice,
  disabled = false,
  testDisabled = false,
  label = '模型名称',
  hint,
}: ModelNamePickerProps) {
  const listId = `model-options-${useId()}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  // 打开时用搜索词筛选；关闭时保留已选/已填值。
  const filtered = useMemo(
    () => filterModelNames(presets ?? models, open ? query : value),
    [models, presets, open, query, value],
  );
  const activeNotice = useMemo<ProbeNotice | null>(() => {
    if (notice !== undefined) {
      return visibleProbeNotice(notice, value);
    }
    if (listError) {
      return {
        source: 'list',
        role: 'alert',
        text: `读取失败：${listError}。可手填模型名后测试连接。`,
      };
    }
    if (testNote) {
      return { source: 'test', role: 'status', text: testNote };
    }
    if (listLoaded && models.length === 0) {
      return {
        source: 'list',
        role: 'status',
        text: '未返回模型列表，可手填模型名。',
      };
    }
    return null;
  }, [notice, value, listError, testNote, listLoaded, models.length]);

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery('');
    setActive(-1);
  };

  const openList = () => {
    setOpen(true);
    setQuery('');
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        openList();
        setActive(0);
      } else {
        setActive(previous => Math.min(filtered.length - 1, previous + 1));
      }
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (open) setActive(previous => Math.max(0, previous - 1));
      else openList();
      return;
    }
    if (
      event.key === 'Enter' &&
      open &&
      active >= 0 &&
      filtered[active] !== undefined
    ) {
      event.preventDefault();
      choose(filtered[active]!);
      return;
    }
    if (event.key === 'Escape') {
      if (open && filtered.length > 0) event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  return <Field label={label} hint={settings || roleLayout ? undefined : hint ?? '选择或直接输入模型名称；接口未开放列表时，手填模型名即可测试与保存。'}>
    <div className={roleLayout ? 'config-role-model-picker' : settings ? 'config-service-model-picker' : undefined}>
    <div className="nd-model-picker">
      <Input
        value={value}
        disabled={disabled}
        placeholder={presets ? '选择预置模型，或直接手填' : roleLayout ? '从列表选择或手填' : settings ? '读取列表后选择，或直接手填' : '选择或输入模型名称'}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open && filtered.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={openList}
        onClick={() => { if (!open) openList(); }}
        onChange={event => {
          onChange(event.target.value);
          setQuery(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={event => {
          const input = event.currentTarget;
          window.setTimeout(() => { if (document.activeElement !== input) setOpen(false); }, 120);
        }}
      />
      {open && filtered.length > 0 ? <ul className="nd-model-options" id={listId} role="listbox" aria-label="模型候选">
        {filtered.map((name, index) => <li key={name} id={`${listId}-${index}`} role="option" aria-selected={value === name} data-active={index === active ? '' : undefined}>
          <button type="button" tabIndex={-1}
            onMouseDown={event => { event.preventDefault(); choose(name); }}>
            {name}
          </button>
        </li>)}
      </ul> : null}
    </div>
    <div className="config-actions">
      {presets ? <span className="config-muted">预置模型</span> :
        <Button size="sm" disabled={disabled || listBusy || testBusy} onClick={onRefresh}>{listBusy ? '正在读取…' : settings || roleLayout ? '读取列表' : '读取模型列表'}</Button>}
      {roleLayout !== 'service' && <Button size="sm" disabled={disabled || testBusy || testDisabled || listBusy} onClick={onTest}>{testBusy ? '正在测试…' : roleLayout ? '测试' : '测试连接'}</Button>}
    </div>
    </div>
    {activeNotice || roleLayout ? <p className={activeNotice?.role === 'alert' ? 'config-sheet-error config-role-model-note' : 'config-muted config-role-model-note'} role={roleLayout && activeNotice?.source === 'test' ? undefined : activeNotice?.role}>{activeNotice?.text}</p> : null}
  </Field>;
}
