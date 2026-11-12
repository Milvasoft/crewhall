import { type PortalItemStatus, type PortalPostStatus, type UserSummary } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Tooltip,
} from '@crewhall/ui';
import { type ReactNode, useState } from 'react';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { type SaveState } from '@/lib/portal/autosave';
import { localeTag } from '@/lib/portal/format';

/** Small building blocks shared by the portal screens (design 10). */

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="m-0 truncate text-wtitle font-bold">{title}</h1>
        {subtitle ? <p className="text-sm text-fg2">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  aside,
  children,
  className,
  bodyClassName,
  'aria-label': ariaLabel,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  'aria-label'?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className={cn('flex min-w-0 flex-col rounded-2xl bg-surface shadow-line', className)}
    >
      {title || aside ? (
        <header className="flex min-h-12 items-center gap-2 px-5 pt-3.5 pb-2">
          {title ? <h2 className="m-0 flex-1 truncate text-sub font-semibold">{title}</h2> : null}
          {aside}
        </header>
      ) : null}
      <div
        className={cn('flex min-w-0 flex-col px-5 pb-4', !title && !aside && 'pt-4', bodyClassName)}
      >
        {children}
      </div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  hint,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-2xl bg-surface px-5 py-4 shadow-line">
      <span className="truncate text-cap text-fg2">{label}</span>
      <span className="text-num font-bold tn">{value}</span>
      {hint ? <span className="truncate text-xs text-fg2">{hint}</span> : null}
    </div>
  );
}

type AnyStatus = PortalItemStatus | PortalPostStatus;

const STATUS_TONE: Record<AnyStatus, 'default' | 'ok' | 'warn' | 'danger' | 'info'> = {
  draft: 'default',
  published: 'ok',
  changed: 'warn',
  removed: 'danger',
  scheduled: 'info',
};

export function StatusChip({ status, children }: { status: AnyStatus; children?: ReactNode }) {
  const { t } = useI18n();
  return <Badge tone={STATUS_TONE[status]}>{children ?? t(`portal.status.${status}`)}</Badge>;
}

/** Tree dot (10.2): yellow = unpublished change, gray = never published. */
export function ChangeDot({ status }: { status: PortalItemStatus | null }) {
  const { t } = useI18n();
  if (status !== 'changed' && status !== 'draft') return null;
  return (
    <span
      role="img"
      aria-label={t(`portal.status.${status}`)}
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        status === 'changed' ? 'bg-accent' : 'bg-fg3',
      )}
    />
  );
}

export function LocaleTag({ code, missing }: { code: string; missing?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-bg2 px-1.5 text-[10.5px] font-bold tracking-wide text-fg2',
        missing && 'text-fg3 line-through opacity-70',
      )}
    >
      {localeTag(code)}
    </span>
  );
}

export function Person({ user, size = 'sm' }: { user: UserSummary | null; size?: 'sm' | 'md' }) {
  if (!user) return null;
  return (
    <Tooltip content={user.name}>
      <span className="inline-flex">
        <Avatar name={user.name} src={user.imageUrl} size={size} />
      </span>
    </Tooltip>
  );
}

/** "bugün 09:38", "dün 17:05", "16 Eki", "16 Eki 2025". */
export function useWhen() {
  const { t, locale } = useI18n();
  return (iso: string | null | undefined, withYear = false): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const nowD = new Date();
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(nowD) - day(d)) / 86_400_000);
    const time = formatTime(d, locale);
    if (diff === 0) return t('portal.common.todayAt', { time });
    if (diff === 1) return t('portal.common.yesterdayAt', { time });
    if (diff === -1) return t('portal.common.tomorrowAt', { time });
    const sameYear = d.getFullYear() === nowD.getFullYear();
    return formatDate(
      d,
      locale,
      sameYear && !withYear
        ? { day: 'numeric', month: 'short' }
        : { day: 'numeric', month: 'short', year: 'numeric' },
    );
  };
}

/** "2,8 sn", "48 sn", "1 dk 48 sn". */
export function useDuration() {
  const { t, locale } = useI18n();
  return (ms: number | null | undefined): string => {
    if (ms === null || ms === undefined) return '';
    if (ms < 60_000) {
      const value = new Intl.NumberFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
        maximumFractionDigits: ms < 10_000 ? 1 : 0,
      }).format(ms / 1000);
      return t('portal.common.seconds', { value });
    }
    return t('portal.common.minutesSeconds', {
      min: Math.floor(ms / 60_000),
      seconds: Math.round((ms % 60_000) / 1000),
    });
  };
}

export function SaveStatus({ state, savedAt }: { state: SaveState; savedAt: Date | null }) {
  const { t, locale } = useI18n();
  const text =
    state === 'saving' || state === 'pending'
      ? t('portal.common.saving')
      : state === 'error'
        ? t('portal.common.saveFailed')
        : state === 'conflict'
          ? t('portal.common.conflictShort')
          : savedAt
            ? t('portal.common.savedAt', { time: formatTime(savedAt, locale) })
            : null;
  if (!text) return null;
  return (
    <span
      role="status"
      title={text}
      className={cn(
        'flex items-center text-xs whitespace-nowrap text-fg2',
        (state === 'error' || state === 'conflict') && 'text-danger',
      )}
    >
      {/* Phone: an icon in place of the words. */}
      <Icon
        name={state === 'error' || state === 'conflict' ? 'alert' : 'cloud'}
        size={14}
        className="md:hidden"
      />
      <span className="max-md:sr-only">{text}</span>
    </span>
  );
}

/** "38 / 160" with a yellow hint past the recommended length (never blocking). */
export function Counter({
  value,
  max,
  min,
}: {
  value: string | null | undefined;
  max: number;
  min?: number;
}) {
  const n = (value ?? '').length;
  const warn = n > max || (min !== undefined && n > 0 && n < min);
  return (
    <span className={cn('text-xs text-fg3 tn', warn && 'text-warning')}>{`${n} / ${max}`}</span>
  );
}

/** Input with fixed leading text (slug prefix "…/milvaion/"). */
export function PrefixedInput({
  prefix,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { prefix: ReactNode }) {
  return (
    <div
      className={cn(
        'flex h-9 min-w-0 items-center rounded-md bg-bg2 pr-3 pl-3 text-[13.5px] focus-within:bg-surface focus-within:shadow-[inset_0_0_0_1.5px_var(--fg)]',
        className,
      )}
    >
      <span className="shrink-0 truncate text-fg3">{prefix}</span>
      <input
        {...props}
        className="h-full min-w-0 flex-1 bg-transparent font-medium text-fg outline-none"
      />
    </div>
  );
}

/** Small input used in dense forms (front matter, side panels). */
export const smallInput =
  'h-9 w-full min-w-0 rounded-md bg-bg2 px-3 text-[13.5px] text-fg outline-none placeholder:text-fg3 focus:bg-surface focus:shadow-[inset_0_0_0_1.5px_var(--fg)]';

export function FieldRow({
  label,
  aside,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-fg2">
          {label}
        </label>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirm,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirm: ReactNode;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader title={title} description={description} />
        <DialogFooter>
          <Button variant="gh" size="sm" onClick={() => onOpenChange(false)}>
            {t('portal.common.cancel')}
          </Button>
          <Button
            size="sm"
            variant={danger ? 'dngf' : 'inv'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Per-language text inputs share one draft; empty falls back to the default language. */
export function localized(
  value: Record<string, string> | undefined,
  locale: string,
  fallback: string,
): string {
  return value?.[locale] || value?.[fallback] || '';
}
