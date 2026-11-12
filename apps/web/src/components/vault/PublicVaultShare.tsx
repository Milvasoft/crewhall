import {
  decryptShare,
  formatTotp,
  parseTotp,
  shareKeyFromFragment,
  totpAt,
  totpForCopy,
  totpSourceOf,
  wipe,
  type ItemPayload,
} from '@crewhall/crypto';
import { Button, cn, CrewhallMark, Icon, IconButton, Spinner, Tooltip } from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { LanguageMenu } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { formatDateLong, formatTime } from '@/lib/i18n/format';
import { useI18n, type MessageKey } from '@/lib/i18n/I18nContext';
import { useBootstrap } from '@/lib/useBranding';
import { useNow } from '@/lib/useNow';
import { copySecret } from '@/lib/vault/clipboard';
import { CopyToast } from './fields';

/**
 * Public page of a one-time vault link (roadmap 20), for someone without an account. The key
 * is in the URL fragment, which the browser never sends; the page fetches the ciphertext only
 * when the person presses "Show" (so link previews in chat apps do not use the link up) and
 * decrypts it here. The content lives in this tab's memory only.
 */
export function PublicVaultSharePage({ token }: { token: string }) {
  const { t, locale } = useI18n();
  // Read once: the fragment is removed from the address bar after a successful open.
  const [key] = useState(() => shareKeyFromFragment(window.location.hash));
  const [payload, setPayload] = useState<ItemPayload | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const info = useQuery({
    queryKey: ['vault', 'publicShare', token],
    queryFn: () => api.call('vaultPublicShare', { params: { token } }),
    enabled: key !== null,
    retry: false,
  });
  const open = useMutation({
    mutationFn: () => api.call('vaultOpenShare', { params: { token } }),
    onSuccess: (r) => {
      if (!key) return;
      try {
        setPayload(decryptShare(key, r));
      } finally {
        wipe(key);
      }
      setLeft(r.viewsLeft);
      window.history.replaceState(null, '', window.location.pathname);
    },
  });

  let body: ReactNode;
  if (!key) {
    body = (
      <State
        icon="alert"
        title={t('vault.publicShare.noKey')}
        text={t('vault.publicShare.noKeyBody')}
      />
    );
  } else if (payload) {
    body = <Content p={payload} viewsLeft={left ?? 0} />;
  } else if (info.isPending) {
    body = <Spinner className="m-auto" />;
  } else if (info.error || open.error) {
    const err = info.error ?? open.error;
    const disabled = isApiError(err, 'vault_share_disabled') || isApiError(err, 'module_disabled');
    body = (
      <State
        icon="clock"
        title={t(disabled ? 'vault.publicShare.disabled' : 'vault.publicShare.gone')}
        text={t('vault.publicShare.goneBody')}
      />
    );
  } else if (open.isSuccess) {
    // Opened but the key did not fit: the link was altered.
    body = (
      <State
        icon="alert"
        title={t('vault.publicShare.badKey')}
        text={t('vault.publicShare.noKeyBody')}
      />
    );
  } else {
    body = (
      <div className="m-auto flex w-full max-w-[420px] flex-col items-center gap-4 text-center">
        <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2">
          <Icon name="lock" size={24} />
        </span>
        <h1 className="text-h font-semibold">{t('vault.publicShare.title')}</h1>
        <p className="text-sm text-fg2">
          {t('vault.publicShare.limits', {
            views: info.data!.viewsLeft,
            date: `${formatDateLong(info.data!.expiresAt, locale)} ${formatTime(info.data!.expiresAt, locale)}`,
          })}
        </p>
        <Button loading={open.isPending} onClick={() => open.mutate()}>
          <Icon name="eye" size={16} />
          {t('vault.publicShare.show')}
        </Button>
        <p className="text-xs text-fg3">{t('vault.publicShare.zeroKnowledge')}</p>
      </div>
    );
  }

  return <Frame>{body}</Frame>;
}

function Frame({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { branding } = useBootstrap();
  const logo = branding.logoLightUrl ?? branding.logoDarkUrl;
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-6">
        {logo ? (
          <img src={logo} alt={branding.orgName} className="h-7 max-w-[160px] object-contain" />
        ) : (
          <span className="flex items-center gap-2 text-sm font-bold">
            <CrewhallMark size={24} />
            {branding.orgName}
          </span>
        )}
        <span className="ml-auto">
          <LanguageMenu />
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-4 py-6 sm:px-6">{children}</main>
      <footer className="shrink-0 px-6 pb-5 text-center text-xs text-fg3">
        {t('publicShare.footer', { year: new Date().getFullYear(), org: branding.orgName })}
      </footer>
    </div>
  );
}

function State({ icon, title, text }: { icon: 'alert' | 'clock'; title: string; text: string }) {
  return (
    <div className="m-auto flex w-full max-w-[420px] flex-col items-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-[14px] bg-bg2">
        <Icon name={icon} size={24} />
      </span>
      <h1 className="text-h font-semibold">{title}</h1>
      <p className="text-sm text-fg2">{text}</p>
    </div>
  );
}

interface Row {
  label: string;
  value: string;
  secret?: boolean;
  mono?: boolean;
}

