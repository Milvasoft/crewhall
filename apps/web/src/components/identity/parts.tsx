import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  initials,
  Input,
  toast,
} from '@crewhall/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Small building blocks of the identity admin screens (9.11-9.14). */

export async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    // Clipboard blocked (http, permissions): the text stays selectable.
  }
}

/** Monospace value with a small copy button, inline. */
export function CopyValue({ value, className }: { value: string; className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate font-mono text-[13px] font-semibold select-all">{value}</span>
      <IconButton
        size="xs"
        tone="plain"
        aria-label={t('identity.common.copy')}
        onClick={() => void copyText(value, t('identity.common.copied'))}
      >
        <Icon name="copy" size={14} />
      </IconButton>
    </span>
  );
}

/** Monospace box with a copy button (client secret, callback URLs). */
export function CopyField({
  value,
  secret,
  label,
}: {
  value: string;
  secret?: boolean;
  label?: string;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(!secret);
  return (
    <div className="flex min-h-11 items-center gap-1 rounded-lg bg-bg2 py-1 pr-1 pl-3 font-mono text-[13px] leading-[19px]">
      <span className="min-w-0 flex-1 break-all select-all" aria-label={label}>
        {shown ? value : '•'.repeat(Math.min(32, value.length))}
      </span>
      {secret ? (
        <IconButton
          size="xs"
          tone="plain"
          aria-label={t(shown ? 'identity.common.hide' : 'identity.common.show')}
          onClick={() => setShown((v) => !v)}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={15} />
        </IconButton>
      ) : null}
      <IconButton
        size="xs"
        tone="plain"
        aria-label={t('identity.common.copy')}
        onClick={() => void copyText(value, t('identity.common.copied'))}
      >
        <Icon name="copy" size={15} />
      </IconButton>
    </div>
  );
}

/** App or provider mark: the logo when there is one, initials otherwise. */
export function AppMark({
  name,
  logoUrl,
  size = 36,
  className,
}: {
  name: string;
  logoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const { locale } = useI18n();
  const [broken, setBroken] = useState(false);
  return (
    <span
      style={{ width: size, height: size }}
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-bg2 text-[12.5px] font-bold text-fg',
        className,
      )}
    >
      {logoUrl && !broken ? (
        <img
          src={logoUrl}
          alt=""
          className="size-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        initials(name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim() || name, 2, locale)
      )}
    </span>
  );
}

/** Label / value row inside cards (9.14 integration cards, provider header). */
export function InfoRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-t border-line py-1.5 text-cap first:border-t-0">
      <span className="shrink-0 text-fg2">{label}</span>
      <span className="min-w-0 truncate text-right font-semibold">{children}</span>
    </div>
  );
}

/** Editable list of strings (redirect URIs, domains) with per-entry validation. */
export function ListEditor({
  values,
  onChange,
  placeholder,
  addLabel,
  validate,
  mono = true,
  normalize = (v) => v.trim(),
  inputLabel,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  addLabel: string;
  /** Message when the value is refused, null when it is fine. */
  validate?: (v: string) => string | null;
  mono?: boolean;
  normalize?: (v: string) => string;
  inputLabel: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const value = normalize(draft);
  const problem = value ? (validate?.(value) ?? null) : null;
  const duplicate = values.includes(value);

  function add(e?: FormEvent) {
    e?.preventDefault();
    if (!value || problem || duplicate) return;
    onChange([...values, value]);
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-1.5">
      {values.map((v) => (
        <div
          key={v}
          className="flex min-h-10 items-center gap-2 rounded-lg bg-bg2 py-1 pr-1 pl-3 text-[13px]"
        >
          <span className={cn('min-w-0 flex-1 break-all', mono && 'font-mono')}>{v}</span>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('identity.common.removeItem', { name: v })}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            <Icon name="x" size={14} />
          </IconButton>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input
          aria-label={inputLabel}
          value={draft}
          placeholder={placeholder}
          invalid={Boolean(problem)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add(e);
          }}
          className={mono ? 'font-mono text-[13px]' : undefined}
          containerClassName="h-10 flex-1 rounded-lg"
        />
        <Button
          size="sm"
          variant="out"
          disabled={!value || Boolean(problem) || duplicate}
          onClick={() => add()}
        >
          <Icon name="plus" size={14} />
          {addLabel}
        </Button>
      </div>
      {problem ? <span className="text-xs text-danger">{problem}</span> : null}
    </div>
  );
}

/** Yes/no dialog for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
  pending,
  danger = true,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  body: ReactNode;
  confirm: ReactNode;
  onConfirm: () => void;
  pending?: boolean;
  danger?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader icon="alert" title={title} description={body} />
        <DialogFooter>
          <Button variant="gh" onClick={() => onOpenChange(false)}>
            {t('common.actions.cancel')}
          </Button>
          <Button variant={danger ? 'dngf' : 'inv'} loading={pending} onClick={onConfirm}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings toggle row used inside dialogs and cards. */
export function ToggleRow({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-2.5 first:border-t-0">
      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
        <span className="text-cap font-semibold">{label}</span>
        {hint ? <span className="text-xs text-fg2">{hint}</span> : null}
      </label>
      {children}
    </div>
  );
}
