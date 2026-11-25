/** 对话与桌面历史共用的文本判别。单星号动作、全角括号仍走角色演出。 */
export function replyFormat(text: string): 'markdown' | 'literal' | null {
  const value = text.trimStart();
  if (!value) return null;
  if (/^(?:#![^\n]+\n|(?:async +)?def +\w+\([^\n]*\)[^\n]*:\s*\n|(?:export +)?(?:async +)?function +[\w$]+\([^\n]*\)\s*\{|\[[\w.-]+\]\s*\n[\w.-]+\s*=)/.test(value)) return 'literal';
  if (/^(?:\{\s*(?:"|\}|$)|\[\s*(?:\{|\[|"|\]|-?\d|true\b|false\b|null\b))/.test(value)) return 'literal';
  if (/^(?:<\?xml\b|<!doctype\b|<([\w:-]+)(?:\s[^>]*|\/?)>[\s\S]*<\/\1>)/i.test(value) ||
      /^(?:---\r?\n)?[\w.-]+:[^\n]*\r?\n[ \t]*(?:[\w.-]+:|-[ \t])/.test(value)) return 'literal';
  if (/^ {0,3}(?:#{1,6}[ \t]+|\x60{3,}|~{3,}|>[ \t]|[-+*][ \t]+|\d+[.)][ \t]+|(?:-{3,}|\*{3,}|_{3,}|={3,})[ \t]*$|\|?[ \t]*:?-{3,}:?[ \t]*\|)/m.test(text) ||
      /(?:\*\*[^*\n]+\*\*|__[^_\n]+__|\x60[^\x60\n]+\x60)/.test(text) ||
      (text.includes('](') && text.includes('['))) return 'markdown';
  return null;
}
