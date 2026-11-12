import { type Notification } from '@/lib/chat/types';
import { type MessageKey } from '@/lib/i18n/I18nContext';

/** Title key per known notification type (contract: `web.chat.notifications.<type>`). */
const TITLES: Record<string, MessageKey> = {
  'chat.mention': 'chat.notifications.chat.mention',
  'chat.direct': 'chat.notifications.chat.direct',
  'chat.reply': 'chat.notifications.chat.reply',
  'chat.message': 'chat.notifications.chat.message',
  'chat.alert': 'chat.notifications.chat.alert',
  'chat.webhook_failing': 'chat.notifications.chat.webhook_failing',
  'chat.scheduled_failed': 'chat.notifications.chat.scheduled_failed',
  'chat.reminder': 'chat.notifications.chat.reminder',
  'drive.shared': 'chat.notifications.drive.shared',
  'space.added': 'chat.notifications.space.added',
  'link.down': 'chat.notifications.link.down',
  'link.up': 'chat.notifications.link.up',
  'meet.invited': 'chat.notifications.meet.invited',
  'meet.recording_ready': 'chat.notifications.meet.recording_ready',
  'meet.call_missed': 'chat.notifications.meet.call_missed',
  'meet.updated': 'chat.notifications.meet.updated',
  'meet.cancelled': 'chat.notifications.meet.cancelled',
  'meet.ring_declined': 'chat.notifications.meet.ring_declined',
  'meet.ring_unanswered': 'chat.notifications.meet.ring_unanswered',
  'page.mention': 'chat.notifications.page.mention',
  'page.comment_mention': 'chat.notifications.page.comment_mention',
  'page.comment_reply': 'chat.notifications.page.comment_reply',
  'page.restored': 'chat.notifications.page.restored',
  'page.updated': 'chat.notifications.page.updated',
  'page.export_ready': 'chat.notifications.page.export_ready',
  'boards.assigned': 'boards.notifications.assigned',
  'boards.comment': 'boards.notifications.comment',
  'boards.due_soon': 'boards.notifications.due_soon',
  'announcement.published': 'announcements.notifications.published',
  'kudos.received': 'announcements.notifications.kudos',
  'forms.response': 'forms.notifications.response',
  'calendar.invited': 'calendar.notifications.invited',
  'calendar.updated': 'calendar.notifications.updated',
  'calendar.cancelled': 'calendar.notifications.cancelled',
  'calendar.response': 'calendar.notifications.response',
  'calendar.reminder': 'calendar.notifications.reminder',
  'automations.notify': 'automations.notifications.notify',
  'automations.disabled': 'automations.notifications.disabled',
  'mail.new': 'mail.notifications.new',
  'mail.inbox.assigned': 'mail.notifications.assigned',
  'approval.requested': 'chat.notifications.approval.requested',
  'plugin.notification': 'chat.notifications.plugin.notification',
};

export function notificationTitle(
  n: Notification,
  t: (key: MessageKey, values?: Record<string, string | number | null | undefined>) => string,
): string {
  // Every placeholder a title may use, so a row without one never breaks the formatter.
  const values: Record<string, string | number | null | undefined> = {
    actor: n.actor?.name ?? '',
    count: n.count,
    conversationTitle: '',
    webhookName: '',
    nodeName: '',
    spaceName: '',
    linkTitle: '',
    title: '',
    name: '',
    fileName: '',
    key: '',
    text: '',
    plugin: '',
  };
  for (const [k, v] of Object.entries(n.data)) {
    values[k] = typeof v === 'boolean' ? String(v) : (v ?? '');
  }
  // A channel emoji leads the conversation name ("🚀 Roket").
  const emoji = typeof n.data.conversationEmoji === 'string' ? n.data.conversationEmoji : '';
  if (emoji && values.conversationTitle) {
    values.conversationTitle = `${emoji} ${values.conversationTitle}`;
  }
  // The server names the sender (person or webhook) `authorName`.
  const author = typeof n.data.authorName === 'string' ? n.data.authorName : '';
  if (!values.actor) values.actor = author;
  if (!values.webhookName) values.webhookName = author;
  return t(TITLES[n.type] ?? 'chat.notifications.generic', values);
}

export function notificationBody(n: Notification): string | null {
  const excerpt = n.data.excerpt;
  return typeof excerpt === 'string' && excerpt ? excerpt : null;
}

/** In-app path from the server URL (it may be absolute in some deployments). */
export function notificationPath(n: Notification): string {
  try {
    const u = new URL(n.url, window.location.origin);
    // The fragment stays: a plugin's deep link may use it.
    return u.origin === window.location.origin ? `${u.pathname}${u.search}${u.hash}` : n.url;
  } catch {
    return '/';
  }
}
