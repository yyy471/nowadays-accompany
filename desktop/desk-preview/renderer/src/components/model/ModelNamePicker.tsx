import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Button, Field, Input } from '../../ui';
import { filterModelNames } from './model-picker.js';

export interface ModelNamePickerProps {
  value: string;
  onChange: (value: string) => void;
  models: readonly string[];
  listBusy: boolean;
  listError: string;
  listLoaded: boolean;
  onRefresh: () => void;
  onTest: () => void;
  testBusy: boolean;
  /** 调用方按当前模型名过滤后的测试结果。 */
  testNote: string;
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
  onChange,
  models,
  listBusy,
  listError,
  listLoaded,
  onRefresh,
  onTest,
  testBusy,
  testNote,
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
    () => filterModelNames(models, open ? query : value),
    [models, open, query, value],
  );

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
      setOpen(false);
      setActive(-1);
    }
  };

  return <Field label={label} hint={hint ?? '选择或输入模型名称；列表读取失败时可直接手填。'}>
    <div className="nd-model-picker">
      <Input
        value={value}
        disabled={disabled}
        placeholder="选择或输入模型名称"
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
        onBlur={() => { window.setTimeout(() => setOpen(false), 120); }}
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
      <Button size="sm" disabled={disabled || listBusy} onClick={onRefresh}>{listBusy ? '正在读取…' : '读取模型列表'}</Button>
      <Button size="sm" disabled={disabled || testBusy || testDisabled} onClick={onTest}>{testBusy ? '正在测试…' : '测试连接'}</Button>
    </div>
    {listError ? <p className="config-muted" role="alert">读取失败：{listError}。可继续手填模型名称。</p> : null}
    {listLoaded && listError.length === 0 && models.length === 0 ? <p className="config-muted">服务没有返回模型，可继续手填。</p> : null}
    {testNote ? <p className="config-muted" role="status">{testNote}</p> : null}
  </Field>;
}
