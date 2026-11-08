import { createContext, forwardRef, useContext, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Icon } from './icons';

const FieldContext = createContext<{ id: string; hintId?: string; errorId?: string; invalid?: boolean } | undefined>(undefined);
const classes = (...items: Array<string | undefined | false>) => items.filter(Boolean).join(' ');

/** A button primitive for navigation/disclosure layouts; business actions use Button. */
export const ControlButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ type = 'button', ...props }, ref) => <button ref={ref} type={type} {...props} />
);
ControlButton.displayName = 'ControlButton';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, id, 'aria-describedby': describedBy, 'aria-invalid': invalid, type = 'text', ...props }, ref) => {
    const field = useContext(FieldContext);
    const special = ['checkbox', 'radio', 'file', 'hidden', 'range', 'color'].includes(type);
    return <input {...props} ref={ref} type={type} id={id ?? field?.id}
      aria-describedby={classes(describedBy, field?.hintId, field?.errorId) || undefined}
      aria-invalid={invalid ?? field?.invalid}
      className={classes(special ? `ui-input-${type}` : 'ui-input', className)} />;
  }
);
Input.displayName = 'Input';

export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  (props, ref) => <Input {...props} ref={ref} type="checkbox" />
);
Checkbox.displayName = 'Checkbox';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, id, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }, ref) => {
    const field = useContext(FieldContext);
    return <select {...props} ref={ref} id={id ?? field?.id}
      aria-describedby={classes(describedBy, field?.hintId, field?.errorId) || undefined}
      aria-invalid={invalid ?? field?.invalid}
      className={classes('ui-select', className)} />;
  }
);
Select.displayName = 'Select';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, id, 'aria-describedby': describedBy, 'aria-invalid': invalid, ...props }, ref) => {
    const field = useContext(FieldContext);
    return <textarea {...props} ref={ref} id={id ?? field?.id}
      aria-describedby={classes(describedBy, field?.hintId, field?.errorId) || undefined}
      aria-invalid={invalid ?? field?.invalid}
      className={classes('ui-textarea', className)} />;
  }
);
Textarea.displayName = 'Textarea';

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; id?: string }) {
  const generated = useId();
  const fieldId = id ?? `field-${generated}`;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  return <FieldContext.Provider value={{ id: fieldId, hintId, errorId, invalid: errorId ? true : undefined }}>
    <div className={`field${errorId ? ' field-invalid' : ''}`}>
      <label className="field-label" htmlFor={fieldId}>{label}</label>
      {children}
      {hint ? <span className="field-hint" id={hintId}>{hint}</span> : null}
      {error ? <span className="field-error" id={errorId}>{error}</span> : null}
    </div>
  </FieldContext.Provider>;
}

export const SearchInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string }>(
  ({ label, className, ...props }, ref) => <div className={classes('ui-search', className)}>
    <Icon name="search" size={16} />
    <Input {...props} type="search" ref={ref} aria-label={label} />
  </div>
);
SearchInput.displayName = 'SearchInput';
