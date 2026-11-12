/**
 * 点击消息区是否应推进下一句。
 *
 * 按钮、链接、输入框、可拖动控件和已选中的文字保留各自的交互；
 * 其余空白、正文与动作文字都可以推进。
 */

const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, label, [data-no-advance]";

/**
 * @param {EventTarget | null} target
 * @param {boolean} hasSelection 页面中是否有非折叠选区
 * @returns {boolean}
 */
export function shouldAdvanceFromClick(target, hasSelection) {
  if (hasSelection) return false;
  const element =
    target !== null && typeof target === 'object' && typeof target.closest === 'function'
      ? target
      : null;
  return element === null || element.closest(INTERACTIVE_SELECTOR) === null;
}

/** 焦点在消息区时按 Enter / 空格推进。 */
export function shouldAdvanceFromKey(key, target, currentTarget) {
  return (key === "Enter" || key === " ") && target === currentTarget;
}
