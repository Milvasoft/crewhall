import {
  Avatar,
  Badge,
  cn,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  toast,
  Tooltip,
} from '@crewhall/ui';
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ViaBadge } from '@/components/mcp/ViaBadge';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { excerptOf, nameOf } from '@/lib/chat/names';
import { attachmentProgress, discard, retry, type PendingMessage } from '@/lib/chat/outbox';
import { startsRun } from '@/lib/chat/text';
import { type Conversation, type Message, type SystemEvent } from '@/lib/chat/types';
import { callLength } from '@/components/meet/bits';
import { formatBytes, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { isReducedMotion } from '@/lib/motion';
import { jumboEmojis } from '@/lib/emoji/jumbo';
import { useMessageActions } from './actions';
import { JumboEmojis } from './AnimatedEmoji';
import { CardActions } from './CardActions';
import { LinkPreviewCard } from './LinkPreview';
import { RefCards } from './RefCards';
import { PersonAvatar } from './common';
import { openChatDialog } from './dialogs';
import { EmojiPicker } from './EmojiPicker';
import { AlertCardView, Attachments, MessageText, Quote, Reactions } from './MessageParts';
import { ENTER_CLASS, type MessageEnter } from './motion';
import { PersonHover } from './PersonCard';
import { GifView } from './gif';
import { PollCard } from './PollCard';

export interface MessageHandlers {
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onJump: (seq: number) => void;
}

/** "Cevapsız", "Reddedilen" or "Reddedilen · Meşgul" call line (older lines have no outcome). */
export function missedCallKey(e: SystemEvent) {
  const kind =
    e.callOutcome === 'declined' ? 'declined' : e.callOutcome === 'busy' ? 'busy' : 'missed';
  return `chat.system.call_${kind}${e.video ? 'Video' : ''}` as const;
}

function SystemLine({ e, at, enter }: { e: SystemEvent; at: string; enter?: MessageEnter }) {
  const { t, locale } = useI18n();
  const actor = e.actorId ? (nameOf(e.actorId) ?? t('chat.mention.unknown')) : '';
  const people = (e.userIds ?? []).map((id) => nameOf(id) ?? t('chat.mention.unknown')).join(', ');
  return (
    <div className={cn('flex justify-center px-6 py-1.5', enter && 'animate-fade-in')}>
      <span className="text-center text-xs text-fg2">
        {e.type === 'call_missed'
          ? t(missedCallKey(e), { actor })
          : e.type === 'call_ended'
            ? t(e.video ? 'chat.system.call_endedVideo' : 'chat.system.call_ended', {
                duration: callLength(e.durationSeconds ?? 0),
                people,
              })
            : e.type === 'created' && !people
              ? t('chat.system.createdAlone', { actor })
              : e.type === 'meeting_started' && !actor
                ? t('chat.system.meeting_startedAlone')
                : t(`chat.system.${e.type}`, {
                    actor,
                    people,
                    name: e.name ?? '',
                    minutes: Math.max(1, Math.round((e.durationSeconds ?? 0) / 60)),
                  })}
        {' · '}
        {formatTime(at, locale)}
      </span>
    </div>
  );
}

/** One message of the flow (4.1-4.3, 4.11): others left with avatar, mine right, bots with a card. */
export const MessageItem = memo(function MessageItem({
  m,
  prev,
  conv,
  me,
  quick,
  highlighted,
  enter,
  seenBy,
  handlers,
}: {
  m: Message;
  prev?: Message;
  conv: Conversation;
  me: string;
  quick: string[];
  highlighted: boolean;
  /** Set only for a message that just arrived (see useMessageEnter). */
  enter?: MessageEnter;
  seenBy?: ReactNode;
  handlers: MessageHandlers;
}) {
  const { t, locale } = useI18n();
  const act = useMessageActions();
  const row = useRef<HTMLDivElement>(null);
  const reactionsBar = useRef<HTMLDivElement>(null);
  const [burst, setBurst] = useState<Burst | null>(null);
  const endBurst = useCallback(() => setBurst(null), []);
  if (m.kind === 'system' && m.system) {
    return <SystemLine e={m.system} at={m.createdAt} enter={enter} />;
  }

  const mine = m.author?.id === me;
  const run = startsRun(prev, m);
  const deleted = m.deletedAt !== null;
  const canEdit = mine && !deleted && m.kind === 'user' && !m.poll;
  const canDelete = !deleted && (mine || conv.permissions.moderate);
  // Emoji-only messages (1-3) are shown large, without a bubble when nothing else is in it.
  const jumbo = !deleted && !m.poll && !m.emote && m.text ? jumboEmojis(m.text) : null;
  const bare = !!jumbo && !m.replyTo && !m.whisperTo && !m.card && !m.gif && !m.attachments.length;

  const copy = () =>
    void navigator.clipboard
      .writeText(excerptOf(m))
      .then(() => toast(t('chat.message.copied')))
      .catch(() => undefined);
  const del = () => openChatDialog({ kind: 'deleteMessage', message: m, others: !mine });

  // Double click on the bubble toggles the first quick reaction (like a double tap).
  const quickEmoji = deleted ? undefined : quick[0];
  const onBubbleMouseDown = (e: MouseEvent<HTMLElement>) => {
    // The second press would select a word; keep the text as it is.
    if (e.detail === 2 && quickEmoji && !skipsQuickReact(e.target)) e.preventDefault();
  };
  const onBubbleDoubleClick = (e: MouseEvent<HTMLElement>) => {
    if (!quickEmoji || skipsQuickReact(e.target)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const adding = !m.reactions.some((r) => r.emoji === quickEmoji && r.mine);
    void act.react(m, quickEmoji);
    const box = row.current?.getBoundingClientRect();
    const bar = reactionsBar.current?.getBoundingClientRect();
    if (!adding || !box || !bar || isReducedMotion()) return;
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const tx = (mine ? bar.right - 14 : bar.left + 14) - box.left;
    const ty = bar.top + 12 - box.top;
    setBurst({ key: Date.now(), emoji: quickEmoji, x, y, dx: tx - x, dy: ty - y });
  };

  const entries: ActionEntry[] = deleted
    ? []
    : [
        {
          kind: 'item',
          key: 'reply',
          icon: 'reply',
          label: t('chat.message.reply'),
          shortcut: 'R',
          onSelect: () => handlers.onReply(m),
        },
        {
          kind: 'item',
          key: 'fwd',
          icon: 'share',
          label: t('chat.message.forward'),
          onSelect: () => openChatDialog({ kind: 'forward', message: m }),
        },
        {
          kind: 'item',
          key: 'copy',
          icon: 'copy',
          label: t('chat.message.copy'),
          shortcut: 'Ctrl C',
          onSelect: copy,
        },
        {
          kind: 'item',
          key: 'link',
          icon: 'link',
          label: t('chat.message.copyLink'),
          onSelect: () => void act.copyLink(m),
        },
        { kind: 'sep', key: 's1' },
        ...(conv.permissions.pin && !m.whisperTo
          ? [
              {
                kind: 'item' as const,
                key: 'pin',
                icon: 'pin' as const,
                label: t(m.pinnedAt ? 'chat.message.unpin' : 'chat.message.pin'),
                onSelect: () => void act.pin(m),
              },
            ]
          : []),
        // "Mesaj bilgisi": only the author sees who read it.
        ...(mine && m.kind === 'user'
          ? [
              {
                kind: 'item' as const,
                key: 'info',
                icon: 'info' as const,
                label: t('chat.message.info'),
                onSelect: () => openChatDialog({ kind: 'messageInfo', message: m, conv }),
              },
            ]
          : []),
        {
          kind: 'item',
          key: 'unread',
          icon: 'eye',
          label: t('chat.message.markUnread'),
          shortcut: 'U',
          onSelect: () => void act.markUnread(m),
        },
        ...(canEdit || canDelete ? [{ kind: 'sep' as const, key: 's2' }] : []),
        ...(canEdit
          ? [
              {
                kind: 'item' as const,
                key: 'edit',
                icon: 'edit' as const,
                label: t('chat.message.edit'),
                shortcut: 'E',
                onSelect: () => handlers.onEdit(m),
              },
            ]
          : []),
        ...(canDelete
          ? [
              {
                kind: 'item' as const,
                key: 'del',
                icon: 'trash' as const,
                label: t('chat.message.delete'),
                danger: true,
                onSelect: del,
              },
            ]
          : []),
      ];

  const authorName = m.automation
    ? t('chat.message.automation')
    : (m.author?.name ?? m.webhook?.name ?? m.remoteAuthor?.name ?? m.guestAuthor?.name ?? '');
  const header =
    run && !mine ? (
      <div className={cn('flex items-center gap-2 pb-1', m.automation && 'flex-wrap gap-y-0')}>
        {m.author ? (
          <PersonHover userId={m.author.id}>
            <span className="text-[13px] font-bold hover:underline">{authorName}</span>
          </PersonHover>
        ) : (
          <span className="text-[13px] font-bold">{authorName}</span>
        )}
        {m.webhook ? (
          <Badge plain className="h-[18px] px-1.5 text-[10px]">
            {t('chat.message.bot')}
          </Badge>
        ) : null}
        {m.remoteAuthor ? (
          <Badge plain className="h-[18px] px-1.5 text-[10px]" title={m.remoteAuthor.address}>
            {m.remoteAuthor.domain}
          </Badge>
        ) : null}
        {m.guestAuthor ? (
          <Badge plain className="h-[18px] px-1.5 text-[10px]">
            {t('chat.message.guest')}
          </Badge>
        ) : null}
        <ViaBadge via={m.via} />
        <span className="text-[11.5px] text-fg3">{formatTime(m.createdAt, locale)}</span>
        {/* Automation bot (roadmap 17): the rule that posted it, under the name. */}
        {m.automation ? (
          <span className="basis-full text-[11.5px] text-fg2">{m.automation.ruleName}</span>
        ) : null}
      </div>
    ) : null;

  const body = deleted ? (
    <p className="m-0 flex items-center gap-1.5 text-[13.5px] text-fg3 italic">
      <Icon name="trash" size={13} />
      {t('chat.message.deleted')}
    </p>
  ) : (
    <div className="flex flex-col gap-2">
      {m.whisperTo ? (
        <span className="flex items-center gap-1 text-[11px] font-bold text-fg2">
          <Icon name="lock" size={11} />
          {m.whisperTo.id === me
            ? t('chat.whisper.toYou')
            : t('chat.whisper.to', { name: m.whisperTo.name })}
        </span>
      ) : null}
      {m.replyTo ? <Quote q={m.replyTo} onJump={handlers.onJump} /> : null}
      {m.card ? <AlertCardView card={m.card} /> : null}
      {m.card && m.kind === 'webhook' ? <CardActions m={m} conv={conv} /> : null}
      {m.gif ? <GifView gif={m.gif} /> : null}
      {m.poll ? (
        <PollCard m={m} poll={m.poll} me={me} conv={conv} />
      ) : m.emote && m.text ? (
        <div className="flex flex-wrap items-baseline gap-x-1.5 text-fg2 italic">
          <span className="text-[14px] font-bold not-italic">* {authorName}</span>
          <MessageText text={m.text} me={me} />
        </div>
      ) : jumbo ? (
        <JumboEmojis emojis={jumbo} />
      ) : m.text ? (
        <MessageText text={m.text} me={me} />
      ) : null}
      {m.refs?.length ? <RefCards refs={m.refs} /> : null}
      {m.linkPreview ? (
        <LinkPreviewCard
          messageId={m.id}
          preview={m.linkPreview}
          canRemove={m.kind === 'user' && !!m.author && m.author.id === me}
        />
      ) : null}
      {m.attachments.length ? (
        <div data-no-quick-react="">
          <Attachments m={m} />
        </div>
      ) : null}
    </div>
  );

  return (
    <ActionContextMenu entries={entries}>
      <div
        ref={row}
        id={`msg-${m.seq}`}
        data-seq={m.seq}
        data-enter={enter}
        className={cn(
          'group/msg relative flex gap-2.5 px-6 transition-colors duration-500',
          run ? 'pt-2.5' : 'pt-0.5',
          mine ? 'flex-row-reverse' : '',
          highlighted && 'bg-accent10 duration-150',
          enter && ENTER_CLASS[enter],
        )}
      >
        {!mine ? (
          <div className="w-9 shrink-0">
            {run ? (
              m.author ? (
                <PersonAvatar user={m.author} size="base" />
              ) : m.automation ? (
                <span className="flex size-9 items-center justify-center rounded-full bg-accent text-accent-fg">
                  <Icon name="zap" size={18} />
                </span>
              ) : (
                <Avatar name={authorName} src={m.webhook?.avatarUrl} size="base" />
              )
            ) : null}
          </div>
        ) : null}
        <div
          className={cn(
            'relative flex min-w-0 max-w-[min(680px,78%)] flex-col',
            mine ? 'items-end' : 'items-start',
          )}
        >
          {header}
          {mine && run ? (
            <span className="flex items-center gap-2 pb-1">
              <ViaBadge via={m.via} />
              <span className="text-[11.5px] text-fg3">{formatTime(m.createdAt, locale)}</span>
            </span>
          ) : null}
          <div
            data-quick-react={quickEmoji ? '' : undefined}
            onMouseDown={onBubbleMouseDown}
            onDoubleClick={onBubbleDoubleClick}
            className={cn(
              'relative max-w-full min-w-0 rounded-2xl px-3.5 py-2',
              ((m.card || m.gif) && !m.text) || bare
                ? 'bg-transparent p-0'
                : mine
                  ? 'bg-capsule'
                  : 'bg-bg2',
              m.pinnedAt && 'shadow-[inset_0_0_0_1px_var(--line2)]',
              m.whisperTo && !deleted && 'bg-transparent outline-1 outline-line2 outline-dashed',
            )}
          >
            {body}
            {m.editedAt && !deleted ? (
              <span className="ml-1 text-[11px] text-fg3">{t('chat.message.edited')}</span>
            ) : null}
            {m.pinnedAt && !deleted ? (
              <Tooltip content={t('chat.message.pinnedHint')}>
                <span className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-bg text-fg2 shadow-line">
                  <Icon name="pin" size={10} />
                </span>
              </Tooltip>
            ) : null}
          </div>
          {!deleted ? (
            <div ref={reactionsBar} className="pt-1">
              <Reactions reactions={m.reactions} onToggle={(e) => void act.react(m, e)} />
            </div>
          ) : null}
          {seenBy}
          {!deleted ? (
            <Toolbar
              mine={mine}
              quick={quick}
              entries={entries}
              onReact={(e) => void act.react(m, e)}
              onReply={() => handlers.onReply(m)}
            />
          ) : null}
        </div>
        {burst ? <ReactionBurst key={burst.key} b={burst} onDone={endBurst} /> : null}
      </div>
    </ActionContextMenu>
  );
});

interface Burst {
  key: number;
  emoji: string;
  /** Start (the pointer) relative to the row, and the way to the reaction bar. */
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Links, buttons, mentions, code and attachments keep their own double click. */
function skipsQuickReact(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'a, button, input, textarea, select, [role="button"], [data-mention], [data-no-quick-react], pre, code',
      ),
    )
  );
}

