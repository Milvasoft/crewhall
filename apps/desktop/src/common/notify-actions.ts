import type { ApiClient } from '@crewhall/api-client';
import { paths, type Call, type Notification } from '@crewhall/shared';

/**
 * Buttons on native notifications (Windows, macOS; Linux shows the notification without them)
 * and what they do. The work needs no window: the app sits in the tray while it happens.
 */

export type NoteAction = 'markRead' | 'join';
export type CallAction = 'answer' | 'decline';

export interface NoteButtons {
  /** A text field that sends to the conversation. */
  reply: boolean;
  actions: NoteAction[];
}

type Api = Pick<ApiClient, 'call'>;

/** Replying only makes sense where a person wrote to the conversation. */
function isMessage(n: Notification): boolean {
  return n.source === 'chat' && n.target.type === 'message' && !!n.target.conversationId;
}

export function notificationButtons(n: Notification): NoteButtons {
  if (isMessage(n)) return { reply: true, actions: ['markRead'] };
  if (n.target.type === 'meeting') return { reply: false, actions: ['join'] };
  return { reply: false, actions: ['markRead'] };
}

/** The notification, and the conversation up to the message it was about. */
export async function markNotificationRead(api: Api, n: Notification): Promise<void> {
  const { conversationId, seq } = n.target;
  await Promise.all([
    api.call('updateNotifications', { body: { ids: [n.id], action: 'read' } }),
    conversationId && seq !== null
      ? api.call('markConversationRead', { params: { conversationId }, body: { seq } })
      : null,
  ]);
}

/**
 * Sends the reply. Whether it could be marked read afterwards does not change that it was sent,
 * so only a failure to send rejects. False: there was nothing to send.
 */
export async function replyToNotification(
  api: Api,
  n: Notification,
  text: string,
  newId: () => string,
): Promise<boolean> {
  const body = text.trim();
  const conversationId = n.target.conversationId;
  if (!body || !conversationId) return false;
  await api.call('sendMessage', {
    params: { conversationId },
    body: { clientMsgId: newId(), text: body, attachmentNodeIds: [] },
  });
  await markNotificationRead(api, n).catch(() => undefined);
  return true;
}

/** Answers on this device; the path opens the meeting window, like the web's answer button. */
export async function answerCallFromNote(api: Api, call: Call): Promise<string> {
  const answered = await api.call('answerCall', { params: { callId: call.id } });
  return `${paths.meetingRoom(answered.slug)}?call=${encodeURIComponent(answered.id)}`;
}

export async function declineCallFromNote(api: Api, call: Call): Promise<void> {
  await api.call('declineCall', { params: { callId: call.id }, body: { busy: false } });
}

/** The ring is over: its notification must not stay around offering to answer. */
export function ringIsOver(call: Call): boolean {
  return call.status !== 'ringing';
}
