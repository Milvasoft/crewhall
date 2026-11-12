import type { CalendarAccount, CalendarProvider } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  Input,
  Switch,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  calendarAccountsKey,
  calendarAccountsQuery,
  calendarKeys,
  connectAccountUrl,
} from '@/lib/calendar/queries';
import { useFail } from './bits';

const PROVIDERS: CalendarProvider[] = ['google', 'microsoft', 'exchange'];
const INITIAL: Record<CalendarProvider, string> = { google: 'G', microsoft: 'M', exchange: 'E' };
const CONNECT = {
  google: 'calendar.accounts.connectGoogle',
  microsoft: 'calendar.accounts.connectMicrosoft',
  exchange: 'calendar.accounts.connectExchange',
} as const;

/** Google / Microsoft accounts of the person (calendar settings). Connecting is a redirect. */
export function ConnectedAccounts() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const q = useQuery(calendarAccountsQuery());
  const [removing, setRemoving] = useState<CalendarAccount | null>(null);
  // Exchange has no OAuth: the person signs in here. `email`: connecting that account again.
  const [exchange, setExchange] = useState<{ email: string } | null>(null);

  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: calendarAccountsKey });
    await qc.invalidateQueries({ queryKey: calendarKeys.all });
  };
  const sync = useMutation({
    mutationFn: (id: string) => api.call('syncCalendarAccount', { params: { accountId: id } }),
    onSuccess: async (a) => {
      if (a.status === 'active') toast(t('calendar.accounts.synced'));
      await refresh();
    },
    onError: fail,
  });
  const quiet = useMutation({
    mutationFn: (v: { id: string; busyOnly: boolean }) =>
      api.call('updateCalendarAccount', {
        params: { accountId: v.id },
        body: { busyOnly: v.busyOnly },
      }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.call('deleteCalendarAccount', { params: { accountId: id } }),
    onSuccess: async () => {
      toast(t('calendar.accounts.removed'));
      setRemoving(null);
      await refresh();
    },
    onError: fail,
  });

  const data = q.data;
  if (!data) return null;
  const offered = PROVIDERS.filter((p) => data.providers.includes(p));
  if (!offered.length && !data.items.length) {
    return (
      <Section>
        <p className="m-0 text-xs text-fg3">{t('calendar.accounts.off')}</p>
      </Section>
    );
  }
  const when = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    );

  return (
    <Section>
      {data.items.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {data.items.map((a) => (
            <li
              key={a.id}
              className="flex items-start gap-3 rounded-lg bg-surface p-3 shadow-line"
              aria-label={a.email}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg2 text-xs font-bold">
                {INITIAL[a.provider]}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold">{a.email}</span>
                <span className="text-xs text-fg3">
                  {t(`calendar.accounts.provider.${a.provider}`)} ·{' '}
                  {t('calendar.accounts.calendars', { count: a.calendars.length })}
                </span>
                {a.delegated ? (
                  <span className="text-xs text-fg3">{t('calendar.accounts.delegated')}</span>
                ) : null}
                <label className="flex items-center gap-2 pt-1 text-xs">
                  <Switch
                    checked={a.busyOnly ?? false}
                    disabled={quiet.isPending}
                    onCheckedChange={(v) => quiet.mutate({ id: a.id, busyOnly: v })}
                    aria-label={`${t('calendar.accounts.busyOnly')} · ${a.email}`}
                  />
                  <span title={t('calendar.accounts.busyOnlyHint')}>
                    {t('calendar.accounts.busyOnly')}
                  </span>
                </label>
                {a.contacts?.status === 'active' ? (
                  <span className="text-xs text-fg3">
                    {t('calendar.accounts.contacts', { count: a.contacts.count })}
                  </span>
                ) : a.contacts?.status === 'needs_consent' ? (
                  <span className="text-xs text-danger">
                    {t(
                      a.delegated
                        ? 'calendar.accounts.contactsAdmin'
                        : 'calendar.accounts.contactsConsent',
                    )}
                  </span>
                ) : a.contacts?.status === 'error' ? (
                  <span className="text-xs text-danger">
                    {t('calendar.accounts.contactsError')}
                  </span>
                ) : null}
                {a.status === 'revoked' ? (
                  <span className="text-xs text-danger">
                    {t('calendar.accounts.statusRevoked')}
                  </span>
                ) : a.status === 'error' ? (
                  <span className="text-xs text-danger">{t('calendar.accounts.statusError')}</span>
                ) : (
                  <span className="text-xs text-fg3">
                    {a.lastSyncedAt
                      ? t('calendar.accounts.lastSync', { time: when(a.lastSyncedAt) })
                      : t('calendar.accounts.never')}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {a.status === 'revoked' && a.provider === 'exchange' ? (
                  <Button size="sm" variant="out" onClick={() => setExchange({ email: a.email })}>
                    {t('calendar.accounts.reconnect')}
                  </Button>
                ) : a.status === 'revoked' ||
                  (a.contacts?.status === 'needs_consent' && !a.delegated) ? (
                  <Button asChild size="sm" variant="out">
                    <a href={connectAccountUrl(a.provider)}>{t('calendar.accounts.reconnect')}</a>
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="gh"
                    aria-label={t('calendar.accounts.sync')}
                    title={t('calendar.accounts.sync')}
                    loading={sync.isPending && sync.variables === a.id}
                    onClick={() => sync.mutate(a.id)}
                  >
                    <Icon name="refresh" size={15} />
                  </Button>
                )}
                {a.delegated ? null : (
                  <Button
                    size="icon"
                    variant="gh"
                    aria-label={t('calendar.accounts.remove')}
                    title={t('calendar.accounts.remove')}
                    onClick={() => setRemoving(a)}
                  >
                    <Icon name="trash" size={15} />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs text-fg3">{t('calendar.accounts.none')}</p>
      )}
      {offered.length ? (
        <div className="flex flex-wrap gap-2">
          {offered.map((p) =>
            p === 'exchange' ? (
              <Button key={p} size="sm" variant="out" onClick={() => setExchange({ email: '' })}>
                <Icon name="plus" size={14} />
                {t(CONNECT[p])}
              </Button>
            ) : (
              <Button key={p} asChild size="sm" variant="out">
                <a href={connectAccountUrl(p)}>
                  <Icon name="plus" size={14} />
                  {t(CONNECT[p])}
                </a>
              </Button>
            ),
          )}
        </div>
      ) : null}
      {exchange ? (
        <ExchangeDialog
          email={exchange.email}
          onClose={() => setExchange(null)}
          onConnected={refresh}
        />
      ) : null}
      {removing ? (
        <Dialog open onOpenChange={(o) => !o && setRemoving(null)}>
          <DialogContent width={420}>
            <DialogHeader title={t('calendar.accounts.remove')} />
            <p className="m-0 text-sm text-fg2">
              {t('calendar.accounts.removeConfirm', { email: removing.email })}
            </p>
            <DialogFooter>
              <Button variant="gh" onClick={() => setRemoving(null)}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant="dngf"
                loading={remove.isPending}
                onClick={() => remove.mutate(removing.id)}
              >
                {t('calendar.accounts.remove')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Section>
  );
}

/** Signs in to the org's Exchange server. The password goes to the server and never comes back. */
function ExchangeDialog({
  email: initial,
  onClose,
  onConnected,
}: {
  email: string;
  onClose: () => void;
  onConnected: () => Promise<void>;
}) {
  const { t } = useI18n();
  const fail = useFail();
  const [email, setEmail] = useState(initial);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const connect = useMutation({
    mutationFn: () =>
      api.call('connectExchangeAccount', {
        body: {
          email: email.trim(),
          ...(username.trim() ? { username: username.trim() } : {}),
          password,
        },
      }),
    onSuccess: async () => {
      toast(t('calendar.accounts.exchange.connected'));
      onClose();
      await onConnected();
    },
    onError: fail,
  });
  const valid = Boolean(email.trim() && password);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={440}>
        <DialogHeader title={t('calendar.accounts.exchange.title')} />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) connect.mutate();
          }}
        >
          <p className="m-0 text-sm text-fg2">{t('calendar.accounts.exchange.hint')}</p>
          <Field label={t('calendar.accounts.exchange.email')}>
            <Input
              type="email"
              autoFocus
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field
            label={t('calendar.accounts.exchange.username')}
            hint={t('calendar.accounts.exchange.usernameHint')}
          >
            <Input
              autoComplete="username"
              maxLength={254}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label={t('calendar.accounts.exchange.password')}>
            <Input
              type="password"
              autoComplete="current-password"
              maxLength={1000}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={connect.isPending} disabled={!valid}>
              {t('calendar.accounts.exchange.connect')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Section({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <section
      className="flex flex-col gap-2 rounded-xl bg-bg2 p-4"
      aria-label={t('calendar.accounts.title')}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <Icon name="calendar" size={15} />
        {t('calendar.accounts.title')}
      </span>
      <p className="m-0 text-xs text-fg2">{t('calendar.accounts.hint')}</p>
      {children}
    </section>
  );
}
