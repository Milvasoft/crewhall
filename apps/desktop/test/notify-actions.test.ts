import type { Call, Notification } from '@crewhall/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  answerCallFromNote,
  declineCallFromNote,
  markNotificationRead,
  notificationButtons,
  replyToNotification,
  ringIsOver,
} from '../src/common/notify-actions';
import { realtimeEffects } from '../src/common/window-policy';

const note = (patch: Partial<Notification> = {}): Notification => ({
  id: 'n1',
  type: 'chat.mention',
  category: 'mention',
  source: 'chat',
  actor: null,
  target: { type: 'message', id: 'm1', conversationId: 'c1', seq: 4, spaceId: null },
  data: {},
  count: 1,
  url: '/chat/c/c1?m=4',
  readAt: null,
  snoozedUntil: null,
  dismissedAt: null,
  createdAt: '2026-11-04T10:00:00.000Z',
  updatedAt: '2026-11-04T10:00:00.000Z',
  ...patch,
});

function fakeApi(fail: string[] = []) {
  const call = vi.fn(async (name: string) => {
    if (fail.includes(name)) throw new Error(name);
    if (name === 'answerCall') return { id: 'call 1', slug: 'abc' };
    return {};
  });
  return { call, api: { call } as unknown as Parameters<typeof markNotificationRead>[0] };
}

describe('buttons on a notification', () => {
  it('lets a message be answered or marked read', () => {
    expect(notificationButtons(note())).toEqual({ reply: true, actions: ['markRead'] });
  });

  it('offers joining for a meeting', () => {
    const n = note({
      source: 'meetings' as Notification['source'],
      target: { type: 'meeting', id: 'x', conversationId: null, seq: null, spaceId: null },
    });
    expect(notificationButtons(n)).toEqual({ reply: false, actions: ['join'] });
  });

  it('only marks read where there is nobody to answer', () => {
    const card = note({
      source: 'boards',
      target: { type: 'card', id: 'x', conversationId: null, seq: null, spaceId: 's' },
    });
    expect(notificationButtons(card)).toEqual({ reply: false, actions: ['markRead'] });
  });
});

describe('marking read', () => {
  it('marks the notification and the conversation up to the message', async () => {
    const { api, call } = fakeApi();
    await markNotificationRead(api, note());
    expect(call).toHaveBeenCalledWith('updateNotifications', {
      body: { ids: ['n1'], action: 'read' },
    });
    expect(call).toHaveBeenCalledWith('markConversationRead', {
      params: { conversationId: 'c1' },
      body: { seq: 4 },
    });
  });

  it('touches no conversation when the notification has none', async () => {
    const { api, call } = fakeApi();
    await markNotificationRead(
      api,
      note({ target: { type: 'card', id: 'x', conversationId: null, seq: null, spaceId: null } }),
    );
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('replying', () => {
  it('sends to the conversation and marks it read', async () => {
    const { api, call } = fakeApi();
    await expect(replyToNotification(api, note(), '  tamam  ', () => 'id-1')).resolves.toBe(true);
    expect(call).toHaveBeenCalledWith('sendMessage', {
      params: { conversationId: 'c1' },
      body: { clientMsgId: 'id-1', text: 'tamam', attachmentNodeIds: [] },
    });
    expect(call).toHaveBeenCalledWith('updateNotifications', expect.anything());
  });

  it('sends nothing for an empty reply', async () => {
    const { api, call } = fakeApi();
    await expect(replyToNotification(api, note(), '   ', () => 'id')).resolves.toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('fails when sending fails, so the text is not lost silently', async () => {
    const { api } = fakeApi(['sendMessage']);
    await expect(replyToNotification(api, note(), 'tamam', () => 'id')).rejects.toThrow();
  });

  it('counts as sent even if marking read fails afterwards', async () => {
    const { api } = fakeApi(['updateNotifications']);
    await expect(replyToNotification(api, note(), 'tamam', () => 'id')).resolves.toBe(true);
  });
});

describe('calls', () => {
  const call = { id: 'call 1', slug: 'abc', status: 'ringing' } as unknown as Call;

  it('answers and gives the path of the room', async () => {
    const { api, call: spy } = fakeApi();
    await expect(answerCallFromNote(api, call)).resolves.toBe('/meetings/room/abc?call=call%201');
    expect(spy).toHaveBeenCalledWith('answerCall', { params: { callId: 'call 1' } });
  });

  it('declines without saying busy', async () => {
    const { api, call: spy } = fakeApi();
    await declineCallFromNote(api, call);
    expect(spy).toHaveBeenCalledWith('declineCall', {
      params: { callId: 'call 1' },
      body: { busy: false },
    });
  });

  it('knows when the ring is over', () => {
    expect(ringIsOver(call)).toBe(false);
    for (const status of ['active', 'ended', 'missed', 'declined', 'cancelled']) {
      expect(ringIsOver({ ...call, status } as Call)).toBe(true);
    }
    expect(realtimeEffects('call.updated')).toEqual(['ring-over']);
  });
});