/** The emoji pops where the double click landed, then flies into the reaction bar. */
function ReactionBurst({ b, onDone }: { b: Burst; onDone: () => void }) {
  const el = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!node || typeof node.animate !== 'function') {
      onDone();
      return;
    }
    const center = 'translate(-50%, -50%)';
    const a = node.animate(
      [
        { transform: `${center} scale(0.3)`, opacity: 0 },
        { transform: `${center} scale(1.35)`, opacity: 1, offset: 0.22 },
        { transform: `${center} scale(1)`, opacity: 1, offset: 0.42 },
        {
          transform: `translate(calc(-50% + ${b.dx}px), calc(-50% + ${b.dy}px)) scale(0.45)`,
          opacity: 0.15,
        },
      ],
      { duration: 720, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' },
    );
    a.onfinish = onDone;
    return () => a.cancel();
  }, [b, onDone]);
  return (
    <span
      ref={el}
      aria-hidden="true"
      data-testid="reaction-burst"
      className="pointer-events-none absolute z-20 text-[30px] leading-none select-none"
      style={{ left: b.x, top: b.y }}
    >
      {b.emoji}
    </span>
  );
}

/** Hover tools (4.2): last five reactions, picker, reply, and the menu with the emoji row (4.3). */
function Toolbar({
  mine,
  quick,
  entries,
  onReact,
  onReply,
}: {
  mine: boolean;
  quick: string[];
  entries: ActionEntry[];
  onReact: (emoji: string) => void;
  onReply: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={cn(
        'absolute -top-4 z-10 hidden animate-[ch-pop-in_var(--t-fast)_var(--ease-out-std)_both] items-center gap-0.5 rounded-full bg-bg p-0.5 shadow-[0_0_0_1px_var(--line),0_4px_14px_rgba(0,0,0,.12)] [--ch-dy:4px] group-hover/msg:flex has-[[data-state=open]]:flex',
        mine ? 'right-0' : 'left-[calc(100%-120px)]',
      )}
    >
      {quick.map((e) => (
        <button
          key={e}
          type="button"
          aria-label={t('chat.reactions.add', { emoji: e })}
          onClick={() => onReact(e)}
          className="flex size-7 items-center justify-center rounded-full text-[15px] transition-[background-color,scale] duration-(--t-fast) hover:scale-115 hover:bg-bg2 active:scale-95"
        >
          {e}
        </button>
      ))}
      <EmojiPicker onPick={onReact}>
        <IconButton size="xs" tone="plain" aria-label={t('chat.reactions.picker')}>
          <Icon name="smile" size={15} />
        </IconButton>
      </EmojiPicker>
      <IconButton size="xs" tone="plain" aria-label={t('chat.message.reply')} onClick={onReply}>
        <Icon name="reply" size={15} />
      </IconButton>
      <Menu>
        <MenuTrigger asChild>
          <IconButton size="xs" tone="plain" aria-label={t('chat.message.more')}>
            <Icon name="dots" size={15} />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end" className="w-[260px]">
          <div className="flex items-center justify-between px-1 pb-1">
            {quick.map((e) => (
              <MenuItem
                key={e}
                aria-label={t('chat.reactions.add', { emoji: e })}
                onSelect={() => onReact(e)}
                className="size-8 justify-center p-0 text-[17px]"
              >
                {e}
              </MenuItem>
            ))}
          </div>
          <MenuSeparator />
          {entries.map((e) =>
            e.kind === 'sep' ? (
              <MenuSeparator key={e.key} />
            ) : e.kind === 'item' ? (
              <MenuItem
                key={e.key}
                icon={e.icon}
                shortcut={e.shortcut}
                danger={e.danger}
                onSelect={e.onSelect}
              >
                {e.label}
              </MenuItem>
            ) : null,
          )}
        </MenuContent>
      </Menu>
    </div>
  );
}

