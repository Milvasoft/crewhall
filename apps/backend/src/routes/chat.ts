import { can, CHAT_RAW_PATHS, type EndpointName, type ErrorCode } from '@crewhall/shared';
import { AppError, errorBody } from '../http/errors';
import { clientIp } from '../http/client-ip';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import { createWsTicket } from '../realtime/tickets';
import { orgContext } from '../services/membership';
import type { ChatActor } from '../services/chat/access';
import { attachmentFolder, attachmentUrl, listChatFiles } from '../services/chat/attachments';
import { removeLinkPreview } from '../services/chat/link-preview';
import {
  addMembers,
  createConversation,
  getConversation,
  leaveConversation,
  clearConversation,
  deleteConversation,
  linkConversationSpace,
  listConversations,
  listMembers,
  removeMember,
  reorderPinned,
  unreadSummary,
  updateConversation,
  updateMemberRole,
  updateMyConversation,
} from '../services/chat/conversations';
import {
  deleteMessage,
  listMessages,
  listPinned,
  listReadReceipts,
  markRead,
  markUnread,
  messageInfo,
  react,
  sendMessage,
  setClaim,
  setPinned,
  updateMessage,
} from '../services/chat/messages';
import {
  closePoll,
  createPoll,
  createReminder,
  deleteReminder,
  listReminders,
  votePoll,
} from '../services/chat/commands';
import {
  cancelScheduled,
  createScheduled,
  listScheduled,
  sendScheduledNow,
  updateScheduled,
} from '../services/chat/scheduled';
import {
  getGifSettings,
  searchGifs,
  testGifSettings,
  trendingGifs,
  updateGifSettings,
} from '../services/chat/gif';
import { searchMessages } from '../services/chat/search';
import {
  getChatSettings,
  getMyStatus,
  presenceOf,
  updateChatSettings,
  updateMyStatus,
  userCard,
} from '../services/chat/status';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  receiveHook,
  regenerateWebhookKey,
  updateWebhook,
} from '../services/chat/webhooks';
import {
  listNotifications,
  notificationCounts,
  updateNotifications,
} from '../services/notifications/center';
import { resolveRefs, searchRefs } from '../services/chat/refs';
import { unreadCount } from '../services/notifications/notify';
import { getNotificationPrefs, updateNotificationPrefs } from '../services/notifications/prefs';
import {
  listDevices,
  muteDevice,
  registerDevice,
  unregisterDevice,
} from '../services/notifications/push';

const chatActor = <N extends EndpointName>(ctx: OrgCtx<N>): ChatActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
});

/** Org integrations (GIF key): owners and admins (`org.update_settings`). */
function requireSettingsAdmin(ctx: Pick<OrgCtx<never>, 'actor' | 'org'>) {
  if (!can(ctx.actor, 'org.update_settings', { type: 'org', org: orgContext(ctx.org) })) {
    throw new AppError('forbidden');
  }
}

