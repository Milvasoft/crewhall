import type { Call, Notification } from '@crewhall/shared';
import type { Translate } from './i18n';

export interface NativeContent {
  title: string;
  body: string;
  /** Web path to open on click; empty: only bring the window up. */
  path: string;
}

/** Translation key of a notification title; the web's bell uses the same texts. */
export function notificationKey(type: string): string {
  if (type.startsWith('boards.')) return `boards.notifications.${type.slice('boards.'.length)}`;
  return `chat.notifications.${type}`;
}

/** Path inside the server from a notification url (absolute in some deployments). */
export function notificationPath(url: string, origin: string): string {
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}

/**
 * Whether a notification gets an OS popup. The server says `desktop: false` when the person
 * switched the desktop channel off for this kind, or quiet hours or do not disturb are on (the
 * bell and the count still update); older servers send no `desktop`, so those show as before.
 */
export function wantsNativeNotification(
  n: Pick<Notification, 'readAt'> & { desktop?: boolean | undefined },
): boolean {
  return !n.readAt && n.desktop !== false;
}

/**
 * One notification is one popup: the same row arriving again with nothing new stays quiet. A row
 * that grew (another message of the conversation) has a new count, so it still shows.
 */
export class NoteGuard {
  private readonly shown = new Map<string, string>();

  constructor(private readonly limit = 200) {}

  first(n: { id: string; count: number }, content: { title: string; body: string }): boolean {
    const key = JSON.stringify([n.count, content.title, content.body]);
    if (this.shown.get(n.id) === key) return false;
    this.shown.delete(n.id);
    this.shown.set(n.id, key);
    if (this.shown.size > this.limit) {
      this.shown.delete(this.shown.keys().next().value as string);
    }
    return true;
  }
}

/** Title (the bell's line for this type) and body (the message excerpt) of a native notification. */
export function notificationContent(n: Notification, t: Translate, origin: string): NativeContent {
  const values: Record<string, string | number> = {
    actor: n.actor?.name ?? '',
    count: n.count,
    conversationTitle: '',
    webhookName: '',
    nodeName: '',
    spaceName: '',
    linkTitle: '',
    title: '',
    name: '',
    key: '',
  };
  for (const [k, v] of Object.entries(n.data)) {
    values[k] = typeof v === 'boolean' ? String(v) : (v ?? '');
  }
  const author = typeof n.data.authorName === 'string' ? n.data.authorName : '';
  if (!values.actor) values.actor = author || t('desktop.notify.someone');
  if (!values.webhookName) values.webhookName = author;

  const key = notificationKey(n.type);
  let title = t(key, values);
  if (title === key) title = t('chat.notifications.generic');
  const excerpt = typeof n.data.excerpt === 'string' ? n.data.excerpt : '';
  return { title, body: excerpt, path: notificationPath(n.url, origin) };
}

/** "<caller> is calling you" for an incoming call; group calls name the conversation. */
export function callContent(call: Call, t: Translate): NativeContent {
  const name = call.caller?.name ?? t('desktop.notify.someone');
  const title = t(call.video ? 'desktop.notify.incomingVideoCall' : 'desktop.notify.incomingCall', {
    name,
  });
  const body = call.conversationTitle
    ? t('desktop.notify.groupCall', { conversationTitle: call.conversationTitle })
    : t('desktop.notify.answerHint');
  // The web shows the incoming call with answer and decline; a click only brings it up.
  return { title, body, path: '' };
}
