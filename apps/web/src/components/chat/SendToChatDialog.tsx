import { type MessageRef } from '@crewhall/shared';
import { DialogContent, DialogHeader, Input, toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { chatKeys, conversationsQuery } from '@/lib/chat/queries';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';
import { membersQuery } from '@/lib/queries';
import { ConversationAvatar, PersonAvatar, useMyId } from './common';

/**
 * "Sohbete gönder": a reference to an item goes to a chat or a person, with an optional note.
 * No public link and no share is made: whoever opens it sees it only with their own rights.
 */
export function SendToChatBody({
  target,
  title,
  onClose,
}: {
  target: MessageRef;
  title: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const me = useMyId();
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const term = q.trim().toLocaleLowerCase(locale);
  const { data } = useQuery(conversationsQuery);
  const { data: people } = useQuery(membersQuery({ q: q.trim() || undefined, status: 'active' }));
  // Chats shared with another installation are left out: their people could not open it.
  const chats = useMemo(
    () =>
      (data ?? []).filter(
        (c) =>
          c.permissions.write &&
          !c.archivedAt &&
          !c.federation &&
          (!term || c.title.toLocaleLowerCase(locale).includes(term)),
      ),
    [data, term, locale],
  );
  const direct = new Set(chats.filter((c) => c.type === 'direct').map((c) => c.title));
  const others = (people?.items ?? [])
    .filter((m) => m.user.id !== me && !direct.has(m.user.name))
    .slice(0, 6);

  const send = async (to: { conversationId: string } | { userId: string }, name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const conversationId =
        'conversationId' in to
          ? to.conversationId
          : (
              await api.call('createConversation', {
                body: { type: 'direct', userId: to.userId },
              })
            ).id;
      await api.call('sendMessage', {
        params: { conversationId },
        body: { clientMsgId: newId(), text: note.trim(), refs: [target] },
      });
      void qc.invalidateQueries({ queryKey: chatKeys.conversations });
      toast(t('chat.refs.sent', { name }));
      onClose();
    } catch (e) {
      toast.error(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent width={460}>
      <DialogHeader title={t('chat.refs.sendToChat')} description={title} />
      <p className="m-0 text-xs text-fg2">{t('chat.refs.sendHint')}</p>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        placeholder={t('chat.refs.sendNote')}
        aria-label={t('chat.refs.sendNote')}
      />
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('chat.refs.sendSearch')}
        aria-label={t('chat.refs.sendSearch')}
        autoFocus
      />
      <ul
        aria-label={t('chat.refs.sendTargets')}
        className="m-0 flex max-h-[280px] list-none flex-col overflow-y-auto p-0"
      >
        {chats.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={busy}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
              onClick={() => void send({ conversationId: c.id }, c.title)}
            >
              <ConversationAvatar conv={c} size="md" />
              <span className="truncate text-cap font-semibold">{c.title}</span>
            </button>
          </li>
        ))}
        {others.map((m) => (
          <li key={m.user.id}>
            <button
              type="button"
              disabled={busy}
              className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-bg2"
              onClick={() => void send({ userId: m.user.id }, m.user.name)}
            >
              <PersonAvatar user={m.user} size="md" card={false} />
              <span className="truncate text-cap font-semibold">{m.user.name}</span>
            </button>
          </li>
        ))}
        {chats.length === 0 && others.length === 0 ? (
          <li className="px-2 py-4 text-center text-cap text-fg2">{t('chat.refs.sendNone')}</li>
        ) : null}
      </ul>
    </DialogContent>
  );
}
