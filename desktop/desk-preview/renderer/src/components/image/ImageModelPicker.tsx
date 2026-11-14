import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Button, Field, Input } from '../../ui';
import { filterModelNames, visibleProbeNotice, type ProbeNotice } from '../model/model-picker.js';

export interface ImageModelPickerProps {
  value: string;
  onChange: (value: string) => void;
  models: readonly string[];
  listBusy: boolean;
  onRefresh: () => void;
  onTest: () => void;
  testBusy: boolean;
  notice?: ProbeNotice | null;
  disabled?: boolean;
  probeDisabled?: boolean;
  label?: string;
  hint?: string;
  placeholder?: string;
}

/**
 * 生图模型选择控件：交互、候选下拉与单条点击日志行为与文本模型 ModelNamePicker 保持一致。
 * 测试连接不强依赖预先填入模型名，未选模型时也能验证服务可达性与默认工作流节点。
 */
export function ImageModelPicker({
  value,
  onChange,
  models,
  listBusy,
  onRefresh,
  onTest,
  testBusy,
  notice,
  disabled = false,
  probeDisabled = false,
  label = '默认生图模型',
  hint = '选择探测到的模型，或手动输入模型名；也可留空在角色配置时分别指定。',
  placeholder = 'moss_image_sft_int8_convrot.safetensors',
}: ImageModelPickerProps) {
  const listId = `image-model-options-${useId()}`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);

  const filtered = useMemo(
    () => filterModelNames(models, open ? query : value),
    [models, open, query, value],
  );
  const activeNotice = useMemo(
    () => visibleProbeNotice(notice ?? null, value),
    [notice, value],
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

  return (
    <Field label={label} hint={hint}>
      <div className="nd-model-picker">
        <Input
          value={value}
          disabled={disabled}
          maxLength={2000}
          placeholder={placeholder}
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
        {open && filtered.length > 0 ? (
          <ul className="nd-model-options" id={listId} role="listbox" aria-label="生图模型候选">
            {filtered.map((name, index) => (
              <li
                key={name}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={value === name}
                data-active={index === active ? '' : undefined}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={event => {
                    event.preventDefault();
                    choose(name);
                  }}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="config-actions">
        <Button size="sm" disabled={disabled || probeDisabled || listBusy} onClick={onRefresh}>
          {listBusy ? '正在读取…' : '读取模型列表'}
        </Button>
        <Button size="sm" disabled={disabled || probeDisabled || testBusy} onClick={onTest}>
          {testBusy ? '正在测试…' : '测试连接'}
        </Button>
      </div>
      {activeNotice ? (
        <p className="config-muted" role={activeNotice.role}>
          {activeNotice.text}
        </p>
      ) : null}
    </Field>
  );
}
