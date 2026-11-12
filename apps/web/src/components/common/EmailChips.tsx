import { cn, Icon } from '@crewhall/ui';
import { useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { z } from 'zod';
import { useI18n } from '@/lib/i18n/I18nContext';

const Email = z.email();

export function isEmail(v: string): boolean {
  return Email.safeParse(v).success;
}

/**
 * Pasted or typed addresses become chips (comma, space or newline separate them).
 * Addresses outside `orgDomains` get a warning border: they are invited as guests.
 */
export function EmailChips({
  value,
  onChange,
  orgDomains = [],
  id,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  orgDomains?: string[];
  id?: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  function add(raw: string) {
    const parts = raw
      .split(/[\s,;]+/)
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return;
    onChange(Array.from(new Set([...value, ...parts])));
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (['Enter', ',', ' ', 'Tab'].includes(e.key) && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    add(e.clipboardData.getData('text'));
  }

  const outside = (email: string) =>
    orgDomains.length > 0 && !orgDomains.some((d) => email.endsWith(`@${d}`));

  return (
    <div className="flex min-h-[88px] flex-wrap content-start items-center gap-1.5 rounded-lg bg-bg2 p-2.5 focus-within:bg-surface focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]">
      {value.map((email) => {
        const bad = !isEmail(email);
        return (
          <span
            key={email}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-sm bg-surface pr-1.5 pl-2.5 text-cap font-medium text-fg shadow-line2',
              (bad || outside(email)) && 'shadow-[inset_0_0_0_1.5px_var(--warning)]',
              bad && 'shadow-[inset_0_0_0_1.5px_var(--danger)]',
            )}
          >
            {email}
            <button
              type="button"
              aria-label={t('common.actions.delete')}
              onClick={() => onChange(value.filter((v) => v !== email))}
              className="text-fg3 hover:text-fg"
            >
              <Icon name="x" size={13} />
            </button>
          </span>
        );
      })}
      <input
        id={id}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          if (/[\s,;]/.test(v)) add(v);
          else setDraft(v);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => add(draft)}
        placeholder={value.length ? t('invite.addMore') : t('invite.placeholder')}
        className="h-7 min-w-[160px] flex-1 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg3 focus-visible:shadow-none"
      />
    </div>
  );
}

export function guestAddresses(emails: string[], orgDomains: string[]): string[] {
  if (!orgDomains.length) return [];
  return emails.filter((e) => isEmail(e) && !orgDomains.some((d) => e.endsWith(`@${d}`)));
}