/** Visible fields of a shared item, in the order the vault detail shows them. */
function rowsOf(p: ItemPayload, t: (k: MessageKey) => string): Row[] {
  const f = (k: string) => t(`vault.field.${k}` as MessageKey);
  const rows: Row[] = [];
  const add = (label: string, value: string, opts: Omit<Row, 'label' | 'value'> = {}) => {
    if (value) rows.push({ label, value, ...opts });
  };
  switch (p.type) {
    case 'login':
      add(f('username'), p.username);
      add(f('password'), p.password, { secret: true, mono: true });
      p.uris.forEach((u, i) => add(i === 0 ? f('uris') : '', u));
      break;
    case 'api_key':
      add(f('username'), p.username);
      add(f('key'), p.key, { secret: true, mono: true });
      add(f('url'), p.url);
      add(f('scope'), p.scope);
      add(f('expiresAt'), p.expiresAt ?? '');
      break;
    case 'card':
      add(f('cardholder'), p.cardholder);
      add(f('number'), p.number, { secret: true, mono: true });
      add(f('expiry'), p.expMonth && p.expYear ? `${p.expMonth}/${p.expYear}` : '');
      add(f('code'), p.code, { secret: true, mono: true });
      break;
    case 'ssh_key':
      add(f('host'), p.host);
      add(f('publicKey'), p.publicKey, { mono: true });
      add(f('privateKey'), p.privateKey, { secret: true, mono: true });
      add(f('passphrase'), p.passphrase, { secret: true });
      add(f('fingerprint'), p.fingerprint, { mono: true });
      break;
    case 'identity':
      add(f('fullName'), [p.firstName, p.middleName, p.lastName].filter(Boolean).join(' '));
      add(f('email'), p.email);
      add(f('phone'), p.phone);
      add(f('company'), p.company);
      add(f('username'), p.username);
      add(f('nationalId'), p.nationalId, { secret: true });
      add(f('passport'), p.passport, { secret: true });
      add(f('license'), p.license, { secret: true });
      add(
        f('address'),
        [p.address1, p.address2, p.address3, p.postalCode, p.city, p.state, p.country]
          .filter(Boolean)
          .join(', '),
      );
      break;
    case 'note':
      break;
  }
  const totp = totpSourceOf(p);
  for (const c of p.fields) {
    if (c.type === 'boolean' || (totp && c.value === totp)) continue;
    add(c.label || f('custom'), c.value, { secret: c.type === 'hidden' });
  }
  return rows;
}

function Content({ p, viewsLeft }: { p: ItemPayload; viewsLeft: number }) {
  const { t } = useI18n();
  const rows = useMemo(() => rowsOf(p, t), [p, t]);
  const totp = totpSourceOf(p);
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="eyebrow">{t(`vault.type.${p.type}`)}</span>
        <h1 className="text-h font-semibold break-words">{p.name}</h1>
      </div>
      <div className="flex flex-col divide-y divide-line rounded-xl bg-surface shadow-line">
        {rows.map((r, i) => (
          <ValueRow key={i} row={r} />
        ))}
        {totp ? <TotpLine secret={totp} /> : null}
      </div>
      {p.notes ? (
        <div className="flex flex-col gap-2">
          <span className="eyebrow">{t('vault.field.notes')}</span>
          {/* Plain text only, never HTML. */}
          <p className="rounded-xl bg-bg2/60 p-4 text-sm whitespace-pre-wrap shadow-line">
            {p.notes}
          </p>
        </div>
      ) : null}
      <p role="note" className="text-xs text-fg2">
        {viewsLeft > 0
          ? t('vault.publicShare.viewsLeft', { count: viewsLeft })
          : t('vault.publicShare.lastView')}
      </p>
      <CopyToast />
    </div>
  );
}

function useCopy() {
  const { t } = useI18n();
  return (value: string, label: string) =>
    copySecret(value, label || t('vault.field.custom'), 30).catch(() => undefined);
}

function ValueRow({ row }: { row: Row }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(!row.secret);
  const copy = useCopy();
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-fg3">{row.label}</span>
        <span className={cn('text-sm break-all whitespace-pre-wrap', row.mono && 'font-mono')}>
          {shown ? row.value : '••••••••••••'}
        </span>
      </span>
      {row.secret ? (
        <Tooltip content={shown ? t('vault.hide') : t('vault.show')}>
          <IconButton
            aria-label={`${shown ? t('vault.hide') : t('vault.show')}: ${row.label}`}
            tone="plain"
            shape="sq"
            size="sm"
            onClick={() => setShown((v) => !v)}
          >
            <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
          </IconButton>
        </Tooltip>
      ) : null}
      <Tooltip content={t('vault.copy')}>
        <IconButton
          aria-label={`${t('vault.copy')}: ${row.label}`}
          tone="plain"
          shape="sq"
          size="sm"
          onClick={() => void copy(row.value, row.label)}
        >
          <Icon name="copy" size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

function TotpLine({ secret }: { secret: string }) {
  const { t } = useI18n();
  const cfg = useMemo(() => parseTotp(secret), [secret]);
  const now = useNow(1000);
  const copy = useCopy();
  if (!cfg) return null;
  const { code, remaining } = totpAt(cfg, now);
  const label = t('vault.field.totp');
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-fg3">{label}</span>
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'font-mono text-[18px] font-semibold tracking-wider tn',
              remaining <= 5 && 'text-warning',
            )}
          >
            {formatTotp(code)}
          </span>
          <span className="text-xs text-fg3 tn">
            {t('vault.totpRemaining', { seconds: remaining })}
          </span>
        </span>
      </span>
      <Tooltip content={t('vault.copy')}>
        <IconButton
          aria-label={`${t('vault.copy')}: ${label}`}
          tone="plain"
          shape="sq"
          size="sm"
          onClick={() => void copy(totpForCopy(cfg, Date.now()), label)}
        >
          <Icon name="copy" size={16} />
        </IconButton>
      </Tooltip>
    </div>
  );
}
