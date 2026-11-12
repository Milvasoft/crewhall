import { cn, Icon } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { parseRecipient, sameAddress, type Recipient } from '@/lib/mail/compose';
import { mailRecipientsQuery } from '@/lib/mail/queries';

/**
 * To / Cc / Bcc field: chips plus a text box. Enter, comma, semicolon or leaving the box turns
 * the typed text into a chip; suggestions come from recent recipients and the org directory.
 */
export function RecipientInput({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: Recipient[];
  onChange: (next: Recipient[]) => void;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(text.trim()), 200);
    return () => clearTimeout(timer);
  }, [text]);
  const suggestions = useQuery({
    ...mailRecipientsQuery(debounced),
    enabled: focused && debounced.length > 0,
  });
  const options = (suggestions.data?.items ?? []).filter(
    (s) => !value.some((v) => sameAddress(v.address, s.address)),
  );
  const open = focused && debounced.length > 0 && options.length > 0;

  const add = (r: Recipient) => {
    if (!value.some((v) => sameAddress(v.address, r.address))) onChange([...value, r]);
    setText('');
    setInvalid(null);
  };
  const commit = () => {
    const raw = text.trim();
    if (!raw) return true;
    const parts = raw
      .split(/[,;]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    const parsed = parts.map(parseRecipient);
    const bad = parts.find((_, i) => !parsed[i]);
    if (bad) {
      setInvalid(bad);
      return false;
    }
    const next = [...value];
    for (const r of parsed) {
      if (r && !next.some((v) => sameAddress(v.address, r.address))) next.push(r);
    }
    onChange(next);
    setText('');
    setInvalid(null);
    return true;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (open && e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (
      e.key === 'Enter' ||
      e.key === ',' ||
      e.key === ';' ||
      (e.key === 'Tab' && text.trim())
    ) {
      if (e.key !== 'Tab' || text.trim()) e.preventDefault();
      const pick = open ? options[active] : undefined;
      if (pick) add({ name: pick.name, address: pick.address });
      else commit();
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="relative flex min-w-0 flex-col">
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 border-b border-line py-1.5">
        <label htmlFor={id} className="w-14 shrink-0 text-sm text-fg2">
          {label}
        </label>
        {value.map((r) => (
          <span
            key={r.address}
            title={r.address}
            className="flex max-w-full items-center gap-1 rounded-full bg-bg2 py-0.5 pr-1 pl-2.5 text-[13px]"
          >
            <span className="truncate">{r.name || r.address}</span>
            <button
              type="button"
              aria-label={t('mail.compose.removeRecipient', { email: r.address })}
              className="flex size-5 items-center justify-center rounded-full text-fg3 hover:bg-capsule hover:text-fg"
              onClick={() => onChange(value.filter((v) => v !== r))}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-invalid={invalid ? true : undefined}
          autoFocus={autoFocus}
          autoComplete="off"
          placeholder={value.length ? undefined : t('mail.compose.recipientHint')}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setInvalid(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
          className="min-w-[160px] flex-1 bg-transparent text-sm outline-none placeholder:text-fg3"
        />
      </div>
      {invalid ? (
        <span role="alert" className="pt-1 text-xs text-danger">
          {t('mail.compose.invalidAddress', { value: invalid })}
        </span>
      ) : null}
      {open ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={t('mail.compose.suggestions')}
          className="absolute top-full right-0 left-14 z-50 m-0 mt-1 flex max-h-64 list-none flex-col overflow-y-auto rounded-lg bg-surface p-1 shadow-overlay"
        >
          {options.map((o, i) => (
            <li
              key={o.address}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                add({ name: o.name, address: o.address });
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm',
                i === active && 'bg-bg2',
              )}
            >
              <span className="min-w-0 flex-1 truncate">
                {o.name ? <b className="font-semibold">{o.name}</b> : null}
                <span className={cn('text-fg2', o.name && 'ml-1.5')}>{o.address}</span>
              </span>
              <span className="shrink-0 text-xs text-fg3">
                {t(`mail.compose.source.${o.source}`)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
