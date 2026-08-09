/**
 * Form controls, built for thumbs rather than cursors.
 *
 * Two decisions worth calling out:
 *
 * - **Radio groups are replaced by large toggle buttons.** A native radio's hit area is
 *   about 20px. On a cracked 5-inch screen held by someone walking between houses, that is
 *   not a usable target. `ChoiceGroup` renders 56px-tall buttons with `aria-pressed`, which
 *   keeps the semantics for screen readers while being tappable in reality.
 *
 * - **Numeric fields use `inputMode="decimal"`, not `type="number"`.** `type="number"`
 *   brings spinner arrows, swallows keystrokes on some Android keyboards, and silently
 *   clears itself on invalid input — losing a reading the worker just measured.
 *   `inputMode` shows the numeric keypad without any of that.
 */

import type { ReactNode } from 'react';
import { useId } from 'react';
import { VoiceInputButton, type VoiceInputButtonProps } from '@/components/VoiceInputButton';

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
}

/** Wraps a control with its label, hint and error, wired up for screen readers. */
export function Field({ label, hint, error, required = false, children }: FieldProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={inputId}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      {children({ inputId, describedBy })}

      {error ? (
        <p className="field__error" id={errorId} role="alert">
          <span aria-hidden="true">{'\u26a0'}</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  type?: 'text' | 'tel' | 'password';
  maxLength?: number;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  placeholder,
  autoComplete,
  type = 'text',
  maxLength,
}: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {({ inputId, describedBy }) => (
        <input
          id={inputId}
          className="input"
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          maxLength={maxLength}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={describedBy}
          {...(type === 'tel' ? { inputMode: 'numeric' as const } : {})}
        />
      )}
    </Field>
  );
}

export interface NumberFieldProps {
  label: string;
  /** Held as a string so a half-typed "16" is never coerced or cleared. */
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  unit?: string;
  placeholder?: string;
  allowDecimal?: boolean;
  /** Omit to hide the microphone for this field. */
  voicePromptKey?: VoiceInputButtonProps['promptKey'];
  onVoiceUsed?: () => void;
}

/**
 * Numeric entry with an optional microphone.
 *
 * The unit is rendered as an adjacent, non-editable suffix rather than inside the
 * placeholder, so it stays visible while typing. A worker should never have to remember
 * whether the box wanted cm or inches.
 */
export function NumberField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  unit,
  placeholder,
  allowDecimal = false,
  voicePromptKey,
  onVoiceUsed,
}: NumberFieldProps) {
  const sanitise = (raw: string) => {
    const cleaned = allowDecimal ? raw.replace(/[^\d.]/g, '') : raw.replace(/[^\d]/g, '');
    // Keep only the first decimal point: "62.5.3" is not a weight.
    if (!allowDecimal) return cleaned;
    const [whole, ...rest] = cleaned.split('.');
    return rest.length > 0 ? `${whole}.${rest.join('')}` : whole;
  };

  return (
    <Field label={label} hint={hint} error={error} required={required}>
      {({ inputId, describedBy }) => (
        <div className="input-with-voice">
          <div className="input-group grow">
            <input
              id={inputId}
              className="input input--numeric"
              type="text"
              inputMode={allowDecimal ? 'decimal' : 'numeric'}
              value={value}
              onChange={(event) => onChange(sanitise(event.target.value))}
              placeholder={placeholder}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={describedBy}
              autoComplete="off"
            />
            {unit ? (
              <span className="unit-suffix" aria-hidden="true">
                {unit}
              </span>
            ) : null}
          </div>

          {voicePromptKey ? (
            <VoiceInputButton
              fieldLabel={label}
              promptKey={voicePromptKey}
              allowDecimal={allowDecimal}
              onValue={(parsed) => {
                onChange(String(parsed));
                onVoiceUsed?.();
              }}
            />
          ) : null}
        </div>
      )}
    </Field>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
}

export interface ChoiceGroupProps<T extends string> {
  label: string;
  options: ChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Full-width rows instead of side-by-side; better for long option text. */
  stacked?: boolean;
}

export function ChoiceGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  hint,
  error,
  required,
  stacked = false,
}: ChoiceGroupProps<T>) {
  const groupId = useId();
  const hintId = `${groupId}-hint`;
  const errorId = `${groupId}-error`;

  return (
    <div
      className="field"
      role="group"
      aria-labelledby={`${groupId}-label`}
      aria-describedby={[hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined}
    >
      <span className="field__label" id={`${groupId}-label`}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </span>

      {hint ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      <div className="choice-group">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`choice${stacked ? ' choice--stacked' : ''}`}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <span aria-hidden="true">{option.icon}</span> : null}
            <span>{option.label}</span>
          </button>
        ))}
      </div>

      {error ? (
        <p className="field__error" id={errorId} role="alert">
          <span aria-hidden="true">{'\u26a0'}</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  maxLength = 500,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <Field label={label} hint={hint}>
      {({ inputId, describedBy }) => (
        <textarea
          id={inputId}
          className="textarea"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          aria-describedby={describedBy}
        />
      )}
    </Field>
  );
}
