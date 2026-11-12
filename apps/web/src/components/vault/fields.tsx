import { formatTotp, parseTotp, totpAt, totpForCopy } from '@crewhall/crypto';
import { cn, Icon, IconButton, toast, Tooltip, type IconName } from '@crewhall/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { reportAccess } from '@/lib/vault/api';
import { clearClipboard, copySecret, dismissCopyToast, useCopyState } from '@/lib/vault/clipboard';
import { currentSettings } from '@/lib/vault/session';

/**
 * Field widgets for the item detail (design 8.4-8.6). Values render as React text only, never
 * as HTML (doc 17 §7: "Kasa ekranlarında ham HTML gösterilmez").
 */

export interface AccessRef {
  vaultId: string;
  itemId: string;
}

/** Copies, reports "kopyaladı · <field>", shows the toast (design 8.6). */
export function useCopy() {
  const { t } = useI18n();
  return async (
    value: string | (() => string),
    labelKey: MessageKey,
    ref?: AccessRef,
    field?: string,
  ) => {
    try {
      await copySecret(
        typeof value === 'function' ? value() : value,
        t(labelKey),
        currentSettings().clipboardSeconds,
      );
    } catch {
      toast(t('vault.copyFailed'));
      return false;
    }
    if (ref && field) reportAccess({ ...ref, action: 'copy', field });
    return true;
  };
}

export function CopyButton({
  value,
  labelKey,
  access,
  field,
  size = 'sm',
}: {
  /** A function is called only on click (list rows decrypt the secret just then). */
  value: string | (() => string);
  labelKey: MessageKey;
  access?: AccessRef;
  field?: string;
  size?: 'sm' | 'xs';
}) {
  const { t } = useI18n();
  const copy = useCopy();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const id = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(id);
  }, [done]);
  return (
    <Tooltip content={t('vault.copy')}>
      <IconButton
        aria-label={`${t('vault.copy')}: ${t(labelKey)}`}
        tone="plain"
        shape="sq"
        size={size}
        onClick={(e) => {
          e.stopPropagation();
          void copy(value, labelKey, access, field).then((ok) => ok && setDone(true));
        }}
      >
        <Icon
          name={done ? 'check' : 'copy'}
          size={16}
          className={done ? 'text-success' : undefined}
        />
      </IconButton>
    </Tooltip>
  );
}

export function FieldRow({
  label,
  children,
  actions,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('group flex min-h-[58px] items-center gap-3 px-4 py-2.5', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-fg3">{label}</span>
        <div className="min-w-0 text-[14.5px] leading-5 break-words text-fg">{children}</div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-0.5">{actions}</div> : null}
    </div>
  );
}

export function FieldGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col divide-y divide-line rounded-xl bg-bg2/60 shadow-line',
        className,
      )}
    >
      {children}
    </div>
  );
}

const DOTS = '••••••••••••••••';

/**
 * Hidden value with "Göster · 30 sn" (design 8.4-8.5): shown for the configured seconds, then
 * hidden again; each reveal is reported to the access log with the field name.
 */
export function SecretRow({
  label,
  value,
  field,
  access,
  copyKey,
  mono = true,
  extra,
  below,
}: {
  label: ReactNode;
  value: string;
  field: string;
  access: AccessRef;
  copyKey: MessageKey;
  mono?: boolean;
  extra?: ReactNode;
  below?: ReactNode;
}) {
  const { t } = useI18n();
  const [until, setUntil] = useState<number | null>(null);
  const now = useNow(until ? 1000 : undefined);
  const left = until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
  const shown = until !== null && left > 0;
  if (!value) return null;
  const seconds = currentSettings().revealSeconds;
  return (
    <FieldRow
      label={label}
      actions={
        <>
          {extra}
          <Tooltip content={shown ? t('vault.hide') : t('vault.showFor', { seconds })}>
            <IconButton
              aria-label={shown ? t('vault.hide') : t('vault.show')}
              aria-pressed={shown}
              tone="plain"
              shape="sq"
              size="sm"
              onClick={() => {
                if (shown) setUntil(null);
                else {
                  setUntil(Date.now() + seconds * 1000);
                  reportAccess({ ...access, action: 'reveal', field });
                }
              }}
            >
              <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
            </IconButton>
          </Tooltip>
          <CopyButton value={value} labelKey={copyKey} access={access} field={field} />
        </>
      }
    >
      <span className={cn(mono && 'font-mono text-[14px]', 'whitespace-pre-wrap')}>
        {shown ? value : DOTS}
      </span>
      {shown ? (
        <span className="mt-0.5 block text-xs text-fg3 tn">
          {t('vault.hidesIn', { seconds: left })}
        </span>
      ) : null}
      {below}
    </FieldRow>
  );
}

