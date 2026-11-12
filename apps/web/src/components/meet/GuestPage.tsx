import { type MeetingConnection, type MeetingLinkPreview, paths } from '@crewhall/shared';
import { Button, CrewhallMark, Field, Icon, Input, Spinner } from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { LanguageMenu } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { formatDate, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { readPrefs, readTicket, writePrefs, writeTicket, type GuestTicket } from '@/lib/meet/prefs';
import { meetingLinkQuery } from '@/lib/meet/queries';
import { useBootstrap } from '@/lib/useBranding';
import { useNow } from '@/lib/useNow';
import { useFail } from './bits';
import { PreJoin } from './PreJoin';
import { type GuestChatTicket } from './room/context';
import { RoomView, type JoinChoices, type LeftReason } from './room/RoomView';

type Stage =
  | { kind: 'form' }
  | { kind: 'waiting'; ticket: GuestTicket; choices: JoinChoices }
  | {
      kind: 'room';
      connection: MeetingConnection;
      choices: JoinChoices;
      title: string;
      ticket: GuestChatTicket;
    }
  | { kind: 'left'; reason: LeftReason };

/**
 * Someone without an account opens the room link (design 7.13-7.14): org brand, no shell.
 * They type a name, knock, wait (no media leaves the browser) and join once admitted.
 */
export function GuestPage({ slug }: { slug: string }) {
  const { t, locale } = useI18n();
  const fail = useFail();
  const link = useQuery(meetingLinkQuery(slug));
  const [name, setName] = useState(() => readPrefs().guestName);
  const [stage, setStage] = useState<Stage>(() => {
    const ticket = readTicket(slug);
    return ticket
      ? { kind: 'waiting', ticket, choices: { audio: true, video: true } }
      : { kind: 'form' };
  });

  const knock = useMutation({
    mutationFn: (v: { choices: JoinChoices }) =>
      api
        .call('requestGuestJoin', { params: { slug }, body: { name: name.trim() } })
        .then((r) => ({ r, v })),
    onSuccess: ({ r, v }) => {
      writePrefs({ guestName: name.trim() });
      if (r.connection) {
        setStage({
          kind: 'room',
          connection: r.connection,
          choices: v.choices,
          title: link.data?.title ?? '',
          ticket: { requestId: r.request.id, secret: r.secret },
        });
        return;
      }
      const ticket = { requestId: r.request.id, secret: r.secret, name: name.trim() };
      writeTicket(slug, ticket);
      setStage({ kind: 'waiting', ticket, choices: v.choices });
    },
    onError: fail,
  });

  let body: ReactNode;
  if (stage.kind === 'room') {
    return (
      <div className="flex h-screen flex-col">
        <RoomView
          meeting={null}
          title={stage.title}
          connection={stage.connection}
          guest
          guestTicket={stage.ticket}
          choices={stage.choices}
          onLeft={(reason) => {
            writeTicket(slug, null);
            setStage({ kind: 'left', reason });
          }}
        />
      </div>
    );
  }
  if (link.isLoading) {
    body = <Spinner className="m-auto" />;
  } else if (isApiError(link.error, 'meet_unavailable')) {
    body = (
      <Message
        icon="lock"
        title={t('meet.guestPage.unavailableTitle')}
        body={t('meet.guestPage.unavailableBody')}
      />
    );
  } else if (link.error || !link.data) {
    body = (
      <Message
        icon="alert"
        title={t('meet.guestPage.invalidTitle')}
        body={t('meet.guestPage.invalidBody')}
      />
    );
  } else if (stage.kind === 'left') {
    body = (
      <Message
        icon={stage.reason === 'error' || stage.reason === 'dropped' ? 'alert' : 'check'}
        title={
          stage.reason === 'error'
            ? t('meet.room.mediaBlockedTitle')
            : stage.reason === 'dropped'
              ? t('meet.room.droppedTitle')
              : stage.reason === 'removed'
                ? t('meet.removed.title')
                : t('meet.guestPage.leftTitle')
        }
        body={
          stage.reason === 'error'
            ? t('meet.room.mediaBlockedBody')
            : stage.reason === 'dropped'
              ? t('meet.room.droppedBody')
              : stage.reason === 'ended'
                ? t('meet.guestPage.endedBody')
                : t('meet.guestPage.leftBody')
        }
      >
        <Button variant="out" onClick={() => setStage({ kind: 'form' })}>
          {t('meet.guestPage.rejoin')}
        </Button>
      </Message>
    );
  } else if (link.data.status !== 'valid') {
    body = (
      <Message
        icon="clock"
        title={t('meet.guestPage.expiredTitle')}
        body={t('meet.guestPage.expiredBody')}
      />
    );
  } else if (!link.data.guestsAllowed) {
    body = (
      <Message
        icon="lock"
        title={t('meet.guestPage.membersOnlyTitle')}
        body={t('meet.guestPage.membersOnlyBody')}
      >
        <Button asChild variant="pri">
          <Link to="/login" search={{ redirect: paths.meetingJoin(slug) }}>
            {t('meet.guestPage.signIn')}
          </Link>
        </Button>
      </Message>
    );
  } else if (stage.kind === 'waiting') {
    body = (
      <Waiting
        slug={slug}
        preview={link.data}
        ticket={stage.ticket}
        onAdmitted={(connection, title) =>
          setStage({
            kind: 'room',
            connection,
            choices: stage.choices,
            title,
            ticket: { requestId: stage.ticket.requestId, secret: stage.ticket.secret },
          })
        }
        onCancel={() => {
          writeTicket(slug, null);
          setStage({ kind: 'form' });
        }}
      />
    );
  } else {
    const p = link.data;
    const when = p.startsAt
      ? `${formatDate(p.startsAt, locale, { weekday: 'long', day: 'numeric', month: 'long' })} ${formatTime(p.startsAt, locale)}${
          p.durationMinutes
            ? `–${formatTime(new Date(new Date(p.startsAt).getTime() + p.durationMinutes * 60_000), locale)}`
            : ''
        }`
      : null;
    body = (
      <PreJoin
        heading={t('meet.guestPage.invited')}
        title={p.title}
        subtitle={[
          p.orgName,
          p.hostName ? t('meet.guestPage.invitedBy', { name: p.hostName }) : null,
          when,
        ]
          .filter(Boolean)
          .join(' · ')}
        inside={p.insideInitials.map((i) => ({ name: [...i].join(' ') }))}
        insideCount={p.insideCount}
        recording={p.recording}
        name={name}
        joinLabel={p.lobby ? t('meet.guestPage.ask') : t('meet.actions.join')}
        joining={knock.isPending}
        canJoin={name.trim().length > 0}
        onJoin={(choices) => knock.mutate({ choices })}
        footnote={t('meet.guestPage.permissionNote')}
      >
        <Field label={t('meet.guestPage.nameLabel')} hint={t('meet.guestPage.nameHint')}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            autoFocus
            autoComplete="name"
          />
        </Field>
      </PreJoin>
    );
  }
  return <GuestFrame slug={slug}>{body}</GuestFrame>;
}

function Waiting({
  slug,
  preview,
  ticket,
  onAdmitted,
  onCancel,
}: {
  slug: string;
  preview: MeetingLinkPreview;
  ticket: GuestTicket;
  onAdmitted: (c: MeetingConnection, title: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const now = useNow(1000);
  const poll = useQuery({
    queryKey: ['meet', 'guest-poll', ticket.requestId],
    queryFn: () =>
      api.call('pollGuestRequest', {
        params: { requestId: ticket.requestId },
        body: { secret: ticket.secret },
      }),
    refetchInterval: 2000,
    retry: false,
  });
  const res = poll.data;
  useEffect(() => {
    if (res?.connection) onAdmitted(res.connection, res.meetingTitle);
  }, [res, onAdmitted]);
  const cancel = useMutation({
    mutationFn: () =>
      api.call('cancelGuestRequest', {
        params: { requestId: ticket.requestId },
        body: { secret: ticket.secret },
      }),
    onSettled: onCancel,
  });
  const status = res?.request.status ?? 'waiting';
  const retryIn = res?.request.retryAt
    ? Math.max(0, Math.ceil((new Date(res.request.retryAt).getTime() - now) / 1000))
    : 0;

  if (poll.error && isApiError(poll.error, 'not_found')) {
    return (
      <Message
        icon="alert"
        title={t('meet.guestPage.invalidTitle')}
        body={t('meet.guestPage.invalidBody')}
      />
    );
  }
  if (status === 'denied' || status === 'expired' || status === 'cancelled') {
    return (
      <Message
        icon="alert"
        title={
          status === 'denied'
            ? t('meet.guestPage.deniedTitle')
            : t('meet.guestPage.expiredRequestTitle')
        }
        body={
          status === 'denied' && retryIn
            ? t('meet.guestPage.retryIn', { seconds: retryIn })
            : t('meet.guestPage.retryNow')
        }
      >
        <Button variant="pri" disabled={retryIn > 0} onClick={onCancel}>
          {t('meet.guestPage.askAgain')}
        </Button>
      </Message>
    );
  }
  return (
    <div className="m-auto flex w-full max-w-[460px] flex-col items-center gap-4 text-center">
      <Spinner />
      <span className="eyebrow">{ticket.name}</span>
      <h1 className="text-h1 font-bold">{t('meet.guestPage.waitingTitle')}</h1>
      <p className="text-sm text-fg2">
        {preview.hostName
          ? t('meet.guestPage.waitingBodyHost', { name: preview.hostName })
          : t('meet.guestPage.waitingBody')}
      </p>
      <p className="text-sm text-fg2">
        {t('meet.guestPage.insideCount', { title: preview.title, count: preview.insideCount })}
      </p>
      <div className="flex gap-2">
        <Button variant="out" loading={cancel.isPending} onClick={() => cancel.mutate()}>
          {t('meet.actions.cancel')}
        </Button>
      </div>
      <p className="text-xs text-fg3">{t('meet.guestPage.waitingNote')}</p>
      <span className="hidden">{slug}</span>
    </div>
  );
}

function Message({
  icon,
  title,
  body,
  children,
}: {
  icon: 'alert' | 'clock' | 'lock' | 'check';
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div className="m-auto flex max-w-[420px] flex-col items-center gap-3 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-bg2">
        <Icon name={icon} size={22} />
      </span>
      <h1 className="text-h font-bold">{title}</h1>
      <p className="text-sm text-fg2">{body}</p>
      {children}
    </div>
  );
}

function GuestFrame({ slug, children }: { slug: string; children: ReactNode }) {
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
        {branding.showPoweredBy ? (
          <span className="text-xs text-fg3">{t('meet.guestPage.poweredBy')}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-sm text-fg2">{t('meet.guestPage.haveAccount')}</span>
          <Button size="sm" variant="out" asChild>
            <Link to="/login" search={{ redirect: paths.meetingJoin(slug) }}>
              {t('meet.guestPage.signIn')}
            </Link>
          </Button>
        </span>
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-6 py-6">{children}</main>
      <footer className="flex shrink-0 items-center justify-center gap-3 px-6 pb-5 text-xs text-fg3">
        {t('meet.guestPage.footer')}
        <LanguageMenu />
      </footer>
    </div>
  );
}
