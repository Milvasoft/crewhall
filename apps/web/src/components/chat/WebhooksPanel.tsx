import { type AppLocale } from '@crewhall/i18n';
import {
  AlertSeverity,
  WEBHOOK_PROVIDER_EVENTS,
  WEBHOOK_PROVIDERS,
  type IncomingWebhookSecret,
  type WebhookProvider,
} from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  CheckboxRow,
  cn,
  Field,
  Icon,
  IconButton,
  Input,
  Segmented,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  toast,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { deliveriesQuery, chatKeys, webhooksQuery } from '@/lib/chat/queries';
import { type Conversation, type Delivery, type IncomingWebhook } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { formatBytes, formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { listTime } from './common';
import { ResizablePane } from '@/components/shell/ResizablePane';

const HEALTH_TONE = {
  active: 'ok',
  limited: 'warn',
  muted: 'default',
  failing: 'danger',
  disabled: 'default',
} as const;

/** 4.12-4.14: apps and incoming webhooks of a chat, creation with the one-time URL, delivery log. */
export function WebhooksPanel({ conv, webhookId }: { conv: Conversation; webhookId?: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data, isPending } = useQuery(webhooksQuery(conv.id));
  const [selected, setSelected] = useState<string | null>(null);
  // 'webhook': Crewhall / Google Chat body; 'integration': GitHub, Azure DevOps or Jira.
  const [creating, setCreating] = useState<'webhook' | 'integration' | null>(null);
  const [secret, setSecret] = useState<IncomingWebhookSecret | null>(null);

  const go = (search: { panel?: 'webhooks'; hook?: string }) =>
    void navigate({ to: '/chat/c/$conversationId', params: { conversationId: conv.id }, search });

  const log = webhookId ? data?.find((w) => w.id === webhookId) : undefined;

  return (
    <ResizablePane id="chat-webhooks" side="right" defaultWidth={380}>
      <aside
        aria-label={t('chat.hooks.title')}
        className="flex w-full min-w-0 flex-col overflow-y-auto border-l border-line bg-bg"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          {log || secret || creating ? (
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('common.actions.back')}
              onClick={() => {
                setSecret(null);
                setCreating(null);
                go({ panel: 'webhooks' });
              }}
            >
              <Icon name="arrowL" size={15} />
            </IconButton>
          ) : (
            <Icon name="plug" size={17} />
          )}
          <h2 className="m-0 flex-1 truncate text-[15px] font-bold">
            {log ? t('chat.hooks.logTitle', { name: log.name }) : t('chat.hooks.title')}
          </h2>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('common.actions.close')}
            onClick={() => go({})}
          >
            <Icon name="x" size={15} />
          </IconButton>
        </div>
        {log ? (
          <DeliveryLog hook={log} />
        ) : secret ? (
          <SecretView
            secret={secret}
            onRegenerated={setSecret}
            onDone={() => {
              setSecret(null);
              setCreating(null);
            }}
          />
        ) : creating ? (
          <CreateForm
            conv={conv}
            integration={creating === 'integration'}
            onCreated={setSecret}
            onCancel={() => setCreating(null)}
          />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            <p className="m-0 text-cap text-fg2">{t('chat.hooks.hint')}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="pri" onClick={() => setCreating('webhook')}>
                <Icon name="plus" size={16} />
                {t('chat.hooks.add')}
              </Button>
              <Button variant="out" onClick={() => setCreating('integration')}>
                <Icon name="plug" size={16} />
                {t('chat.hooks.integrations.add')}
              </Button>
            </div>
            <h3 className="m-0 text-[11px] font-bold tracking-[.06em] text-fg3 uppercase">
              {t('chat.hooks.list', { count: data?.length ?? 0 })}
            </h3>
            {isPending ? (
              <Skeleton className="h-14 w-full rounded-lg" />
            ) : data?.length ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {data.map((w) => (
                  <HookRow
                    key={w.id}
                    hook={w}
                    open={selected === w.id}
                    onToggle={() => setSelected(selected === w.id ? null : w.id)}
                    onLog={() => go({ panel: 'webhooks', hook: w.id })}
                    onSecret={setSecret}
                  />
                ))}
              </ul>
            ) : (
              <p className="m-0 text-cap text-fg2">{t('chat.hooks.empty')}</p>
            )}
            <div className="flex gap-2.5 rounded-lg bg-bg2 p-3">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-fg2" />
              <div className="flex flex-col gap-1">
                <span className="text-cap font-semibold">{t('chat.hooks.googleTitle')}</span>
                <span className="text-xs text-fg2">{t('chat.hooks.googleBody')}</span>
              </div>
            </div>
          </div>
        )}
      </aside>
    </ResizablePane>
  );
}

