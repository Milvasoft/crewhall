import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, ChatSocket, HEARTBEAT_MS } from '@/lib/chat/socket';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('chat socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  function make(extra: Partial<ConstructorParameters<typeof ChatSocket>[0]> = {}) {
    const events: unknown[] = [];
    const opens: boolean[] = [];
    let n = 0;
    const s = new ChatSocket({
      getTicket: () => Promise.resolve({ ticket: `t${++n}`, path: '/ws' }),
      url: (t, p) => `ws://x${p}?ticket=${t}`,
      onEvent: (e) => events.push(e),
      onOpen: (r) => opens.push(r),
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      ...extra,
    });
    return { s, events, opens };
  }

  it('backs off 1-2-4-8 up to 30 seconds', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it('uses a fresh ticket per attempt and reports the reconnect', async () => {
    const { s, opens } = make();
    s.start();
    await flush();
    expect(FakeSocket.all[0]?.url).toBe('ws://x/ws?ticket=t1');
    FakeSocket.all[0]!.open();
    expect(opens).toEqual([false]);
    FakeSocket.all[0]!.close();
    expect(s.getState()).toMatchObject({ status: 'retrying', attempt: 1 });
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all[1]?.url).toBe('ws://x/ws?ticket=t2');
    FakeSocket.all[1]!.close();
    expect(s.getState().attempt).toBe(2);
    s.retryNow();
    await flush();
    FakeSocket.all[2]!.open();
    expect(opens).toEqual([false, true]);
    expect(s.getState()).toMatchObject({ status: 'open', attempt: 0 });
    s.stop();
  });

  it('sends a heartbeat every 25 s and drops frames outside the contract', async () => {
    const { s, events } = make({ isActive: () => false, isFocused: () => true });
    s.start();
    await flush();
    const ws = FakeSocket.all[0]!;
    ws.open();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
      type: 'heartbeat',
      active: false,
      focused: true,
    });
    ws.onmessage?.({ data: '{"type":"nope"}' });
    ws.onmessage?.({ data: 'not json' });
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'typing',
        conversationId: '0190f0a0-0000-7000-8000-000000009001',
        userId: '0190f0a0-0000-7000-8000-000000000102',
        expiresAt: new Date().toISOString(),
      }),
    });
    expect(events).toHaveLength(1);
    s.stop();
  });

  it('sends the idle time so the server applies the 15-minute rule itself', async () => {
    const { s } = make({ isActive: () => true, getIdleSeconds: () => 42 });
    s.start();
    await flush();
    const ws = FakeSocket.all[0]!;
    ws.open();
    s.sendHeartbeat();
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: 'heartbeat',
      active: true,
      client: 'web',
      idleSeconds: 42,
    });
    s.stop();
  });

  it('reports the conversation on screen with the heartbeat (H8)', async () => {
    let open: string | null = '0190f0a0-0000-7000-8000-000000009001';
    const { s } = make({ isFocused: () => true, getActiveConversation: () => open });
    s.start();
    await flush();
    const ws = FakeSocket.all[0]!;
    ws.open();
    s.sendHeartbeat();
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({
      type: 'heartbeat',
      focused: true,
      activeConversationId: '0190f0a0-0000-7000-8000-000000009001',
    });
    open = null;
    s.sendHeartbeat();
    expect(JSON.parse(ws.sent.at(-1)!)).toMatchObject({ activeConversationId: null });
    s.stop();
  });

  it('stops for good when the ticket says signed out', async () => {
    const { s } = make({
      getTicket: () => Promise.reject(new Error('401')),
      isFatal: () => true,
    });
    s.start();
    await flush();
    expect(s.getState().status).toBe('idle');
    expect(FakeSocket.all).toHaveLength(0);
  });
});
