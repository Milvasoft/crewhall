import { paths, withQuery } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import {
  applyReaction,
  noteMyRead,
  patchMessage,
  putMessages,
  upsertConversation,
} from '@/lib/chat/cache';
import { chatKeys } from '@/lib/chat/queries';
import { holdUnread } from '@/lib/chat/runtime';
import { type Message } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';

/** Writes from chat screens: optimistic where the socket would echo anyway, toasts on errors. */

export function useOpenDirect() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { t } = useI18n();
  return useCallback(
    async (userId: string) => {
      try {
        const conv = await api.call('createConversation', { body: { type: 'direct', userId } });
        upsertConversation(qc, conv);
        await navigate({ to: '/chat/c/$conversationId', params: { conversationId: conv.id } });
      } catch (e) {
        toast.error(t(errorKey(e)));
      }
    },
    [qc, navigate, t],
  );
}

export function useMessageActions() {
  const qc = useQueryClient();
  const { t } = useI18n();
  const me = useMe()?.user.id ?? '';

  const fail = useCallback((e: unknown) => toast.error(t(errorKey(e))), [t]);

  const apply = useCallback(
    (m: Message) => {
      putMessages(qc, m.conversationId, [m]);
      patchMessage(qc, m.conversationId, m.id, () => m);
    },
    [qc],
  );

  return {
    react: async (m: Message, emoji: string) => {
      const on = !m.reactions.some((r) => r.emoji === emoji && r.mine);
      patchMessage(qc, m.conversationId, m.id, (x) => applyReaction(x, emoji, me, on, me));
      try {
        const res = await api.call(on ? 'addReaction' : 'removeReaction', {
          params: { messageId: m.id },
          body: { emoji },
        });
        apply(res);
        if (on) void qc.invalidateQueries({ queryKey: chatKeys.settings });
      } catch (e) {
        patchMessage(qc, m.conversationId, m.id, (x) => applyReaction(x, emoji, me, !on, me));
        fail(e);
      }
    },
    edit: async (m: Message, text: string) => {
      try {
        apply(await api.call('updateMessage', { params: { messageId: m.id }, body: { text } }));
        return true;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    remove: async (m: Message) => {
      try {
        apply(await api.call('deleteMessage', { params: { messageId: m.id } }));
      } catch (e) {
        fail(e);
      }
    },
    pin: async (m: Message) => {
      try {
        const res = await api.call(m.pinnedAt ? 'unpinMessage' : 'pinMessage', {
          params: { messageId: m.id },
        });
        apply(res);
        void qc.invalidateQueries({ queryKey: chatKeys.pinned(m.conversationId) });
        toast(t(res.pinnedAt ? 'chat.message.pinnedToast' : 'chat.message.unpinnedToast'));
      } catch (e) {
        fail(e);
      }
    },
    markUnread: async (m: Message) => {
      try {
        holdUnread(m.conversationId);
        const res = await api.call('markConversationUnread', {
          params: { conversationId: m.conversationId },
          body: { fromSeq: m.seq },
        });
        noteMyRead(qc, m.conversationId, res.lastReadSeq, me, {
          unread: res.unread,
          unreadMentions: res.unreadMentions,
        });
      } catch (e) {
        fail(e);
      }
    },
    copyLink: async (m: Message) => {
      const url = `${window.location.origin}${withQuery(paths.chatConversation(m.conversationId), { seq: m.seq })}`;
      try {
        await navigator.clipboard.writeText(url);
        toast(t('chat.message.linkCopied'));
      } catch {
        toast.error(t('errors.internal'));
      }
    },
  };
}
