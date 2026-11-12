import { describe, expect, it } from 'vitest';
import { endpoints } from '../endpoints';
import {
  CreateConversation,
  HookPayload,
  pushProviderOf,
  RegisterPushDevice,
  UpdateNotifications,
  WsClientEvent,
  WsServerEvent,
} from './chat';

describe('chat contract', () => {
  it('is part of the endpoint table with unique paths per method', () => {
    expect(endpoints.sendMessage.path).toBe('/api/v1/chat/conversations/:conversationId/messages');
    const keys = Object.values(endpoints).map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('defaults group history to 7 days and validates conversation inputs', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(CreateConversation.safeParse({ type: 'group', userIds: [id] }).success).toBe(false);
    expect(CreateConversation.parse({ type: 'alert', name: 'Prod' })).toMatchObject({
      userIds: [],
    });
  });

  it('accepts text or card hook bodies only', () => {
    expect(HookPayload.safeParse({}).success).toBe(false);
    expect(HookPayload.parse({ card: { title: 'Down' } }).card).toMatchObject({
      severity: 'info',
      fields: [],
    });
  });

  it('needs ids or all, and until for snooze', () => {
    expect(UpdateNotifications.safeParse({ action: 'read' }).success).toBe(false);
    expect(UpdateNotifications.safeParse({ all: true, action: 'snooze' }).success).toBe(false);
    expect(UpdateNotifications.safeParse({ all: true, action: 'read' }).success).toBe(true);
  });

  it('tells Expo tokens from FCM ones', () => {
    const ok = { expoToken: 'ExponentPushToken[abc]', platform: 'ios' };
    expect(RegisterPushDevice.safeParse(ok).success).toBe(true);
    expect(pushProviderOf('ExponentPushToken[abc]')).toBe('expo');
    // A native FCM registration token, with or without the provider field.
    expect(RegisterPushDevice.safeParse({ ...ok, expoToken: 'fcm-token:APA91b' }).success).toBe(
      true,
    );
    expect(pushProviderOf('fcm-token:APA91b')).toBe('fcm');
    expect(
      RegisterPushDevice.safeParse({ ...ok, expoToken: 'abc', provider: 'expo' }).success,
    ).toBe(false);
  });

  it('parses WebSocket events', () => {
    expect(WsClientEvent.parse({ type: 'heartbeat', active: true, focused: false }).type).toBe(
      'heartbeat',
    );
    const ev = WsServerEvent.parse({
      type: 'typing',
      conversationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      expiresAt: '2026-10-20T10:00:00.000Z',
    });
    expect(ev.type).toBe('typing');
    expect(WsServerEvent.safeParse({ type: 'nope' }).success).toBe(false);
  });
});
