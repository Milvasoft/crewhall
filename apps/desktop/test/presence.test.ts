import { describe, expect, it, vi } from 'vitest';
import { ACTIVE_WITHIN_SECONDS, presenceFields } from '../src/common/presence';
import { RealtimeClient, type SocketLike } from '../src/common/realtime';

describe('presence from the computer', () => {
  it('is active within 15 minutes of input and not while locked or asleep', () => {
    expect(ACTIVE_WITHIN_SECONDS).toBe(900);
    expect(presenceFields({ idleSeconds: 30, locked: false })).toEqual({
      active: true,
      idleSeconds: 30,
      locked: false,
      client: 'desktop',
    });
    expect(presenceFields({ idleSeconds: 899.9, locked: false }).active).toBe(true);
    expect(presenceFields({ idleSeconds: 900, locked: false }).active).toBe(false);
    expect(presenceFields({ idleSeconds: 5, locked: true })).toEqual({
      active: false,
      idleSeconds: 5,
      locked: true,
      client: 'desktop',
    });
  });

  it('sends whole, non-negative seconds', () => {
    expect(presenceFields({ idleSeconds: -3, locked: false }).idleSeconds).toBe(0);
    expect(presenceFields({ idleSeconds: Number.NaN, locked: false }).idleSeconds).toBe(0);
  });
});

describe('heartbeat with the computer state', () => {
  class FakeSocket implements SocketLike {
    readyState = 0;
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;
    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
    }
  }

  it('reports idle time and lock, never focus, and beats at once on a change', async () => {
    const socket = new FakeSocket();
    let state = { idleSeconds: 12, locked: false };
    const client = new RealtimeClient({
      getTicket: async () => ({ ticket: 't', path: '/ws' }),
      origin: () => 'https://a.com',
      openSocket: () => socket,
      onEvent: () => undefined,
      device: () => state,
    });
    client.start();
    await vi.waitFor(() => expect(socket.onmessage).not.toBeNull());
    socket.readyState = 1;
    socket.onmessage?.({
      data: JSON.stringify({
        type: 'ready',
        userId: '0b6c3f4e-8d1a-4f7e-9c2b-1a2b3c4d5e6f',
        orgId: '1c7d4a5f-9e2b-4a8f-8d3c-2b3c4d5e6f70',
        serverTime: '2026-10-29T10:00:00.000Z',
        heartbeatSeconds: 25,
      }),
    });
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: 'heartbeat',
      active: true,
      idleSeconds: 12,
      locked: false,
      client: 'desktop',
      focused: false,
      activeConversationId: null,
    });
    // Windows locks: the server hears it now.
    state = { idleSeconds: 0, locked: true };
    client.beatNow();
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({ active: false, locked: true });
    client.stop();
  });
});
