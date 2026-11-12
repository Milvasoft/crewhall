import { CHAT_LIMITS, type SharedMeetingJoin } from '@crewhall/shared';
import { Avatar, Button, Chip, cn, Icon, Skeleton, toast } from '@crewhall/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { nameOf, rememberPeople } from '@/lib/chat/names';
import { usePending } from '@/lib/chat/outbox';
import { chatSettingsQuery, messagesQuery, readsQuery } from '@/lib/chat/queries';
import {
  ensureLoaded,
  jumpToLatest,
  loadOlder,
  releaseUnreadHold,
  reportVisibleSeq,
} from '@/lib/chat/runtime';
import { isLooking, setVisibleConversation, useTyping } from '@/lib/chat/stores';
import { firstName, sameDay } from '@/lib/chat/text';
import { type Conversation, type Message } from '@/lib/chat/types';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useExit } from '@/lib/motion';
import { useNow } from '@/lib/useNow';
import { ChatUnreadSummary } from '@/components/ai/ChatUnreadSummary';
import { RoomView } from '@/components/meet/room/RoomView';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useMessageActions } from './actions';
import { dayLabel, PersonAvatar, useMyId } from './common';
import { Composer, type ComposerHandle } from './Composer';
import { DEFAULT_QUICK } from './EmojiPicker';
import { MessageItem, PendingItem, type MessageHandlers } from './MessageItem';
import { useMessageEnter } from './motion';

