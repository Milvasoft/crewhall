import { Avatar, Icon, IconButton } from '@crewhall/ui';
import { useChat } from '@livekit/components-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, isApiError } from '@/lib/api';
import { formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { useFail } from '@/components/meet/bits';
import { newId } from '@/lib/ids';
import { useRoomState, type GuestChatTicket } from './context';
import {
  guestChatQuery,
  meetChatKey,
  meetChatQuery,
  noMeetingChat,
  useMeetChatTarget,
} from './roomCues';

interface ChatLine {
  id: string;
  name: string;
  imageUrl: string | null;
  text: string;
  at: number;
  mine: boolean;
  guest?: boolean;
}

/**
 * Design 7.7: the meeting chat is the meeting's own conversation in the chat module (it
 * stays after the meeting); a one-to-one call uses the two people's direct chat. Until chat runs here, or for guests, the LiveKit data channel
 * carries live messages that end with the meeting.
 */
export function ChatPanel() {
  const { guestTicket } = useRoomState();
  // A one-to-one call talks in the two people's own chat (where it was started and ended).
  const { conversationId, pending } = useMeetChatTarget();
  const [moduleDown, setModuleDown] = useState(false);
  // Which chat it is depends on the call: wait for it (usually cached by the room already).
  if (pending) return null;
  if (guestTicket && !moduleDown) {
    return <GuestChat ticket={guestTicket} onUnavailable={() => setModuleDown(true)} />;
  }
  if (conversationId && !moduleDown) {
    return <ModuleChat conversationId={conversationId} onUnavailable={() => setModuleDown(true)} />;
  }
  return <LiveChat />;
}

function Frame({
  hint,
  lines,
  onSend,
}: {
  hint: string;
  lines: ChatLine[];
  onSend: (text: string) => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const state = useRoomState();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [lines.length]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    setSending(true);
    try {
      await onSend(v);
      setText('');
    } finally {
      setSending(false);
    }
  };
  return (
    <PanelShell title={t('meet.panels.chatTitle')} onClose={() => state.setPanel(null)} hint={hint}>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {lines.length ? null : (
          <p className="m-auto text-center text-sm text-fg3">{t('meet.chat.empty')}</p>
        )}
        {lines.map((l) => (
          <div key={l.id} className="flex gap-2.5">
            <Avatar name={l.name} src={l.imageUrl} size="md" />
            <div className="flex min-w-0 flex-col">
              <span className="text-xs">
                <span className="font-bold">{l.mine ? t('meet.chat.you') : l.name}</span>{' '}
                {l.guest ? (
                  <span className="rounded bg-bg2 px-1 text-[10px] text-fg2">
                    {t('meet.guest')}
                  </span>
                ) : null}{' '}
                <span className="text-fg3">{formatTime(new Date(l.at), locale)}</span>
              </span>
              <p className="text-sm break-words whitespace-pre-wrap">
                {l.text || <span className="text-fg3">{t('meet.chat.attachment')}</span>}
              </p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => void submit(e)}
        className="flex items-center gap-2 border-t border-line p-3"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('meet.chat.placeholder')}
          maxLength={4000}
          className="h-10 min-w-0 flex-1 rounded-lg bg-bg2 px-3 text-sm outline-none placeholder:text-fg3"
        />
        <IconButton
          type="submit"
          aria-label={t('meet.chat.send')}
          disabled={sending || !text.trim()}
        >
          <Icon name="send" size={16} />
        </IconButton>
      </form>
    </PanelShell>
  );
}

function LiveChat() {
  const { t } = useI18n();
  const { chatMessages, send } = useChat();
  const lines: ChatLine[] = chatMessages.map((m) => ({
    id: m.id,
    name: m.from?.name ?? m.from?.identity ?? '',
    imageUrl: null,
    text: m.message,
    at: m.timestamp,
    mine: Boolean(m.from?.isLocal),
  }));
  return (
    <Frame
      hint={t('meet.chat.liveHint')}
      lines={lines}
      onSend={async (text) => {
        await send(text);
      }}
    />
  );
}

function ModuleChat({
  conversationId,
  onUnavailable,
}: {
  conversationId: string;
  onUnavailable: () => void;
}) {
  const { t } = useI18n();
  const fail = useFail();
  const qc = useQueryClient();
  const key = meetChatKey(conversationId);
  const q = useQuery({ ...meetChatQuery(conversationId), refetchInterval: 3000 });
  useEffect(() => {
    if (q.error && (isApiError(q.error, 'not_implemented') || isApiError(q.error, 'not_found'))) {
      onUnavailable();
    }
  }, [q.error, onUnavailable]);
  const meId = useMe()?.user.id;
  const me = q.data;
  const lines: ChatLine[] = (me?.items ?? [])
    .filter((m) => !m.deletedAt && (m.author || m.guestAuthor))
    .map((m) => ({
      id: m.id,
      name: m.author?.name ?? m.guestAuthor?.name ?? '',
      imageUrl: m.author?.imageUrl ?? null,
      text: m.text,
      at: new Date(m.createdAt).getTime(),
      mine: m.author?.id === meId,
      guest: Boolean(m.guestAuthor),
    }))
    .sort((a, b) => a.at - b.at);
  return (
    <Frame
      hint={t('meet.chat.moduleHint')}
      lines={lines}
      onSend={async (text) => {
        try {
          await api.call('sendMessage', {
            params: { conversationId },
            body: { text, clientMsgId: newId(), attachmentNodeIds: [] },
          });
          await qc.invalidateQueries({ queryKey: key });
        } catch (e) {
          fail(e);
        }
      }}
    />
  );
}

/** The same chat as the members', for someone without an account. */
function GuestChat({
  ticket,
  onUnavailable,
}: {
  ticket: GuestChatTicket;
  onUnavailable: () => void;
}) {
  const { t } = useI18n();
  const fail = useFail();
  const qc = useQueryClient();
  const query = guestChatQuery(ticket);
  const q = useQuery({ ...query, refetchInterval: 3000 });
  useEffect(() => {
    if (noMeetingChat(q.error)) onUnavailable();
  }, [q.error, onUnavailable]);
  const lines: ChatLine[] = (q.data?.items ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    imageUrl: null,
    text: m.text,
    at: new Date(m.createdAt).getTime(),
    mine: m.mine,
    guest: m.guest,
  }));
  return (
    <Frame
      hint={t('meet.chat.moduleHint')}
      lines={lines}
      onSend={async (text) => {
        try {
          await api.call('sendGuestChat', {
            params: { requestId: ticket.requestId },
            body: { secret: ticket.secret, text, clientMsgId: newId() },
          });
          await qc.invalidateQueries({ queryKey: query.queryKey });
        } catch (e) {
          fail(e);
        }
      }}
    />
  );
}

export function PanelShell({
  title,
  hint,
  onClose,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    // Phones: a full-screen sheet above the stage (and above the soft keyboard).
    <aside className="flex w-[340px] shrink-0 flex-col overflow-hidden rounded-2xl bg-surface text-fg max-sm:fixed max-sm:inset-x-0 max-sm:top-[var(--window-bar,0px)] max-sm:bottom-[var(--kb,0px)] max-sm:z-40 max-sm:w-auto max-sm:rounded-none">
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-[15px] font-bold">{title}</h2>
          {hint ? <p className="text-xs text-fg3">{hint}</p> : null}
        </div>
        <IconButton size="sm" tone="plain" aria-label={t('common.actions.close')} onClick={onClose}>
          <Icon name="x" size={16} />
        </IconButton>
      </header>
      {children}
    </aside>
  );
}