/** A queued message (4.18): faded with a clock, or refused with retry and discard. */
export function PendingItem({ p, me }: { p: PendingMessage; me: string }) {
  const { t, locale } = useI18n();
  return (
    <div
      className="msg-in-mine flex flex-row-reverse gap-2.5 px-6 pt-1.5"
      data-pending={p.clientMsgId}
    >
      <div className="flex max-w-[min(680px,78%)] flex-col items-end">
        <div
          className={cn(
            'rounded-2xl bg-capsule px-3.5 py-2 transition-opacity duration-(--t-base)',
            p.status !== 'failed' && 'opacity-60',
          )}
        >
          {p.replyTo ? <Quote q={p.replyTo} /> : null}
          {p.text ? <MessageText text={p.text} me={me} /> : null}
          {p.refs?.length ? <RefCards refs={p.refs} /> : null}
          {p.attachments.map((a) => {
            const prog = attachmentProgress(a);
            const stalled = ['error', 'paused', 'interrupted', 'canceled'].includes(prog.status);
            return (
              <div key={a.uploadId} className="mt-1.5 flex items-center gap-2 text-xs text-fg2">
                <Icon name="file" size={14} />
                <span className="truncate font-semibold">{a.name}</span>
                <span>
                  {stalled
                    ? t('chat.pending.uploadStalled', {
                        done: formatBytes(prog.loaded, locale),
                        total: formatBytes(a.size, locale),
                      })
                    : `${formatBytes(prog.loaded, locale)} / ${formatBytes(a.size, locale)}`}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-2 pt-1 text-[11.5px] text-fg3">
          {p.status === 'failed' ? (
            <>
              <span className="animate-fade-in font-semibold text-danger">
                {t('chat.pending.failed')}
                {p.error ? ` · ${t(`errors.${p.error}`)}` : ''}
              </span>
              <button
                type="button"
                className="font-semibold text-fg hover:underline"
                onClick={() =>
                  retry(p.clientMsgId, {
                    confirmMentionAll: p.error === 'chat_mention_all_confirm',
                    dlpAck: p.error === 'dlp_warning',
                  })
                }
              >
                {p.error === 'chat_mention_all_confirm' || p.error === 'dlp_warning'
                  ? t('chat.pending.confirmSend')
                  : t('chat.pending.retry')}
              </button>
              <button
                type="button"
                className="hover:underline"
                onClick={() => discard(p.clientMsgId)}
              >
                {t('chat.pending.discard')}
              </button>
            </>
          ) : (
            // Quick sends never show the clock: it fades in only if sending takes a while.
            <span className="flex animate-[ch-fade-in_var(--t-base)_ease-out_600ms_both] items-center gap-2">
              <Icon name="clock" size={12} />
              {t('chat.pending.waiting')}
              {p.attachments.length ? (
                <button
                  type="button"
                  className="font-semibold text-fg hover:underline"
                  onClick={() => retry(p.clientMsgId)}
                >
                  {t('chat.pending.retry')}
                </button>
              ) : null}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