function HookRow({
  hook,
  open,
  onToggle,
  onLog,
  onSecret,
}: {
  hook: IncomingWebhook;
  open: boolean;
  onToggle: () => void;
  onLog: () => void;
  onSecret: (s: IncomingWebhookSecret) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const now = useNow(60_000);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(hook.name);
  const refresh = () =>
    void qc.invalidateQueries({ queryKey: chatKeys.webhooks(hook.conversationId) });
  const fail = (e: unknown) => toast.error(t(errorKey(e)));
  const patch = async (body: {
    name?: string;
    mutedUntil?: string | null;
    disabled?: boolean;
    events?: string[];
    textSeverity?: AlertSeverity | null;
  }) => {
    try {
      await api.call('updateIncomingWebhook', { params: { webhookId: hook.id }, body });
      refresh();
    } catch (e) {
      fail(e);
    }
  };
  const muted = hook.health === 'muted';
  return (
    <li
      className={cn(
        'flex flex-col rounded-lg shadow-line',
        open && 'shadow-[inset_0_0_0_1.5px_var(--fg)]',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex items-center gap-3 px-3 py-2.5 text-left"
      >
        <Avatar name={hook.name} src={hook.avatarUrl} size="md" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-cap font-semibold">{hook.name}</span>
          {hook.provider ? (
            <span className="truncate text-xs text-fg2">
              {t('chat.hooks.integrations.via', { service: PROVIDER_NAMES[hook.provider] })}
            </span>
          ) : null}
          <span className="truncate text-xs text-fg2">
            {hook.lastUsedAt
              ? t('chat.hooks.lastUsed', {
                  time: listTime(hook.lastUsedAt, locale, now, t('chat.time.yesterday')),
                  count: hook.deliveries24h,
                })
              : t('chat.hooks.neverUsed')}
          </span>
        </span>
        <Badge tone={HEALTH_TONE[hook.health]}>{t(`chat.hooks.health.${hook.health}`)}</Badge>
        <Icon name={open ? 'chevD' : 'chevR'} size={14} className="text-fg3" />
      </button>
      {open ? (
        <div className="flex flex-col gap-2.5 border-t border-line px-3 py-2.5">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) void patch({ name: name.trim() }).then(() => setEditing(false));
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                aria-label={t('chat.hooks.name')}
                autoFocus
              />
              <Button type="submit" size="sm" variant="inv">
                {t('common.actions.save')}
              </Button>
            </form>
          ) : null}
          {editing && !hook.provider ? (
            <TextSeverityField
              value={hook.textSeverity ?? null}
              onChange={(textSeverity) => void patch({ textSeverity })}
            />
          ) : null}
          {editing && hook.provider ? (
            <EventChoice
              provider={hook.provider}
              events={hook.events ?? []}
              onChange={(events) => {
                if (events.length) void patch({ events });
              }}
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant="out" onClick={onLog}>
              <Icon name="list" size={14} />
              {t('chat.hooks.log')}
            </Button>
            <Button size="xs" variant="out" onClick={() => setEditing((v) => !v)}>
              <Icon name="edit" size={14} />
              {t('chat.hooks.edit')}
            </Button>
            <Button
              size="xs"
              variant="out"
              onClick={() =>
                void patch({
                  mutedUntil: muted ? null : new Date(Date.now() + 3_600_000).toISOString(),
                })
              }
            >
              <Icon name="speaker" size={14} />
              {t(muted ? 'chat.hooks.unmute' : 'chat.hooks.mute')}
            </Button>
            <Button
              size="xs"
              variant="out"
              onClick={async () => {
                try {
                  onSecret(
                    await api.call('regenerateIncomingWebhookKey', {
                      params: { webhookId: hook.id },
                    }),
                  );
                  refresh();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              <Icon name="refresh" size={14} />
              {t('chat.hooks.regenerate')}
            </Button>
            <Button
              size="xs"
              variant="out"
              onClick={() => void patch({ disabled: !hook.disabledAt })}
            >
              {t(hook.disabledAt ? 'chat.hooks.enable' : 'chat.hooks.disable')}
            </Button>
            <Button
              size="xs"
              variant="dng"
              onClick={async () => {
                try {
                  await api.call('deleteIncomingWebhook', { params: { webhookId: hook.id } });
                  refresh();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              <Icon name="trash" size={14} />
              {t('common.actions.delete')}
            </Button>
          </div>
          {hook.health === 'limited' ? (
            <p className="m-0 text-xs text-fg2">
              {t('chat.hooks.limitedHint', { limit: hook.rateLimit })}
            </p>
          ) : hook.health === 'failing' ? (
            <p className="m-0 text-xs text-fg2">{t('chat.hooks.failingHint')}</p>
          ) : null}
          <code className="truncate rounded-sm bg-bg2 px-2 py-1 font-mono text-[11px] text-fg2">
            {hook.maskedUrl}
          </code>
        </div>
      ) : null}
    </li>
  );
}

/** A service's event name as its dictionary key: i18n paths can't hold `.` or `:`. */
export function webhookEventKey(event: string) {
  return `chat.hooks.integrations.event.${event.replace(/[:.]/g, '_')}` as 'chat.hooks.integrations.event.push';
}

export const PROVIDER_NAMES: Record<WebhookProvider, string> = {
  github: 'GitHub',
  azure_devops: 'Azure DevOps',
  jira: 'Jira',
};

/**
 * Design 04 "Kartsız mesajın önemi": how serious a message without a card is. "Metinden oku"
 * (null) looks at its status emoji and words; a chosen "Kritik" breaks quiet hours.
 */
function TextSeverityField({
  value,
  onChange,
}: {
  value: AlertSeverity | null;
  onChange: (v: AlertSeverity | null) => void;
}) {
  const { t } = useI18n();
  return (
    <Field label={t('chat.hooks.textSeverity')} hint={t('chat.hooks.textSeverityHint')}>
      <Select
        value={value ?? 'auto'}
        onValueChange={(v) => onChange(v === 'auto' ? null : AlertSeverity.parse(v))}
      >
        <SelectTrigger aria-label={t('chat.hooks.textSeverity')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t('chat.hooks.textSeverityAuto')}</SelectItem>
          {AlertSeverity.options.map((s) => (
            <SelectItem key={s} value={s}>
              {t(`chat.severity.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Event choice of an integration (the service's keys, labelled from i18n). */
function EventChoice({
  provider,
  events,
  onChange,
}: {
  provider: WebhookProvider;
  events: string[];
  onChange: (events: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
      <legend className="mb-1 text-cap font-semibold">{t('chat.hooks.integrations.events')}</legend>
      {WEBHOOK_PROVIDER_EVENTS[provider].map((e) => (
        <CheckboxRow
          key={e}
          checked={events.includes(e)}
          onCheckedChange={(v) =>
            onChange(v === true ? [...events, e] : events.filter((x) => x !== e))
          }
        >
          {t(webhookEventKey(e))}
        </CheckboxRow>
      ))}
    </fieldset>
  );
}

function CreateForm({
  conv,
  integration,
  onCreated,
  onCancel,
}: {
  conv: Conversation;
  integration: boolean;
  onCreated: (s: IncomingWebhookSecret) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<WebhookProvider>('github');
  const [events, setEvents] = useState<string[]>([...WEBHOOK_PROVIDER_EVENTS.github]);
  const [name, setName] = useState(integration ? PROVIDER_NAMES.github : '');
  const [textSeverity, setTextSeverity] = useState<AlertSeverity | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = (p: WebhookProvider) => {
    if (name === PROVIDER_NAMES[provider] || !name.trim()) setName(PROVIDER_NAMES[p]);
    setProvider(p);
    setEvents([...WEBHOOK_PROVIDER_EVENTS[p]]);
  };
  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          onCreated(
            await api.call('createIncomingWebhook', {
              params: { conversationId: conv.id },
              body: integration
                ? { name: name.trim(), provider, events }
                : { name: name.trim(), textSeverity },
            }),
          );
          void qc.invalidateQueries({ queryKey: chatKeys.webhooks(conv.id) });
        } catch (err) {
          toast.error(t(errorKey(err)));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="m-0 text-cap text-fg2">
        {integration
          ? t('chat.hooks.integrations.hint', { name: conv.title })
          : t('chat.hooks.createHint', { name: conv.title })}
      </p>
      {integration ? (
        <Segmented
          aria-label={t('chat.hooks.integrations.service')}
          value={provider}
          onValueChange={pick}
          options={WEBHOOK_PROVIDERS.map((p) => ({ value: p, label: PROVIDER_NAMES[p] }))}
        />
      ) : null}
      <Field label={t('chat.hooks.name')} hint={t('chat.hooks.nameHint')}>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
          placeholder={t('chat.hooks.namePlaceholder')}
        />
      </Field>
      {integration ? (
        <EventChoice provider={provider} events={events} onChange={setEvents} />
      ) : (
        <TextSeverityField value={textSeverity} onChange={setTextSeverity} />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="gh" onClick={onCancel}>
          {t('common.actions.cancel')}
        </Button>
        <Button
          type="submit"
          variant="inv"
          loading={busy}
          disabled={!name.trim() || (integration && events.length === 0)}
        >
          {t('chat.hooks.create')}
        </Button>
      </div>
    </form>
  );
}

/** 4.13: the URL carries the key; masked by default, shown for 10 seconds. */
function SecretView({
  secret,
  onRegenerated,
  onDone,
}: {
  secret: IncomingWebhookSecret;
  onRegenerated: (s: IncomingWebhookSecret) => void;
  onDone: () => void;
}) {
  const provider = secret.webhook.provider ?? null;
  const { t } = useI18n();
  const [shownUntil, setShownUntil] = useState(0);
  const now = useNow(1000);
  const [tab, setTab] = useState<'curl' | 'google'>('curl');
  const shown = now < shownUntil;
  const copy = (s: string) =>
    void navigator.clipboard
      .writeText(s)
      .then(() => toast(t('chat.hooks.copied')))
      .catch(() => undefined);
  const curl = `curl -X POST '${secret.url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ text: t('chat.hooks.sample.text'), card: { severity: 'success', title: t('chat.hooks.sample.title') } })}'`;
  const google = `curl -X POST '${secret.url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ cardsV2: [{ card: { header: { title: t('chat.hooks.sample.title') }, sections: [{ widgets: [{ decoratedText: { topLabel: t('chat.hooks.sample.label'), text: '48' } }] }] } }] })}'`;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2.5">
        <Avatar name={secret.webhook.name} size="md" />
        <span className="flex flex-col">
          <span className="text-cap font-semibold">{secret.webhook.name}</span>
          <span className="text-xs text-success">{t('chat.hooks.created')}</span>
        </span>
      </div>
      <Field label={t('chat.hooks.url')} hint={t('chat.hooks.urlHint')}>
        <div className="flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded-md bg-bg2 px-2.5 py-2 font-mono text-[11.5px]">
            {shown ? secret.url : secret.webhook.maskedUrl}
          </code>
          <Button size="xs" variant="out" onClick={() => setShownUntil(Date.now() + 10_000)}>
            <Icon name={shown ? 'eyeOff' : 'eye'} size={14} />
            {t('chat.hooks.show')}
          </Button>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('chat.hooks.copy')}
            onClick={() => copy(secret.url)}
          >
            <Icon name="copy" size={14} />
          </IconButton>
        </div>
      </Field>
      {provider ? (
        <>
          <Field
            label={t('chat.hooks.integrations.secret')}
            hint={t('chat.hooks.integrations.secretHint')}
          >
            <div className="flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-bg2 px-2.5 py-2 font-mono text-[11.5px]">
                {shown ? secret.secret : '••••••••••••••••'}
              </code>
              <IconButton
                size="xs"
                tone="plain"
                aria-label={t('chat.hooks.integrations.copySecret')}
                onClick={() => copy(secret.secret ?? '')}
              >
                <Icon name="copy" size={14} />
              </IconButton>
            </div>
          </Field>
          <div className="flex flex-col gap-1 rounded-lg bg-bg2 p-3">
            <span className="text-cap font-semibold">
              {t('chat.hooks.integrations.setupTitle', { service: PROVIDER_NAMES[provider] })}
            </span>
            <p className="m-0 text-xs whitespace-pre-line text-fg2">
              {t(`chat.hooks.integrations.setup.${provider}`)}
            </p>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <div role="tablist" className="flex gap-3 border-b border-line">
            {(['curl', 'google'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn(
                  '-mb-px border-b-2 pb-1.5 text-xs font-semibold',
                  tab === k ? 'border-accent text-fg' : 'border-transparent text-fg2',
                )}
              >
                {t(`chat.hooks.examples.${k}`)}
              </button>
            ))}
          </div>
          <pre className="m-0 overflow-x-auto rounded-md bg-bg2 p-3 font-mono text-[11px] leading-4 whitespace-pre-wrap">
            {shown
              ? tab === 'curl'
                ? curl
                : google
              : (tab === 'curl' ? curl : google).replace(secret.url, secret.webhook.maskedUrl)}
          </pre>
          <Button
            size="xs"
            variant="out"
            className="self-start"
            onClick={() => copy(tab === 'curl' ? curl : google)}
          >
            <Icon name="copy" size={14} />
            {t('chat.hooks.copyExample')}
          </Button>
        </div>
      )}
      <p className="m-0 text-xs text-fg2">{t('chat.hooks.limits')}</p>
      <div className="flex justify-between gap-2">
        <Button
          size="sm"
          variant="gh"
          onClick={async () => {
            try {
              onRegenerated(
                await api.call('regenerateIncomingWebhookKey', {
                  params: { webhookId: secret.webhook.id },
                }),
              );
              toast(t('chat.hooks.regenerated'));
            } catch (e) {
              toast.error(t(errorKey(e)));
            }
          }}
        >
          <Icon name="refresh" size={14} />
          {t('chat.hooks.regenerate')}
        </Button>
        <Button size="sm" variant="inv" onClick={onDone}>
          {t('chat.hooks.done')}
        </Button>
      </div>
    </div>
  );
}

function statusTone(s: number) {
  if (s < 300) return 'ok';
  if (s === 429) return 'warn';
  return 'danger';
}

/** 4.14: requests of the last 7 days; a failed row opens its reason and body excerpt. */
function DeliveryLog({ hook }: { hook: IncomingWebhook }) {
  const { t, locale } = useI18n();
  const { data, isPending } = useQuery(deliveriesQuery(hook.id));
  const [open, setOpen] = useState<string | null>(null);
  const rows: Delivery[] = data?.items ?? [];
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="m-0 text-xs text-fg2">{t('chat.hooks.logHint')}</p>
      {isPending ? <Skeleton className="h-24 w-full" /> : null}
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="text-left text-fg3">
            <th className="py-1 font-semibold">{t('chat.hooks.cols.time')}</th>
            <th className="py-1 font-semibold">{t('chat.hooks.cols.status')}</th>
            <th className="py-1 font-semibold">{t('chat.hooks.cols.size')}</th>
            <th className="py-1 text-right font-semibold">{t('chat.hooks.cols.latency')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <DeliveryRow
              key={d.id}
              d={d}
              open={open === d.id}
              onToggle={() => setOpen(open === d.id ? null : d.id)}
              locale={locale}
            />
          ))}
        </tbody>
      </table>
      {!isPending && rows.length === 0 ? (
        <p className="m-0 text-cap text-fg2">{t('chat.hooks.logEmpty')}</p>
      ) : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-bg2 p-3 text-[11.5px]">
        {(['400', '413', '429', '5xx'] as const).map((c) => (
          <div key={c} className="contents">
            <dt className="font-mono font-semibold">{c}</dt>
            <dd className="m-0 text-fg2">{t(`chat.hooks.codes.${c}`)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DeliveryRow({
  d,
  open,
  onToggle,
  locale,
}: {
  d: Delivery;
  open: boolean;
  onToggle: () => void;
  locale: AppLocale;
}) {
  const { t } = useI18n();
  const failed = d.status >= 300;
  return (
    <>
      <tr
        className={cn('border-t border-line', failed && 'cursor-pointer hover:bg-bg2')}
        onClick={failed ? onToggle : undefined}
        aria-expanded={failed ? open : undefined}
      >
        <td className="py-1.5">
          {formatDate(d.receivedAt, locale, { day: 'numeric', month: 'short' })}{' '}
          {formatTime(d.receivedAt, locale)}
        </td>
        <td className="py-1.5">
          <Badge tone={statusTone(d.status)} className="h-[18px] px-1.5 text-[10.5px]">
            {d.status}
          </Badge>
        </td>
        <td className="py-1.5 text-fg2">{formatBytes(d.sizeBytes, locale)}</td>
        <td className="py-1.5 text-right text-fg2">{t('chat.hooks.ms', { ms: d.latencyMs })}</td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={4} className="pb-2">
            <div className="flex flex-col gap-1 rounded-md bg-bg2 p-2.5">
              {d.error ? <span className="font-semibold text-danger">{d.error}</span> : null}
              {d.ip ? <span className="text-fg2">{t('chat.hooks.ip', { ip: d.ip })}</span> : null}
              {d.bodyExcerpt ? (
                <code className="font-mono text-[11px] break-all whitespace-pre-wrap">
                  {d.bodyExcerpt}
                </code>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