/** Chat module (design 04, 19.13-19.17; doc 17 §4, §6, §10). */
export function registerChat(r: Router): void {
  // ---- Realtime ----
  r.org('createWsTicket', async (ctx) => {
    const t = await createWsTicket(ctx.deps.db, {
      orgId: ctx.org.id,
      userId: ctx.user.id,
      sessionId: ctx.session.id,
    });
    return { ticket: t.ticket, expiresAt: t.expiresAt.toISOString(), path: '/ws' as const };
  });
  r.org('getUnreads', async (ctx) => {
    const views = await unreadSummary(ctx.deps.db, chatActor(ctx));
    const now = Date.now();
    return {
      conversations: views.map((v) => ({
        conversationId: v.id,
        lastReadSeq: v.my.lastReadSeq,
        unread: v.my.unread,
        unreadMentions: v.my.unreadMentions,
        lastSeq: v.lastSeq,
        lastMessageAt: v.lastMessageAt,
      })),
      // Muted conversations count only with mentions (design 04 rules).
      unreadConversations: views.filter((v) => {
        const muted =
          v.my.notify === 'none' ||
          (v.my.mutedUntil !== null && new Date(v.my.mutedUntil).getTime() > now);
        return muted ? v.my.unreadMentions > 0 : v.my.unread > 0;
      }).length,
      notificationsUnread: await unreadCount(ctx.deps.db, ctx.org.id, ctx.user.id),
    };
  });

  // ---- Conversations ----
  r.org('listConversations', (ctx) => listConversations(ctx.deps.db, chatActor(ctx), ctx.query));
  r.org('createConversation', (ctx) => createConversation(ctx.deps, chatActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('getConversation', (ctx) =>
    getConversation(ctx.deps.db, chatActor(ctx), ctx.params.conversationId),
  );
  r.org('updateConversation', (ctx) =>
    updateConversation(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
  );
  r.org('linkConversationSpace', (ctx) =>
    linkConversationSpace(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body.spaceId),
  );
  r.org('updateMyConversation', (ctx) =>
    updateMyConversation(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
  );
  r.org('clearConversation', async (ctx) => {
    await clearConversation(ctx.deps, chatActor(ctx), ctx.params.conversationId);
    return {};
  });
  r.org('deleteConversation', async (ctx) => {
    await deleteConversation(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.req);
    return {};
  });
  r.org('leaveConversation', async (ctx) => {
    await leaveConversation(ctx.deps, chatActor(ctx), ctx.params.conversationId);
    return {};
  });
  r.org('reorderPinnedConversations', async (ctx) => {
    await reorderPinned(ctx.deps, chatActor(ctx), ctx.body.conversationIds);
    return {};
  });
  r.org('listConversationMembers', async (ctx) => ({
    items: await listMembers(ctx.deps.db, chatActor(ctx), ctx.params.conversationId),
  }));
  r.org('addConversationMembers', async (ctx) => ({
    items: await addMembers(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
  }));
  r.org('removeConversationMember', async (ctx) => {
    await removeMember(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.params.userId);
    return {};
  });
  r.org('updateConversationMember', async (ctx) => ({
    items: await updateMemberRole(
      ctx.deps,
      chatActor(ctx),
      ctx.params.conversationId,
      ctx.params.userId,
      ctx.body.role,
    ),
  }));
  r.org('listReadReceipts', async (ctx) => ({
    items: await listReadReceipts(ctx.deps.db, chatActor(ctx), ctx.params.conversationId),
  }));
  r.org('markConversationRead', (ctx) =>
    markRead(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body.seq),
  );
  r.org('markConversationUnread', (ctx) =>
    markUnread(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body.fromSeq),
  );

  // ---- Messages ----
  r.org('listMessages', (ctx) =>
    listMessages(ctx.deps.db, chatActor(ctx), ctx.params.conversationId, ctx.query),
  );
  r.org(
    'sendMessage',
    (ctx) => sendMessage(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
    { status: 201 },
  );
  r.org('updateMessage', (ctx) =>
    updateMessage(ctx.deps, chatActor(ctx), ctx.params.messageId, ctx.body.text, ctx.body.dlpAck),
  );
  r.org('deleteMessage', (ctx) => deleteMessage(ctx.deps, chatActor(ctx), ctx.params.messageId));
  r.org('addReaction', (ctx) =>
    react(ctx.deps, chatActor(ctx), ctx.params.messageId, ctx.body.emoji, true),
  );
  r.org('removeReaction', (ctx) =>
    react(ctx.deps, chatActor(ctx), ctx.params.messageId, ctx.body.emoji, false),
  );
  r.org('getMessageInfo', (ctx) => messageInfo(ctx.deps.db, chatActor(ctx), ctx.params.messageId));
  r.org('pinMessage', (ctx) => setPinned(ctx.deps, chatActor(ctx), ctx.params.messageId, true));
  r.org('unpinMessage', (ctx) => setPinned(ctx.deps, chatActor(ctx), ctx.params.messageId, false));
  r.org('resolveChatRefs', async (ctx) => ({
    items: await resolveRefs(ctx.deps.db, chatActor(ctx), ctx.body.refs),
  }));
  r.org('searchChatRefs', async (ctx) => ({
    items: await searchRefs(ctx.deps.db, chatActor(ctx), ctx.query),
  }));
  r.org('claimMessage', (ctx) => setClaim(ctx.deps, chatActor(ctx), ctx.params.messageId, true));
  r.org('unclaimMessage', (ctx) => setClaim(ctx.deps, chatActor(ctx), ctx.params.messageId, false));
  r.org('removeChatLinkPreview', (ctx) =>
    removeLinkPreview(ctx.deps, chatActor(ctx), ctx.params.messageId),
  );
  r.org('listPinnedMessages', async (ctx) => ({
    items: await listPinned(ctx.deps.db, chatActor(ctx), ctx.params.conversationId),
  }));
  r.org('searchMessages', (ctx) => searchMessages(ctx.deps.db, chatActor(ctx), ctx.query));

  // ---- Scheduled messages ----
  r.org('listScheduledMessages', async (ctx) => ({
    items: await listScheduled(ctx.deps.db, chatActor(ctx), ctx.params.conversationId),
  }));
  r.org(
    'createScheduledMessage',
    (ctx) => createScheduled(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
    { status: 201 },
  );
  r.org('updateScheduledMessage', (ctx) =>
    updateScheduled(ctx.deps, chatActor(ctx), ctx.params.scheduledId, ctx.body),
  );
  r.org('deleteScheduledMessage', async (ctx) => {
    await cancelScheduled(ctx.deps.db, chatActor(ctx), ctx.params.scheduledId);
    return {};
  });
  r.org('sendScheduledMessageNow', (ctx) =>
    sendScheduledNow(ctx.deps, chatActor(ctx), ctx.params.scheduledId),
  );

  // ---- GIF (GIPHY) ----
  r.org('trendingGifs', (ctx) =>
    trendingGifs(ctx.deps, { orgId: ctx.org.id, userId: ctx.user.id }, ctx.query),
  );
  r.org('searchGifs', (ctx) =>
    searchGifs(ctx.deps, { orgId: ctx.org.id, userId: ctx.user.id }, ctx.query),
  );
  r.org('getGifSettings', (ctx) => {
    requireSettingsAdmin(ctx);
    return getGifSettings(ctx.deps.db, ctx.org.id);
  });
  r.org('updateGifSettings', (ctx) => {
    requireSettingsAdmin(ctx);
    return updateGifSettings(
      ctx.deps,
      { orgId: ctx.org.id, userId: ctx.user.id },
      ctx.body,
      ctx.req,
    );
  });
  r.org('testGifSettings', (ctx) => {
    requireSettingsAdmin(ctx);
    return testGifSettings(ctx.deps, ctx.org.id);
  });

  // ---- Slash commands (roadmap 23) ----
  r.org(
    'createPoll',
    (ctx) => createPoll(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
    { status: 201 },
  );
  r.org('votePoll', (ctx) =>
    votePoll(ctx.deps, chatActor(ctx), ctx.params.pollId, ctx.body.options),
  );
  r.org('closePoll', (ctx) => closePoll(ctx.deps, chatActor(ctx), ctx.params.pollId));
  r.org('listChatReminders', async (ctx) => ({
    items: await listReminders(ctx.deps.db, chatActor(ctx)),
  }));
  r.org('createChatReminder', (ctx) => createReminder(ctx.deps.db, chatActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('deleteChatReminder', async (ctx) => {
    await deleteReminder(ctx.deps.db, chatActor(ctx), ctx.params.reminderId);
    return {};
  });

  // ---- Attachments ----
  r.org('getChatAttachmentFolder', (ctx) =>
    attachmentFolder(ctx.deps, chatActor(ctx), ctx.params.conversationId),
  );
  r.org('listChatFiles', (ctx) =>
    listChatFiles(ctx.deps.db, chatActor(ctx), ctx.params.conversationId, ctx.query),
  );
  r.org('getChatAttachmentUrl', (ctx) =>
    attachmentUrl(ctx.deps, chatActor(ctx), ctx.params.messageId, ctx.params.nodeId, ctx.query),
  );

  // ---- People, presence, status ----
  r.org('getChatUserCard', (ctx) => userCard(ctx.deps, chatActor(ctx), ctx.params.userId));
  r.org('getPresence', async (ctx) => ({
    items: await presenceOf(ctx.deps, chatActor(ctx), ctx.body.userIds),
  }));
  r.org('getMyStatus', (ctx) => getMyStatus(ctx.deps.db, chatActor(ctx)));
  r.org('updateMyStatus', (ctx) => updateMyStatus(ctx.deps, chatActor(ctx), ctx.body));
  r.org('getChatSettings', (ctx) => getChatSettings(ctx.deps.db, chatActor(ctx)));
  r.org('updateChatSettings', (ctx) => updateChatSettings(ctx.deps.db, chatActor(ctx), ctx.body));

  // ---- Notifications ----
  r.org('listNotifications', (ctx) =>
    listNotifications(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.query),
  );
  r.org('getNotificationCounts', (ctx) => notificationCounts(ctx.deps.db, ctx.org.id, ctx.user.id));
  r.org('updateNotifications', (ctx) =>
    updateNotifications(ctx.deps.db, ctx.deps.bus, ctx.org.id, ctx.user.id, ctx.body),
  );
  r.org('getNotificationPrefs', (ctx) =>
    getNotificationPrefs(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.org.settings),
  );
  r.org('updateNotificationPrefs', (ctx) =>
    updateNotificationPrefs(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.org.settings, ctx.body),
  );
  r.org(
    'registerPushDevice',
    (ctx) => registerDevice(ctx.deps.db, ctx.org.id, ctx.user.id, ctx.body),
    { status: 201 },
  );
  r.org('mutePushDevice', (ctx) =>
    muteDevice(ctx.deps.db, ctx.user.id, ctx.body.expoToken, ctx.body.mutedUntil),
  );
  r.org('unregisterPushDevice', async (ctx) => {
    await unregisterDevice(ctx.deps.db, ctx.user.id, ctx.body.expoToken);
    return {};
  });
  r.org('listPushDevices', async (ctx) => ({
    items: await listDevices(ctx.deps.db, ctx.org.id, ctx.user.id),
  }));

  // ---- Incoming webhooks ----
  r.org('listIncomingWebhooks', async (ctx) => ({
    items: await listWebhooks(ctx.deps, chatActor(ctx), ctx.params.conversationId),
  }));
  r.org(
    'createIncomingWebhook',
    (ctx) => createWebhook(ctx.deps, chatActor(ctx), ctx.params.conversationId, ctx.body),
    { status: 201 },
  );
  r.org('updateIncomingWebhook', (ctx) =>
    updateWebhook(ctx.deps, chatActor(ctx), ctx.params.webhookId, ctx.body),
  );
  r.org('deleteIncomingWebhook', async (ctx) => {
    await deleteWebhook(ctx.deps, chatActor(ctx), ctx.params.webhookId);
    return {};
  });
  r.org('regenerateIncomingWebhookKey', (ctx) =>
    regenerateWebhookKey(ctx.deps, chatActor(ctx), ctx.params.webhookId),
  );
  r.org('listWebhookDeliveries', (ctx) =>
    listDeliveries(ctx.deps, chatActor(ctx), ctx.params.webhookId, ctx.query),
  );

  // POST /api/hooks/:webhookId?key= — no session; the key in the URL is the credential.
  r.rawPublic('POST', CHAT_RAW_PATHS.incomingHook, async ({ c, deps }) => {
    const webhookId = c.req.param('webhookId') ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(webhookId)) throw new AppError('not_found');
    const declared = Number(c.req.header('content-length') ?? 0);
    const body = declared > 64 * 1024 ? 'x'.repeat(64 * 1024) : await c.req.text();
    const res = await receiveHook(deps, {
      webhookId,
      key: c.req.query('key') ?? '',
      ip: clientIp(c),
      body,
      header: (name) => c.req.header(name),
    });
    if (res.retryAfter) c.header('Retry-After', String(res.retryAfter));
    if (res.status === 200) return c.json(res.body, 200);
    const { code, ...details } = res.body as { code: ErrorCode };
    const err = new AppError(code, Object.keys(details).length ? details : undefined);
    return c.json(errorBody(err, c.req.header('accept-language')), res.status as 400);
  });
}
