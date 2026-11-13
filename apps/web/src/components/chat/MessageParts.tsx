import { parseChatInline, parseChatText, type ChatInline } from '@crewhall/shared';
import { Badge, cn, Icon, IconButton, Spinner, toast, Tooltip } from '@crewhall/ui';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState } from 'react';
import { badgeOf } from '@/features/drive/fileKinds';
import { api } from '@/lib/api';
import { nameOf } from '@/lib/chat/names';
import { ALL, HERE } from '@/lib/chat/text';
import {
  type AlertCard,
  type Message,
  type MessageAttachment,
  type QuotedMessage,
  type ReactionSummary,
} from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { formatBytes } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useArrivals, useChangeCount, useReducedMotion } from '@/lib/motion';
import { canView, openViewer, type ViewerSource } from '@/lib/viewer';
import { PersonHover } from './PersonCard';

/**
 * Message text: fenced code, paragraphs, lists and inline formatting (parseChatText); never
 * HTML, every node is a React element.
 */
export function MessageText({ text, me }: { text: string; me: string }) {
  const blocks = useMemo(() => parseChatText(text), [text]);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((b, i) => {
        if (b.kind === 'code') return <CodeBlock key={i} code={b.text} lang={b.lang} />;
        if (b.kind === 'paragraph') {
          return (
            <p key={i} className="m-0 text-[14px] leading-[21px] break-words whitespace-pre-wrap">
              <InlineNodes nodes={b.children} me={me} />
            </p>
          );
        }
        const List = b.ordered ? 'ol' : 'ul';
        return (
          <List
            key={i}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={cn(
              'm-0 flex flex-col gap-0.5 pl-5 text-[14px] leading-[21px] break-words',
              b.ordered ? 'list-decimal' : 'list-disc',
            )}
          >
            {b.items.map((item, j) => (
              <li key={j} className="pl-0.5 whitespace-pre-wrap">
                <InlineNodes nodes={item} me={me} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/** One line of message-like text (announcements, quotes): inline formatting only. */
export function Inline({ text, me }: { text: string; me: string }) {
  const nodes = useMemo(() => parseChatInline(text), [text]);
  return <InlineNodes nodes={nodes} me={me} />;
}

const MARK_TAG = { bold: 'strong', italic: 'em', strike: 's' } as const;

function InlineNodes({ nodes, me }: { nodes: ChatInline[]; me: string }) {
  const { t } = useI18n();
  return (
    <>
      {nodes.map((p, i) => {
        if (p.kind === 'text') return <Fragment key={i}>{p.text}</Fragment>;
        if ('children' in p) {
          const Tag = MARK_TAG[p.kind];
          return (
            <Tag key={i} className={p.kind === 'bold' ? 'font-bold' : undefined}>
              <InlineNodes nodes={p.children} me={me} />
            </Tag>
          );
        }
        if (p.kind === 'code') {
          return (
            <code key={i} className="rounded-[5px] bg-fg/[.07] px-1 py-px font-mono text-[12.5px]">
              {p.text}
            </code>
          );
        }
        if (p.kind === 'link') {
          return (
            <a
              key={i}
              href={p.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-info underline-offset-2 hover:underline"
            >
              {p.url}
            </a>
          );
        }
        const group = p.userId === ALL || p.userId === HERE;
        const label = group
          ? t(p.userId === ALL ? 'chat.mention.all' : 'chat.mention.here')
          : `@${nameOf(p.userId) ?? t('chat.mention.unknown')}`;
        const chip = (
          <span
            data-mention=""
            className={cn(
              'rounded-[5px] px-1 font-semibold',
              group || p.userId === me
                ? 'bg-accent text-accent-fg'
                : 'bg-accent10 text-accent-text',
            )}
          >
            {label}
          </span>
        );
        return group ? (
          <Fragment key={i}>{chip}</Fragment>
        ) : (
          <PersonHover key={i} userId={p.userId}>
            {chip}
          </PersonHover>
        );
      })}
    </>
  );
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { t } = useI18n();
  return (
    <div className="group/code relative overflow-hidden rounded-md bg-fg/[.06] shadow-line">
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/code:opacity-100">
        {lang ? <span className="font-mono text-[10.5px] text-fg3 uppercase">{lang}</span> : null}
        <IconButton
          size="xs"
          tone="plain"
          aria-label={t('chat.message.copyCode')}
          onClick={() =>
            void navigator.clipboard
              .writeText(code)
              .then(() => toast(t('chat.message.codeCopied')))
              .catch(() => undefined)
          }
        >
          <Icon name="copy" size={13} />
        </IconButton>
      </div>
      <pre className="m-0 overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[19px]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Alarm card of a webhook message (4.11): the left edge carries the severity. */
export function AlertCardView({ card }: { card: AlertCard }) {
  const { t } = useI18n();
  const tone = {
    critical: 'danger',
    warning: 'warn',
    success: 'ok',
    info: 'info',
  } as const;
  const edge = {
    critical: 'before:bg-danger',
    warning: 'before:bg-warning',
    success: 'before:bg-success',
    info: 'before:bg-info',
  }[card.severity];
  return (
    <div
      className={cn(
        "relative flex max-w-[560px] flex-col gap-2 overflow-hidden rounded-lg bg-bg py-3 pr-3.5 pl-4 shadow-line before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        edge,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone[card.severity]}>{t(`chat.severity.${card.severity}`)}</Badge>
        <span className="text-[14px] font-bold">{card.title}</span>
      </div>
      {card.subtitle ? <span className="text-cap text-fg2">{card.subtitle}</span> : null}
      {card.text ? <p className="m-0 text-cap whitespace-pre-wrap">{card.text}</p> : null}
      {card.fields.length ? (
        <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-4 gap-y-1.5">
          {card.fields.map((f, i) => (
            <div key={i} className="flex min-w-0 flex-col">
              <dt className="truncate text-[11px] font-semibold text-fg3 uppercase">{f.label}</dt>
              <dd className="m-0 truncate text-cap font-semibold">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {card.buttons.length ? (
        <div className="flex flex-wrap gap-2 pt-0.5">
          {card.buttons.map((b, i) => (
            <a
              key={i}
              href={b.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-[30px] items-center gap-1.5 rounded-sm px-2.5 text-[12.5px] font-semibold shadow-line2 hover:bg-bg2"
            >
              {b.text}
              <Icon name="ext" size={13} />
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Quote inside a reply (4.2); clicking jumps to the original. */
export function Quote({ q, onJump }: { q: QuotedMessage; onJump?: (seq: number) => void }) {
  const { t } = useI18n();
  const who = q.author?.name ?? q.webhookName ?? q.guestAuthor?.name ?? '';
  return (
    <button
      type="button"
      onClick={() => onJump?.(q.seq)}
      className="flex w-full max-w-[420px] min-w-0 flex-col items-start rounded-md bg-fg/[.05] px-3 py-1.5 text-left shadow-[inset_3px_0_0_var(--line2)] hover:bg-fg/[.08]"
    >
      <span className="text-xs font-bold">{who}</span>
      <span className="block w-full max-w-[396px] truncate text-xs text-fg2">
        {q.deleted
          ? t('chat.message.deleted')
          : q.excerpt || (q.hasAttachments ? t('chat.list.attachment') : '')}
      </span>
    </button>
  );
}

type PreviewSize = 'thumb_256' | 'thumb_1024' | 'poster';

const thumbKey = (messageId: string, nodeId: string, size: PreviewSize) =>
  ['chat', 'thumb', messageId, nodeId, size] as const;

function thumbQuery(messageId: string, a: MessageAttachment, size: PreviewSize) {
  return {
    queryKey: thumbKey(messageId, a.nodeId, size),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api
        .call('getChatAttachmentUrl', {
          params: { messageId, nodeId: a.nodeId },
          query: { preview: size },
          signal,
        })
        .then((r) => r.url),
    enabled: a.preview === 'ready' && !a.removed,
    staleTime: 4 * 60_000,
  };
}

/** Box of a media preview: the picture's own shape inside 280 × 260. */
function boxOf(ratio: number | null): { width: number; height: number } {
  if (!ratio) return { width: 240, height: 180 };
  const w = ratio >= 280 / 260 ? 280 : Math.max(96, 260 * ratio);
  return { width: Math.round(w), height: Math.round(Math.max(96, Math.min(260, w / ratio))) };
}

/**
 * Image or video preview in a message: a small blurred picture first, the sharp thumbnail
 * fades in over it, both in the picture's own aspect ratio. The full size is the viewer's.
 */
function Thumb({ messageId, a }: { messageId: string; a: MessageAttachment }) {
  const video = a.mime?.startsWith('video/') ?? false;
  const small = useQuery(thumbQuery(messageId, a, video ? 'poster' : 'thumb_256'));
  const sharp = useQuery({
    ...thumbQuery(messageId, a, 'thumb_1024'),
    enabled: !video && small.isSuccess,
  });
  const [ratio, setRatio] = useState<number | null>(null);
  const [sharpIn, setSharpIn] = useState(false);
  const noteRatio = (img: HTMLImageElement) => {
    if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight);
  };
  return (
    <span className="relative block overflow-hidden bg-bg2" style={boxOf(ratio)}>
      {small.data ? (
        <img
          src={small.data}
          alt=""
          onLoad={(e) => noteRatio(e.currentTarget)}
          className={cn(
            'absolute inset-0 size-full object-cover transition-[filter] duration-300',
            !video && !sharpIn && 'scale-105 blur-md',
          )}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-fg3">
          {a.preview === 'pending' ? <Spinner size={16} /> : <Icon name="image" size={22} />}
        </span>
      )}
      {sharp.data ? (
        <img
          src={sharp.data}
          alt=""
          data-sharp=""
          onLoad={() => setSharpIn(true)}
          className={cn(
            'absolute inset-0 size-full object-cover transition-opacity duration-300',
            sharpIn ? 'opacity-100' : 'opacity-0',
          )}
        />
      ) : null}
    </span>
  );
}

async function attachmentUrl(messageId: string, a: MessageAttachment, inline: boolean) {
  const res = await api.call('getChatAttachmentUrl', {
    params: { messageId, nodeId: a.nodeId },
    query: { disposition: inline ? 'inline' : 'attachment' },
  });
  return res.url;
}

/** What the shared viewer needs to show a chat attachment. */
function viewerSource(qc: QueryClient, m: Message, a: MessageAttachment): ViewerSource {
  const thumb =
    qc.getQueryData<string>(thumbKey(m.id, a.nodeId, 'thumb_1024')) ??
    qc.getQueryData<string>(
      thumbKey(m.id, a.nodeId, a.mime?.startsWith('video/') ? 'poster' : 'thumb_256'),
    );
  return {
    key: `chat:${m.id}:${a.nodeId}`,
    name: a.name,
    mime: a.mime,
    sizeBytes: a.sizeBytes,
    thumb: thumb ?? null,
    url: () => attachmentUrl(m.id, a, true),
    download: () => attachmentUrl(m.id, a, false),
    link: `/chat/c/${m.conversationId}?seq=${m.seq}`,
  };
}

export function Attachments({ m }: { m: Message }) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const media = m.attachments.filter(
    (a) => !a.removed && (a.mime?.startsWith('image/') || a.mime?.startsWith('video/')),
  );
  const files = m.attachments.filter((a) => !media.includes(a));

  const qc = useQueryClient();
  const open = async (a: MessageAttachment, inline: boolean) => {
    setBusy(a.nodeId);
    try {
      window.location.assign(await attachmentUrl(m.id, a, inline));
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(null);
    }
  };
  // Images, videos and PDFs open in the app's viewer (never a new tab or the browser).
  const view = (a: MessageAttachment, from: Element) => {
    const list = media.includes(a) ? media : [a];
    openViewer(
      list.map((x) => viewerSource(qc, m, x)),
      list.indexOf(a),
      from.querySelector('img') ?? from,
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {media.length ? (
        <div className="flex flex-wrap gap-1.5">
          {media.map((a) => (
            <button
              key={a.nodeId}
              type="button"
              data-no-quick-react=""
              onClick={(e) => view(a, e.currentTarget)}
              aria-label={t('chat.attachment.open', { name: a.name })}
              className="press relative overflow-hidden rounded-lg bg-bg2 shadow-line"
            >
              <Thumb messageId={m.id} a={a} />
              {a.mime?.startsWith('video/') ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex size-11 items-center justify-center rounded-full bg-black/60 text-white">
                    <Icon name="play" size={20} />
                  </span>
                </span>
              ) : null}
              <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2.5 pt-5 pb-1.5 text-left text-[11.5px] font-semibold text-white">
                {a.name} · {formatBytes(a.sizeBytes, locale)}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {files.map((a) =>
        a.removed ? (
          <div
            key={a.nodeId}
            className="flex w-[320px] items-center gap-2.5 rounded-lg px-3 py-2.5 text-cap text-fg3 shadow-line"
          >
            <Icon name="file" size={18} />
            <span className="truncate line-through">{a.name}</span>
            <span className="ml-auto shrink-0">{t('chat.attachment.removed')}</span>
          </div>
        ) : (
          <div
            key={a.nodeId}
            className="flex w-[320px] max-w-full items-center gap-2.5 rounded-lg bg-bg px-3 py-2 shadow-line"
          >
            <span className="flex h-8 min-w-8 shrink-0 items-center justify-center rounded-sm bg-bg2 px-1 font-mono text-[10px] font-bold text-fg2">
              {badgeOf(a.name)}
            </span>
            <button
              type="button"
              onClick={(e) =>
                canView(a.mime, a.name) ? view(a, e.currentTarget) : void open(a, false)
              }
              className="flex min-w-0 flex-1 flex-col text-left"
            >
              <span className="truncate text-cap font-semibold hover:underline">{a.name}</span>
              <span className="text-xs text-fg2">{formatBytes(a.sizeBytes, locale)}</span>
            </button>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('chat.attachment.download', { name: a.name })}
              disabled={busy === a.nodeId}
              onClick={() => void open(a, false)}
            >
              <Icon name="download" size={15} />
            </IconButton>
          </div>
        ),
      )}
    </div>
  );
}

export function Reactions({
  reactions,
  onToggle,
  onAdd,
}: {
  reactions: ReactionSummary[];
  onToggle: (emoji: string) => void;
  onAdd?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const keys = useMemo(() => reactions.map((r) => r.emoji), [reactions]);
  const arrived = useArrivals(keys, { max: 2 });
  if (reactions.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <ReactionChip
          key={r.emoji}
          r={r}
          fresh={!reduced && arrived.has(r.emoji)}
          onToggle={onToggle}
        />
      ))}
      {onAdd}
    </div>
  );
}

/** One reaction: pops in when someone adds it, the count bumps when it changes. */
function ReactionChip({
  r,
  fresh,
  onToggle,
}: {
  r: ReactionSummary;
  fresh: boolean;
  onToggle: (emoji: string) => void;
}) {
  const { t } = useI18n();
  const bumps = useChangeCount(r.count);
  // People on other installations come by name (federation, shared channels).
  const names = [...r.userIds.map((id) => nameOf(id) ?? '…'), ...(r.remoteNames ?? [])];
  return (
    <Tooltip content={t('chat.reactions.who', { names: names.join(', '), emoji: r.emoji })}>
      <button
        type="button"
        aria-pressed={r.mine}
        data-fresh={fresh || undefined}
        onClick={() => onToggle(r.emoji)}
        className={cn(
          'press inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-semibold',
          r.mine
            ? 'bg-accent10 text-fg shadow-[inset_0_0_0_1.5px_var(--accent)]'
            : 'bg-bg2 text-fg2 hover:bg-capsule',
          fresh && 'animate-pop',
        )}
      >
        <span>{r.emoji}</span>
        <span key={bumps} className={cn('inline-block tn', bumps > 0 && 'animate-bump')}>
          {r.count}
        </span>
      </button>
    </Tooltip>
  );
}
