import { forwardRef, useState, type ChangeEvent } from 'react';
import { cn } from '../cn';

export interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called once all digits are filled (auto submit, doc 01 · 1.3). */
  onComplete?: (value: string) => void;
  length?: number;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  size?: 'md' | 'sm';
  'aria-label': string;
  id?: string;
}

/**
 * Six boxes that behave as one field: a single transparent input sits on top, so paste,
 * autofill (one-time-code) and backspace work natively.
 */
export const OtpInput = forwardRef<HTMLInputElement, OtpInputProps>(function OtpInput(
  {
    value,
    onChange,
    onComplete,
    length = 6,
    invalid,
    disabled,
    autoFocus,
    size = 'md',
    id,
    'aria-label': ariaLabel,
  },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const half = Math.ceil(length / 2);

  function handle(e: ChangeEvent<HTMLInputElement>) {
    const next = e.target.value.replace(/\D/g, '').slice(0, length);
    onChange(next);
    if (next.length === length && next !== value) onComplete?.(next);
  }

  const box =
    size === 'sm'
      ? 'h-[52px] w-11 rounded-[11px] text-[21px]'
      : 'h-[60px] w-[52px] rounded-lg text-2xl';

  return (
    <div className="relative inline-flex items-center gap-2">
      {Array.from({ length }, (_, i) => {
        const char = value[i];
        const active = focused && i === Math.min(value.length, length - 1);
        return (
          <span key={i} className="contents">
            {i === half ? <em className="h-0.5 w-2.5 shrink-0 rounded-[2px] bg-line2" /> : null}
            <span
              aria-hidden="true"
              className={cn(
                'flex items-center justify-center bg-bg2 font-mono leading-7 font-semibold text-fg',
                box,
                active && 'bg-surface shadow-[inset_0_0_0_1.5px_var(--fg)]',
                invalid && 'shadow-[inset_0_0_0_1.5px_var(--danger)]',
              )}
            >
              {char ??
                (active ? (
                  <i className="h-[26px] w-0.5 animate-pulse rounded-[2px] bg-fg" />
                ) : null)}
            </span>
          </span>
        );
      })}
      <input
        ref={ref}
        id={id}
        value={value}
        onChange={handle}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-[0.01] outline-none focus-visible:shadow-none"
      />
    </div>
  );
});
