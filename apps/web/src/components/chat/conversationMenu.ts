import { paths } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { api } from '@/lib/api';
import { newTabLabel, openInNewTab } from '@/lib/newTab';
import { noteMyRead, removeConversation, upsertConversation } from '@/lib/chat/cache';
import { chatKeys } from '@/lib/chat/queries';
import { holdUnread } from '@/lib/chat/runtime';
import { type Conversation, type NotifyLevel } from '@/lib/chat/types';
import { errorKey } from '@/lib/errors';
import { domainOf, myFederationAddressQuery } from '@/lib/federation/queries';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import { openChatDialog } from './dialogs';

/** The chat's menu (list right-click and the header "…"): pin, notify level, mute, manage. */
export function useConversationEntries(conv: Conversation | undefined): ActionEntry[] {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe()?.user.id ?? '';
  const now = useNow(60_000);
  const fed = useQuery(myFederationAddressQuery);
  if (!conv) return [];

  const update = async (body: {
    pinned?: boolean;
    notify?: NotifyLevel;
    mutedUntil?: string | null;
    archived?: boolean;
  }) => {
    try {
      const next = await api.call('updateMyConversation', {
        params: { conversationId: conv.id },
        body,
      });
      if (body.archived !== undefined) {
        // Out of (or back into) the main list; the "Arşiv" list refetches.
        if (body.archived) removeConversation(qc, conv.id);
        else upsertConversation(qc, next);
        qc.setQueryData(chatKeys.conversation(conv.id), next);
        void qc.invalidateQueries({ queryKey: chatKeys.archived });
        toast(t(body.archived ? 'chat.archive.archived' : 'chat.archive.unarchived'));
        return;
      }
      upsertConversation(qc, next);
    } catch (e) {
      toast.error(t(errorKey(e)));
    }
  };
  const p = conv.permissions;
  const muted = conv.my.mutedUntil !== null && Date.parse(conv.my.mutedUntil) > now;
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d.toISOString();
  };
  const levels: NotifyLevel[] =
    conv.type === 'alert' ? ['all', 'critical', 'mentions', 'none'] : ['all', 'mentions', 'none'];

  const entries: ActionEntry[] = [
    {
      kind: 'item',
      key: 'newTab',
      icon: 'ext',
      label: t(newTabLabel()),
      onSelect: () => openInNewTab(paths.chatConversation(conv.id)),
    },
    { kind: 'sep', key: 'newTabSep' },
    {
      kind: 'item',
      key: 'pin',
      icon: 'pin',
      label: t(conv.my.pinnedAt ? 'chat.menu.unpin' : 'chat.menu.pin'),
      onSelect: () => void update({ pinned: !conv.my.pinnedAt }),
    },
  ];
  if (conv.lastSeq > 0 && conv.my.unread === 0) {
    entries.push({
      kind: 'item',
      key: 'unread',
      icon: 'eye',
      label: t('chat.menu.markUnread'),
      shortcut: 'U',
      onSelect: async () => {
        try {
          holdUnread(conv.id);
          const res = await api.call('markConversationUnread', {
            params: { conversationId: conv.id },
            body: { fromSeq: conv.lastSeq },
          });
          noteMyRead(qc, conv.id, res.lastReadSeq, me, res);
        } catch (e) {
          toast.error(t(errorKey(e)));
        }
      },
    });
  }
  entries.push(
    {
      kind: 'sub',
      key: 'notify',
      icon: 'bell',
      label: t('chat.menu.notify', { level: t(`chat.notify.${conv.my.notify}`) }),
      items: levels.map((level) => ({
        key: level,
        label: t(`chat.notify.${level}`),
        onSelect: () => void update({ notify: level }),
      })),
    },
    muted
      ? {
          kind: 'item',
          key: 'unmute',
          icon: 'speaker',
          label: t('chat.menu.unmute'),
          onSelect: () => void update({ mutedUntil: null }),
        }
      : {
          kind: 'sub',
          key: 'mute',
          icon: 'speaker',
          label: t('chat.menu.mute'),
          items: [
            {
              key: '1h',
              label: t('chat.menu.mute1h'),
              onSelect: () =>
                void update({ mutedUntil: new Date(Date.now() + 3_600_000).toISOString() }),
            },
            {
              key: 'tomorrow',
              label: t('chat.menu.muteTomorrow'),
              onSelect: () => void update({ mutedUntil: tomorrow() }),
            },
            {
              key: 'week',
              label: t('chat.menu.muteWeek'),
              onSelect: () =>
                void update({ mutedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() }),
            },
          ],
        },
  );
  const manage: ActionEntry[] = [];
  if (conv.type !== 'direct') {
    manage.push({
      kind: 'item',
      key: 'members',
      icon: 'users',
      label: t('chat.menu.members', { count: conv.memberCount }),
      onSelect: () => openChatDialog({ kind: 'members', conv }),
    });
  }
  if ((conv.type === 'group' || conv.type === 'alert' || conv.private) && p.manage) {
    manage.push({
      kind: 'item',
      key: 'add',
      icon: 'userPlus',
      label: t('chat.menu.addPeople'),
      onSelect: () => openChatDialog({ kind: 'addPeople', conv }),
    });
  }
  // Remote people join groups and space channels homed here (roadmap 26).
  if (
    p.manage &&
    !conv.private &&
    (conv.type === 'group' || conv.type === 'space') &&
    fed.data?.address &&
    (!conv.federation || conv.federation.homeDomain === domainOf(fed.data.address))
  ) {
    manage.push({
      kind: 'item',
      key: 'addRemote',
      icon: 'globe',
      label: t('federation.chat.addRemote'),
      onSelect: () => openChatDialog({ kind: 'addRemote', conv }),
    });
  }
  // Shared channels: a space channel homed here is offered to a whole organization.
  if (
    p.manage &&
    conv.type === 'space' &&
    !conv.private &&
    !conv.archivedAt &&
    fed.data?.address &&
    (!conv.federation || conv.federation.homeDomain === domainOf(fed.data.address))
  ) {
    manage.push({
      kind: 'item',
      key: 'shareOrg',
      icon: 'share',
      label: t('federation.shared.share'),
      onSelect: () => openChatDialog({ kind: 'shareOrg', conv }),
    });
  }
  // Shared channels 2: folders kept in step with the channel's organizations.
  if (conv.federation?.shared?.active) {
    manage.push({
      kind: 'item',
      key: 'sharedFolders',
      icon: 'folder',
      label: t('federation.shared.folders'),
      onSelect: () => openChatDialog({ kind: 'sharedFolders', conv }),
    });
  }
  if (p.manageWebhooks) {
    manage.push({
      kind: 'item',
      key: 'hooks',
      icon: 'plug',
      label: t('chat.menu.webhooks'),
      onSelect: () =>
        void navigate({
          to: '/chat/c/$conversationId',
          params: { conversationId: conv.id },
          search: { panel: 'webhooks' },
        }),
    });
  }
  if (conv.type !== 'direct' && p.manage) {
    manage.push({
      kind: 'item',
      key: 'rename',
      icon: 'edit',
      label: t(conv.type === 'group' ? 'chat.menu.nameGroup' : 'chat.menu.rename'),
      onSelect: () => openChatDialog({ kind: 'rename', conv }),
    });
  }
  if (conv.type === 'group' && p.manage) {
    manage.push({
      kind: 'item',
      key: 'link',
      icon: 'space',
      label: t('chat.menu.linkSpace'),
      onSelect: () => openChatDialog({ kind: 'linkSpace', conv }),
    });
  }
  // Private (Teams-like) or open to the whole space: space admins and channel owners.
  if (conv.private !== undefined && (p.changePrivacy ?? p.archive) && !conv.archivedAt) {
    manage.push({
      kind: 'item',
      key: 'privacy',
      icon: 'lock',
      label: t(conv.private ? 'chat.menu.makeOpen' : 'chat.menu.makePrivate'),
      onSelect: () => openChatDialog({ kind: 'privacy', conv }),
    });
  }
  if (p.archive) {
    manage.push({
      kind: 'item',
      key: 'archive',
      icon: 'archive',
      label: t(conv.archivedAt ? 'chat.menu.unarchive' : 'chat.menu.archive'),
      onSelect: async () => {
        try {
          const next = await api.call('updateConversation', {
            params: { conversationId: conv.id },
            body: { archived: !conv.archivedAt },
          });
          upsertConversation(qc, next);
        } catch (e) {
          toast.error(t(errorKey(e)));
        }
      },
    });
  }
  // H19: personal archive and "Benim için sil" for everyone; "Herkes için sil" by right.
  manage.push({
    kind: 'item',
    key: 'archiveMine',
    icon: 'archive',
    label: t(conv.my.archivedAt ? 'chat.menu.unarchiveMine' : 'chat.menu.archiveMine'),
    onSelect: () => void update({ archived: !conv.my.archivedAt }),
  });
  if (p.clearForMe) {
    manage.push({
      kind: 'item',
      key: 'clear',
      icon: 'trash',
      label: t('chat.menu.clear'),
      danger: true,
      onSelect: () => openChatDialog({ kind: 'clear', conv }),
    });
  }
  if (p.deleteForEveryone) {
    manage.push({
      kind: 'item',
      key: 'deleteAll',
      icon: 'trash',
      label: t('chat.menu.deleteAll'),
      danger: true,
      onSelect: () => openChatDialog({ kind: 'deleteAll', conv }),
    });
  }
  if (conv.type === 'group' || conv.type === 'alert' || conv.private) {
    manage.push({
      kind: 'item',
      key: 'leave',
      icon: 'logout',
      label: t('chat.menu.leave'),
      danger: true,
      onSelect: () => openChatDialog({ kind: 'leave', conv }),
    });
  }
  if (manage.length) entries.push({ kind: 'sep', key: 'sep' }, ...manage);
  return entries;
}
