import { Button, cn, Icon } from '@crewhall/ui';
import { type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Settings card with a title and label/control rows (doc 09 · 9.1 layout). */
export function SettingsCard({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex flex-col rounded-2xl bg-surface px-5 pt-3.5 pb-1.5 shadow-line',
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-3 pb-1.5">
          <h2 className="m-0 text-sm font-semibold">{title}</h2>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  htmlFor,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
}) {
  return (
    // The text column takes the room and wraps; the control stays on the right, centred. Only on
    // a phone may the control drop below the text.
    <div
      data-settings-row=""
      className="flex min-h-[60px] items-center justify-between gap-x-4 gap-y-2 border-t border-line py-2.5 first:border-t-0 max-md:flex-wrap"
    >
      <div data-settings-text="" className="flex min-w-0 flex-1 flex-col">
        <label htmlFor={htmlFor} className="text-cap font-semibold text-fg">
          {label}
        </label>
        {description ? <span className="text-xs text-fg2">{description}</span> : null}
      </div>
      <div
        data-settings-control=""
        className="flex shrink-0 items-center gap-2 max-md:max-w-full max-md:flex-wrap"
      >
        {children}
      </div>
    </div>
  );
}

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
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col">
        <h1 className="m-0 text-wtitle font-bold">{title}</h1>
        {subtitle ? (
          <span className="text-[13.5px] leading-[18px] text-fg2">{subtitle}</span>
        ) : null}
      </div>
      {actions ? (
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** Floating save bar for batched org settings (doc 09 · 9.1). */
export function SaveBar({
  count,
  onCancel,
  onSave,
  saving,
}: {
  count: number;
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
}) {
  const { t } = useI18n();
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label={t('admin.unsaved', { count })}
      className="pointer-events-auto absolute bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-glass-line bg-glass py-1.5 pr-1.5 pl-4 shadow-overlay backdrop-blur-[24px] keyboard:hidden"
    >
      <Icon name="edit" size={16} className="text-fg2" />
      <span className="text-cap font-semibold whitespace-nowrap">
        {t('admin.unsaved', { count })}
      </span>
      <span className="mx-1 h-[22px] w-px bg-line2" />
      <Button variant="gh" size="sm" onClick={onCancel}>
        {t('common.actions.cancel')}
      </Button>
      <Button variant="pri" size="sm" loading={saving} onClick={onSave}>
        {t('common.actions.save')}
      </Button>
    </div>
  );
}