/** The "Sohbet" tab: message flow, typing line and composer (4.1-4.5, 4.17, 4.18). */
export function ConversationPane({ conv, seq }: { conv: Conversation; seq?: number }) {
  const { t, locale } = useI18n();
  const me = useMyId();
  const now = useNow(60_000);
  const act = useMessageActions();
  const { data: w, isPending } = useQuery(messagesQuery(conv.id));
  const pending = usePending(conv.id);
  const { data: settings } = useQuery(chatSettingsQuery);
  const { data: reads } = useQuery({
    ...readsQuery(conv.id),
    enabled: conv.type !== 'alert' && conv.memberCount <= CHAT_LIMITS.readAvatarsMax,
  });
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [divider, setDivider] = useState(() => (conv.my.unread > 0 ? conv.my.lastReadSeq : null));
  // Messages after this arrived while the chat was open (mine among them end the divider).
  const [openedAtSeq] = useState(conv.lastSeq);
  const [highlight, setHighlight] = useState<number | null>(null);
  // Opening the chat ends an earlier "Okunmadı olarak işaretle"; marking it from here holds.
  useEffect(() => releaseUnreadHold(conv.id), [conv.id]);
  const [showJump, setShowJump] = useState(false);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const restore = useRef<number | null>(null);
  const loadingOlder = useRef(false);
  const initialDone = useRef(false);
  const hovered = useRef<number | null>(null);
  const composer = useRef<ComposerHandle>(null);

  const items = useMemo(() => w?.items ?? [], [w]);
  const enterOf = useMessageEnter(items, pending, me, !isPending);
  const quick = useMemo(() => {
    const recent = settings?.recentEmojis ?? [];
    return [...new Set([...recent, ...DEFAULT_QUICK])].slice(0, 5);
  }, [settings]);

  useEffect(() => {
    rememberPeople(items.flatMap((m) => (m.author ? [m.author] : [])));
  }, [items]);

  useEffect(() => {
    setVisibleConversation(conv.id);
    return () => setVisibleConversation(null);
  }, [conv.id]);

  const scrollToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const jump = useCallback(
    async (target: number) => {
      await ensureLoaded(conv.id, target);
      requestAnimationFrame(() => {
        document.getElementById(`msg-${target}`)?.scrollIntoView({ block: 'center' });
        setHighlight(target);
        window.setTimeout(() => setHighlight((h) => (h === target ? null : h)), 2200);
      });
    },
    [conv.id],
  );

  // First paint: the linked message, the "Yeni mesajlar" divider, or the end.
  useLayoutEffect(() => {
    if (initialDone.current || !w) return;
    initialDone.current = true;
    if (seq) return;
    const el = scroller.current;
    const mark = divider !== null ? document.getElementById('new-messages') : null;
    if (el && mark) {
      el.scrollTop = Math.max(0, mark.offsetTop - 120);
      atBottom.current = false;
    } else {
      scrollToBottom();
    }
  }, [w, divider, seq, scrollToBottom]);

  useEffect(() => {
    if (seq) void jump(seq);
  }, [seq, jump]);

  // New messages keep the view pinned to the end; older pages keep the reading position.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restore.current !== null) {
      el.scrollTop += el.scrollHeight - restore.current;
      restore.current = null;
      return;
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, pending]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottom.current = bottom;
    setShowJump(!bottom || Boolean(w?.hasNewer));
    if (el.scrollTop < 160 && w?.hasMore && !loadingOlder.current) {
      loadingOlder.current = true;
      restore.current = el.scrollHeight;
      try {
        await loadOlder(conv.id);
      } catch {
        restore.current = null;
      } finally {
        loadingOlder.current = false;
      }
    }
  };

  // Read position: the largest seq on screen, sent 1 s later by the runtime.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const visible = new Set<number>();
    const report = () => {
      // Only someone looking reads: a visible window behind others leaves new messages unread.
      if (!isLooking() || visible.size === 0) return;
      reportVisibleSeq(conv.id, Math.max(...visible));
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const s = Number((e.target as HTMLElement).dataset.seq);
          if (e.isIntersecting) visible.add(s);
          else visible.delete(s);
        }
        report();
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll<HTMLElement>('[data-seq]').forEach((n) => io.observe(n));
    const onVis = () => report();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [conv.id, items]);

  const lastOwn = useMemo(
    () =>
      [...items].reverse().find((m) => m.author?.id === me && !m.deletedAt && m.kind === 'user'),
    [items, me],
  );

  const handlers: MessageHandlers = useMemo(
    () => ({
      onReply: (m) => {
        setEditing(null);
        setReply(m);
        composer.current?.focus();
      },
      onEdit: (m) => {
        setReply(null);
        setEditing(m);
        composer.current?.focus();
      },
      onJump: (s) => void jump(s),
    }),
    [jump],
  );

  // R / E / U on the message under the pointer (4.3 shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) {
        return;
      }
      const m = items.find((x) => x.seq === hovered.current);
      if (!m || m.deletedAt || m.kind === 'system') return;
      const k = e.key.toLowerCase();
      if (k === 'r') {
        e.preventDefault();
        handlers.onReply(m);
      } else if (k === 'e' && m.author?.id === me) {
        e.preventDefault();
        handlers.onEdit(m);
      } else if (k === 'u') {
        e.preventDefault();
        void act.markUnread(m);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, me, handlers, act]);

  const seenBy = useMemo(() => {
    const last = items.at(-1);
    if (!last || last.author?.id !== me || !reads?.length) return null;
    const who = reads.filter((r) => r.lastReadSeq >= last.seq && r.userId !== me);
    if (!who.length) return null;
    return { seq: last.seq, who };
  }, [items, reads, me]);

  // Only others' messages are unread; my own never are, and sending one reads everything
  // before it, so the divider goes away.
  const othersUnread =
    divider === null
      ? []
      : items.filter((m) => m.seq > divider && m.kind !== 'system' && m.author?.id !== me);
  const sentSinceDivider =
    divider !== null && items.some((m) => m.seq > openedAtSeq && m.author?.id === me);
  if (divider !== null && sentSinceDivider) setDivider(null);
  const unreadSinceDivider = othersUnread.length;
  // The divider sits above the first unread message from someone else.
  const dividerAt = othersUnread[0]?.seq ?? null;

  const typing = useTyping(conv.id);
  // The typing line keeps the last names while it fades out.
  const [typingShown, setTypingShown] = useState(typing);
  if (typing.length && typing !== typingShown) setTypingShown(typing);
  const typingLine = useExit(typing.length > 0);
  const jumpButton = useExit(showJump || Boolean(w?.hasNewer));
  const placeholder = t('chat.composer.placeholder', { name: conv.title });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) composer.current?.addFiles(files);
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') && conv.permissions.write) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div
        ref={scroller}
        onScroll={() => void onScroll()}
        onMouseOver={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-seq]');
          hovered.current = el ? Number(el.dataset.seq) : null;
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-3"
        role="log"
        aria-live="polite"
        aria-label={t('chat.pane.messages')}
      >
        {isPending ? (
          <div className="flex flex-col gap-5 p-6" aria-busy="true">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="w-28" />
                  <Skeleton className="h-10 w-80 rounded-2xl" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 && pending.length === 0 ? (
          <Starter conv={conv} onPick={(s) => composer.current?.insert(s)} />
        ) : (
          <div className="flex flex-col">
            {w?.hasMore ? (
              <div className="flex justify-center py-3 text-xs text-fg3">
                {t('chat.pane.loadingOlder')}
              </div>
            ) : (
              <div className="pt-4" />
            )}
            {items.map((m, i) => {
              const prev = items[i - 1];
              const newDay = !prev || !sameDay(prev.createdAt, m.createdAt);
              const showDivider = dividerAt !== null && m.seq === dividerAt && i > 0;
              const enter = enterOf(m);
              return (
                <Fragment key={m.id}>
                  {newDay ? (
                    <div
                      className={cn(
                        'flex items-center gap-3 px-6 pt-4 pb-1',
                        enter && 'animate-fade-in',
                      )}
                      role="separator"
                    >
                      <span className="h-px flex-1 bg-line" />
                      <span className="text-xs font-semibold text-fg2">
                        {dayLabel(m.createdAt, locale, now, (k) => t(`chat.time.${k}`))}
                      </span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null}
                  {showDivider ? (
                    <div
                      id="new-messages"
                      className="flex items-center gap-3 px-6 pt-3"
                      role="separator"
                    >
                      <span className="line-grow h-px flex-1 origin-right bg-accent" />
                      <span className="animate-fade-in text-xs font-bold text-accent-text">
                        {t('chat.pane.newMessages')}
                      </span>
                      <span className="line-grow h-px flex-1 origin-left bg-accent" />
                    </div>
                  ) : null}
                  {showDivider ? (
                    <ChatUnreadSummary
                      conversationId={conv.id}
                      afterSeq={divider ?? 0}
                      unread={unreadSinceDivider}
                    />
                  ) : null}
                  <MessageItem
                    m={m}
                    prev={newDay || showDivider ? undefined : prev}
                    conv={conv}
                    me={me}
                    quick={quick}
                    highlighted={highlight === m.seq}
                    enter={enter}
                    handlers={handlers}
                    seenBy={
                      seenBy?.seq === m.seq ? (
                        <span className="flex items-center gap-1.5 pt-1 text-[11px] text-fg3">
                          {conv.type === 'direct'
                            ? t('chat.pane.seenAt', {
                                time: formatTime(seenBy.who[0]?.at ?? m.createdAt, locale),
                              })
                            : t('chat.pane.seen')}
                          {conv.type !== 'direct'
                            ? seenBy.who
                                .slice(0, 8)
                                .map((r) => (
                                  <Avatar
                                    key={r.userId}
                                    name={nameOf(r.userId) ?? ''}
                                    size="sm"
                                    className="size-4 text-[7px]"
                                  />
                                ))
                            : null}
                        </span>
                      ) : undefined
                    }
                  />
                </Fragment>
              );
            })}
            {pending.map((p) => (
              <PendingItem key={p.clientMsgId} p={p} me={me} />
            ))}
          </div>
        )}
      </div>
      {jumpButton.mounted ? (
        <Button
          size="xs"
          variant="inv"
          data-state={jumpButton.state}
          className="absolute bottom-[96px] left-1/2 z-10 -translate-x-1/2 animate-pop-in shadow-overlay [--ch-dy:8px] data-[state=closed]:pointer-events-none data-[state=closed]:animate-pop-out"
          onClick={async () => {
            if (w?.hasNewer) await jumpToLatest(conv.id);
            atBottom.current = true;
            setShowJump(false);
            scrollToBottom();
          }}
        >
          <Icon name="arrow" size={14} className="rotate-90" />
          {t('chat.pane.jumpLatest')}
        </Button>
      ) : null}
      <div className="h-6 px-7 text-xs text-fg2" aria-live="polite">
        {typingLine.mounted ? (
          <span
            data-state={typingLine.state}
            data-testid="typing-line"
            className="inline-flex animate-pop-in items-center gap-1.5 [--ch-dy:4px] data-[state=closed]:animate-pop-out"
          >
            <span className="inline-flex gap-0.5" aria-hidden="true">
              <span className="typing-dot size-1 rounded-full bg-fg3" />
              <span className="typing-dot size-1 rounded-full bg-fg3 [animation-delay:.15s]" />
              <span className="typing-dot size-1 rounded-full bg-fg3 [animation-delay:.3s]" />
            </span>
            {typingShown.length === 1
              ? t('chat.typing.one', { name: firstName(nameOf(typingShown[0] ?? '') ?? '') })
              : typingShown.length === 2
                ? t('chat.typing.two', {
                    first: firstName(nameOf(typingShown[0] ?? '') ?? ''),
                    second: firstName(nameOf(typingShown[1] ?? '') ?? ''),
                  })
                : t('chat.typing.many', { count: typingShown.length })}
          </span>
        ) : null}
      </div>
      <SharedMeetingBanner conv={conv} />
      <SharedBanner conv={conv} />
      <Composer
        key={conv.id}
        ref={composer}
        conv={conv}
        me={me}
        reply={reply}
        onClearReply={() => setReply(null)}
        editing={editing}
        onDoneEdit={() => setEditing(null)}
        onEditLast={() => {
          if (lastOwn) setEditing(lastOwn);
        }}
        onSent={() => {
          atBottom.current = true;
          requestAnimationFrame(scrollToBottom);
        }}
        placeholder={placeholder}
      />
      {dragging ? (
        <div className="pointer-events-none absolute inset-3 z-20 flex animate-fade-in items-center justify-center rounded-2xl bg-bg/80 shadow-[inset_0_0_0_2px_var(--accent)]">
          <span className="flex items-center gap-2 text-sub font-semibold">
            <Icon name="upload" size={20} />
            {t('chat.pane.dropFiles')}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Empty chat (4.17): who it is with, who can see it, and starter chips that only fill the box. */
function Starter({ conv, onPick }: { conv: Conversation; onPick: (text: string) => void }) {
  const { t } = useI18n();
  const peer = conv.peer;
  return (
    <div className="m-auto flex max-w-[460px] flex-col items-center gap-3 px-6 py-10 text-center">
      {peer ? <PersonAvatar user={peer} size="xl" /> : null}
      <h2 className="m-0 text-h font-semibold">{conv.title}</h2>
      <p className="m-0 text-sm text-fg2">
        {conv.type === 'direct'
          ? t('chat.starter.direct')
          : conv.type === 'space'
            ? t('chat.starter.space', { space: conv.spaceName ?? '' })
            : t('chat.starter.group')}
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <Chip size="sm" onClick={() => onPick(t('chat.starter.hello'))}>
          👋 {t('chat.starter.hello')}
        </Chip>
        {peer ? (
          <Chip
            size="sm"
            onClick={() => onPick(t('chat.starter.welcome', { name: firstName(peer.name) }))}
          >
            {t('chat.starter.welcome', { name: firstName(peer.name) })}
          </Chip>
        ) : null}
      </div>
    </div>
  );
}

/** Shared channels: what is written here reaches other organizations' copies too. */
function SharedBanner({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const shared = conv.federation?.shared;
  if (!shared?.active) return null;
  const orgs = shared.orgs.filter((o) => o.status === 'active').map((o) => o.name ?? o.domain);
  return (
    <div className="mx-4 mb-1 flex items-center gap-2 rounded-md bg-bg2 px-3 py-1.5 text-xs text-fg2">
      <Icon name="globe" size={13} />
      <span>
        {shared.role === 'guest'
          ? t('federation.shared.bannerGuest', { org: orgs[0] ?? '' })
          : t('federation.shared.banner', { domains: orgs.join(', ') })}
      </span>
    </div>
  );
}

/**
 * Shared channels 2: the host organization's channel meeting, joined from this copy as a guest
 * on the host's servers (full-screen room over the chat).
 */
function SharedMeetingBanner({ conv }: { conv: Conversation }) {
  const { t } = useI18n();
  const meeting = conv.federation?.meeting;
  const [room, setRoom] = useState<SharedMeetingJoin | null>(null);
  const join = useMutation({
    mutationFn: () => api.call('joinSharedMeeting', { params: { conversationId: conv.id } }),
    onSuccess: setRoom,
    onError: (e) => toast.error(t(errorKey(e))),
  });
  if (room) {
    return (
      // Desktop app: the call starts under the window buttons (its bar is lower than them).
      <div data-desktop-overlay="below" className="fixed inset-0 z-50 flex flex-col bg-bg">
        <RoomView
          meeting={null}
          title={room.title}
          connection={room.connection}
          guest
          choices={{ audio: true, video: true }}
          onLeft={() => setRoom(null)}
        />
      </div>
    );
  }
  if (!meeting) return null;
  const org =
    conv.federation?.shared?.orgs.find((o) => o.domain === meeting.domain)?.name ?? meeting.domain;
  return (
    <div className="mx-4 mb-1 flex items-center gap-2 rounded-md bg-bg2 px-3 py-1.5 text-xs">
      <Icon name="video" size={13} />
      <span className="min-w-0 flex-1 truncate">
        {t('federation.shared.meetingLive', { org, title: meeting.title })}
      </span>
      <Button size="xs" variant="pri" loading={join.isPending} onClick={() => join.mutate()}>
        {t('federation.shared.meetingJoin')}
      </Button>
    </div>
  );
}