export function TextRow({
  label,
  value,
  copyKey,
  access,
  field,
  mono,
  actions,
}: {
  label: ReactNode;
  value: string;
  copyKey?: MessageKey;
  access?: AccessRef;
  field?: string;
  mono?: boolean;
  actions?: ReactNode;
}) {
  if (!value) return null;
  return (
    <FieldRow
      label={label}
      actions={
        <>
          {actions}
          {copyKey ? (
            <CopyButton value={value} labelKey={copyKey} access={access} field={field} />
          ) : null}
        </>
      }
    >
      <span className={cn(mono && 'font-mono text-[14px]', 'whitespace-pre-wrap')}>{value}</span>
    </FieldRow>
  );
}

/** TOTP code with the 30 s ring; warning colour for the last 5 seconds (design 8.5-8.6). */
export function TotpRow({
  secret,
  access,
  label,
}: {
  secret: string;
  access: AccessRef;
  /** Custom-field TOTP keeps its own label (roadmap 20). */
  label?: string;
}) {
  const { t } = useI18n();
  const cfg = useMemo(() => parseTotp(secret), [secret]);
  const now = useNow(1000);
  const copy = useCopy();
  if (!cfg) {
    return (
      <FieldRow label={label ?? t('vault.field.totp')}>
        <span className="text-sm text-danger">{t('vault.totpInvalid')}</span>
      </FieldRow>
    );
  }
  const { code, remaining, period } = totpAt(cfg, now);
  const warn = remaining <= 5;
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <FieldRow
      label={label ?? t('vault.field.totp')}
      actions={
        <Tooltip content={t('vault.copy')}>
          <IconButton
            aria-label={`${t('vault.copy')}: ${t('vault.field.totp')}`}
            tone="plain"
            shape="sq"
            size="sm"
            onClick={() =>
              void copy(totpForCopy(cfg, Date.now()), 'vault.field.totp', access, 'totp')
            }
          >
            <Icon name="copy" size={16} />
          </IconButton>
        </Tooltip>
      }
    >
      <span className="flex items-center gap-2.5">
        <span
          className={cn(
            'font-mono text-[18px] font-semibold tracking-wider tn',
            warn && 'text-warning',
          )}
        >
          {formatTotp(code)}
        </span>
        <span
          className="relative flex size-6 items-center justify-center"
          aria-label={t('vault.totpRemaining', { seconds: remaining })}
        >
          <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90">
            <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.5" className="stroke-line2" />
            <circle
              cx="12"
              cy="12"
              r={r}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c * (1 - remaining / period)}
              className={warn ? 'stroke-warning' : 'stroke-accent'}
            />
          </svg>
          <span className="text-[9.5px] font-bold text-fg2 tn">{remaining}</span>
        </span>
      </span>
    </FieldRow>
  );
}

/** Bottom toast after a copy: "Panodan 30 sn sonra silinecek · Şimdi temizle" (design 8.6). */
export function CopyToast() {
  const { t } = useI18n();
  const s = useCopyState();
  const now = useNow(s.label ? 1000 : undefined);
  useEffect(() => {
    if (!s.label) return;
    const id = setTimeout(dismissCopyToast, 6000);
    return () => clearTimeout(id);
  }, [s.label]);
  if (!s.label || !s.clearsAt) return null;
  const left = Math.max(0, Math.ceil((s.clearsAt - now) / 1000));
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full bg-fg py-2 pr-2 pl-4 text-sm text-bg shadow-overlay keyboard:hidden"
    >
      <Icon name="checkC" size={16} className="text-success" />
      <span className="font-semibold">{t('vault.copied', { what: s.label })}</span>
      <span className="opacity-70 tn">{t('vault.clipboardClears', { seconds: left })}</span>
      <button
        type="button"
        onClick={() => void clearClipboard()}
        className="rounded-full bg-bg/15 px-3 py-1 text-[12.5px] font-semibold hover:bg-bg/25"
      >
        {t('vault.clearNow')}
      </button>
    </div>
  );
}

export function SectionTitle({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="eyebrow mt-2 flex items-center gap-1.5 px-1">
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}
