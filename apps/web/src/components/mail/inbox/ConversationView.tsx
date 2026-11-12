import {
  MAIL_CONVERSATION_STATUSES,
  type MailConversation,
  type MailConversationNote,
  type MailConversationStatus,
  type MailInbox,
  type MailMessage,
} from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Tag,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api, idempotencyKey } from '@/lib/api';
import { formatDateLong, formatRelative, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { type ComposeMode } from '@/lib/mail/compose';
import {
  cannedQuery,
  conversationQuery,
  inboxKeys,
  setReplyingMarks,
  tagsQuery,
  useReplying,
} from '@/lib/mail/inbox';
import { spaceMembersQuery } from '@/lib/queries';
import { useMe } from '@/lib/session';
import { mailError } from '@/components/mail/errors';
import { MessageCard } from '@/components/mail/ThreadView';
import { useDelayed } from '@/components/mail/useDelayed';

const Composer = lazy(() =>
  import('@/components/mail/Composer').then((m) => ({ default: m.Composer })),
);

const UNASSIGNED = 'none';
/** "Replying now" heartbeat while the composer is open (the server forgets a mark after 15 s). */
const HEARTBEAT_MS = 5_000;

type Item =
  | { kind: 'message'; at: number; message: MailMessage }
  | { kind: 'note'; at: number; note: MailConversationNote };

export function ConversationView({
  inbox,
  conversationId,
  onClose,
}: {
  inbox: MailInbox;
  conversationId: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const [remote, setRemote] = useState(false);
  const query = useQuery(conversationQuery(inbox.id, conversationId, remote));
  const slow = useDelayed(query.isPending);
  const c = query.data;
  const replying = useReplying(conversationId, me?.user.id);
  const [compose, setCompose] = useState<{ mode: ComposeMode; source: MailMessage } | null>(null);
  const [note, setNote] = useState('');

  // The server's list of who is writing comes with the conversation; events keep it current.
  useEffect(() => {
    if (c) setReplyingMarks(c.id, c.replying);
  }, [c]);

  // "Replying now" while the composer is open.
  const composing = compose !== null;
  useEffect(() => {
    if (!composing || !inbox.canWork) return;
    const beat = (active: boolean) =>
      void api
        .call('mailInboxReplying', {
          params: { inboxId: inbox.id, conversationId },
          body: { active },
        })
        .catch(() => undefined);
    beat(true);
    const timer = setInterval(() => beat(true), HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      beat(false);
    };
  }, [composing, inbox.canWork, inbox.id, conversationId]);

  const patch = (c: MailConversation) =>
    qc.setQueryData(inboxKeys.conversation(inbox.id, conversationId, remote), c);
  const update = useMutation({
    mutationFn: (body: {
      status?: MailConversationStatus;
      assigneeId?: string | null;
      tags?: string[];
    }) =>
      api.call('mailUpdateInboxConversation', {
        params: { inboxId: inbox.id, conversationId },
        body,
      }),
    onMutate: (body) => {
      // Optimistic: the header changes at once; the list follows from the event.
      const prev = c;
      if (prev) {
        patch({
          ...prev,
          ...(body.status ? { status: body.status } : {}),
          ...(body.tags ? { tags: body.tags } : {}),
        });
      }
      return { prev };
    },
    onError: (e, _b, ctx) => {
      if (ctx?.prev) patch(ctx.prev);
      toast(mailError(t, e));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: inboxKeys.conversationAll(inbox.id, conversationId) });
      void qc.invalidateQueries({ queryKey: inboxKeys.conversations(inbox.id) });
      void qc.invalidateQueries({ queryKey: inboxKeys.list });
    },
  });
  const addNote = useMutation({
    mutationFn: (body: string) =>
      api.call('mailAddInboxNote', {
        params: { inboxId: inbox.id, conversationId },
        body: { body },
        idempotencyKey: idempotencyKey(),
      }),
    onSuccess: (n) => {
      setNote('');
      if (c) patch({ ...c, notes: [...c.notes, n], noteCount: c.noteCount + 1 });
    },
    onError: (e) => toast(mailError(t, e)),
  });
  const removeNote = useMutation({
    mutationFn: (noteId: string) =>
      api.call('mailDeleteInboxNote', {
        params: { inboxId: inbox.id, conversationId, noteId },
      }),
    onSuccess: (_r, noteId) => {
      if (c) patch({ ...c, notes: c.notes.filter((n) => n.id !== noteId) });
    },
    onError: (e) => toast(mailError(t, e)),
  });

  if (query.isPending) {
    if (!slow) return <div className="flex-1" />;
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError || !c) {
    return (
      <EmptyState icon="alert" title={mailError(t, query.error)} className="m-auto">
        <Button size="sm" onClick={onClose}>
          {t('common.actions.close')}
        </Button>
      </EmptyState>
    );
  }

  const items: Item[] = [
    ...c.messages.map((m) => ({
      kind: 'message' as const,
      at: m.date ? Date.parse(m.date) : 0,
      message: m,
    })),
    ...c.notes.map((n) => ({ kind: 'note' as const, at: Date.parse(n.createdAt), note: n })),
  ].sort((a, b) => a.at - b.at);
  const last = [...c.messages].reverse().find((m) => m.folder === 'INBOX') ?? c.messages.at(-1);
  const blocked = c.messages.reduce((n, m) => n + m.blockedImages, 0);

  return (
    <article
      aria-label={c.subject || t('mail.list.noSubject')}
      className="flex min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex flex-col gap-2 border-b border-line px-5 py-3">
        <div className="flex items-start gap-2">
          <IconButton
            size="sm"
            tone="plain"
            className="md:hidden"
            aria-label={t('common.actions.back')}
            onClick={onClose}
          >
            <Icon name="arrowL" size={18} />
          </IconButton>
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="m-0 truncate text-lg font-bold">
              {c.subject || t('mail.list.noSubject')}
            </h2>
            <span className="truncate text-xs text-fg2">
              {c.customer?.name ? `${c.customer.name} · ` : ''}
              {c.customer?.address}
            </span>
          </div>
          <SlaBadge c={c} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={c.status}
            disabled={!inbox.canWork}
            onValueChange={(v) => update.mutate({ status: v as MailConversationStatus })}
          >
            <SelectTrigger className="h-8 w-36" aria-label={t('mail.inbox.statusLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MAIL_CONVERSATION_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`mail.inbox.status.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AssigneePicker
            inbox={inbox}
            value={c.assignee?.id ?? null}
            onChange={(assigneeId) => update.mutate({ assigneeId })}
          />
          <TagEditor inbox={inbox} tags={c.tags} onChange={(tags) => update.mutate({ tags })} />
        </div>
      </header>

      {replying.length ? (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-line bg-accent10 px-5 py-2 text-sm"
        >
          <Icon name="edit" size={14} />
          {t('mail.inbox.replyingNow', {
            name: replying.map((p) => p.name).join(', '),
            count: replying.length,
          })}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-bg px-5 py-4">
        {blocked > 0 && !remote ? (
          <div className="flex items-center gap-2 rounded-lg bg-bg2 px-3 py-2 text-sm">
            <Icon name="image" size={16} />
            <span className="flex-1">{t('mail.view.blocked', { count: blocked })}</span>
            <Button size="sm" onClick={() => setRemote(true)}>
              {t('mail.view.showImages')}
            </Button>
          </div>
        ) : null}
        {items.map((it, i) =>
          it.kind === 'message' ? (
            <MessageCard
              key={`m:${it.message.folder}:${it.message.uid}`}
              message={it.message}
              me={inbox.email}
              remote={remote}
              inboxId={inbox.id}
              initiallyOpen={i === items.length - 1 || it.message === last}
              onCompose={(mode) =>
                inbox.canWork ? setCompose({ mode, source: it.message }) : undefined
              }
            />
          ) : (
            <NoteCard
              key={`n:${it.note.id}`}
              note={it.note}
              canDelete={it.note.author?.id === me?.user.id || inbox.canManage}
              onDelete={() => removeNote.mutate(it.note.id)}
            />
          ),
        )}
      </div>

      {inbox.canWork ? (
        <footer className="flex flex-col gap-2 border-t border-line px-5 py-3">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('mail.inbox.notePlaceholder')}
            aria-label={t('mail.inbox.note')}
            rows={2}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="pri"
              disabled={!last}
              onClick={() => last && setCompose({ mode: 'reply', source: last })}
            >
              <Icon name="reply" size={16} />
              {t('mail.view.reply')}
            </Button>
            <Button
              disabled={!note.trim()}
              loading={addNote.isPending}
              onClick={() => addNote.mutate(note.trim())}
            >
              <Icon name="note" size={16} />
              {t('mail.inbox.addNote')}
            </Button>
            <span className="ml-auto text-xs text-fg3">{t('mail.inbox.noteHint')}</span>
          </div>
        </footer>
      ) : null}

      {compose ? (
        <Suspense fallback={null}>
          <InboxComposer
            inbox={inbox}
            conversationId={conversationId}
            mode={compose.mode}
            source={compose.source}
            status={c.status}
            onClose={() => setCompose(null)}
          />
        </Suspense>
      ) : null}
      <span className="sr-only">
        {formatDateLong(c.lastMessageAt, locale)} {formatTime(c.lastMessageAt, locale)}
      </span>
    </article>
  );
}

function SlaBadge({ c }: { c: MailConversation }) {
  const { t, locale } = useI18n();
  if (c.sla.breached) return <Badge tone="danger">{t('mail.inbox.sla.breached')}</Badge>;
  if (c.firstResponseAt) {
    const minutes = Math.max(
      1,
      Math.round(
        (Date.parse(c.firstResponseAt) - Date.parse(c.lastInboundAt ?? c.firstMessageAt)) / 60_000,
      ),
    );
    return c.sla.dueAt ? (
      <Badge tone="ok">{t('mail.inbox.sla.met')}</Badge>
    ) : (
      <Badge>{t('mail.inbox.sla.answered', { count: minutes })}</Badge>
    );
  }
  if (c.sla.dueAt) {
    return (
      <Badge tone="warn">
        {t('mail.inbox.sla.due', { when: formatRelative(c.sla.dueAt, locale) })}
      </Badge>
    );
  }
  return null;
}

function NoteCard({
  note,
  canDelete,
  onDelete,
}: {
  note: MailConversationNote;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const { t, locale } = useI18n();
  const name = note.author?.name ?? t('mail.inbox.someone');
  return (
    <section
      aria-label={t('mail.inbox.note')}
      className="flex flex-col gap-1.5 rounded-xl bg-accent10 px-4 py-3"
    >
      <div className="flex items-center gap-2 text-xs">
        <Avatar name={name} src={note.author?.imageUrl ?? undefined} size="sm" />
        <span className="font-semibold">{name}</span>
        <Tag>{t('mail.inbox.internal')}</Tag>
        <span className="ml-auto text-fg3 tn">{formatRelative(note.createdAt, locale)}</span>
        {canDelete ? (
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('mail.inbox.deleteNote')}
            onClick={onDelete}
          >
            <Icon name="trash" size={14} />
          </IconButton>
        ) : null}
      </div>
      <p className="m-0 text-sm whitespace-pre-wrap">{note.body}</p>
    </section>
  );
}

function AssigneePicker({
  inbox,
  value,
  onChange,
}: {
  inbox: MailInbox;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const members = useQuery({ ...spaceMembersQuery(inbox.spaceId), enabled: inbox.canWork });
  const workers = (members.data?.items ?? []).filter((m) => m.role !== 'viewer');
  return (
    <Select
      value={value ?? UNASSIGNED}
      disabled={!inbox.canWork}
      onValueChange={(v) => onChange(v === UNASSIGNED ? null : v)}
    >
      <SelectTrigger className="h-8 w-48" aria-label={t('mail.inbox.assignee')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>{t('mail.inbox.unassigned')}</SelectItem>
        {workers.map((m) => (
          <SelectItem key={m.user.id} value={m.user.id}>
            {m.user.name}
          </SelectItem>
        ))}
        {value && !workers.some((m) => m.user.id === value) ? (
          <SelectItem value={value}>{t('mail.inbox.someone')}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

function TagEditor({
  inbox,
  tags,
  onChange,
}: {
  inbox: MailInbox;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const { t } = useI18n();
  const known = useQuery({ ...tagsQuery(inbox.id), enabled: inbox.canWork });
  const [draft, setDraft] = useState('');
  const add = (tag: string) => {
    const v = tag.trim().replace(/^#/, '').slice(0, 40);
    if (!v || tags.includes(v)) return;
    onChange([...tags, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <Tag key={tag} className="gap-1">
          #{tag}
          {inbox.canWork ? (
            <button
              type="button"
              aria-label={t('mail.inbox.removeTag', { tag })}
              onClick={() => onChange(tags.filter((x) => x !== tag))}
            >
              <Icon name="x" size={11} />
            </button>
          ) : null}
        </Tag>
      ))}
      {inbox.canWork ? (
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="gh">
              <Icon name="plus" size={14} />
              {t('mail.inbox.addTag')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-60 flex-col gap-2 p-3">
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add(draft);
                }
              }}
              placeholder={t('mail.inbox.tagPlaceholder')}
              aria-label={t('mail.inbox.addTag')}
            />
            <div className="flex flex-wrap gap-1">
              {(known.data?.items ?? [])
                .filter((k) => !tags.includes(k) && k.includes(draft.trim()))
                .slice(0, 12)
                .map((k) => (
                  <button key={k} type="button" onClick={() => add(k)}>
                    <Tag>#{k}</Tag>
                  </button>
                ))}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/** The composer sending from the inbox's address, with canned responses and the next status. */
function InboxComposer({
  inbox,
  conversationId,
  mode,
  source,
  status,
  onClose,
}: {
  inbox: MailInbox;
  conversationId: string;
  mode: ComposeMode;
  source: MailMessage;
  status: MailConversationStatus;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const canned = useQuery(cannedQuery(inbox.id));
  // Most teams wait for the customer after answering.
  const [after, setAfter] = useState<MailConversationStatus>(
    status === 'open' ? 'pending' : status,
  );
  return (
    <Composer
      mode={mode}
      source={source}
      account={{ email: inbox.email, signatureHtml: inbox.signatureHtml }}
      maxBytes={25 * 1024 * 1024}
      canned={canned.data?.items ?? []}
      footer={
        <Select value={after} onValueChange={(v) => setAfter(v as MailConversationStatus)}>
          <SelectTrigger className="h-8 w-44" aria-label={t('mail.inbox.afterSend')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MAIL_CONVERSATION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t('mail.inbox.afterSendAs', { label: t(`mail.inbox.status.${s}`) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      onSend={(draft, key) =>
        api.call('mailInboxReply', {
          params: { inboxId: inbox.id, conversationId },
          body: {
            to: draft.to,
            cc: draft.cc,
            bcc: draft.bcc,
            subject: draft.subject,
            html: draft.html,
            attachments: draft.attachments,
            mode: mode === 'forward' ? 'forward' : 'reply',
            status: after,
          },
          idempotencyKey: key,
        })
      }
      onSent={() => {
        void qc.invalidateQueries({ queryKey: inboxKeys.all });
      }}
      onClose={onClose}
    />
  );
}
