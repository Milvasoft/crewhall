import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Presence, WsServerEvent } from '@crewhall/shared';
import { createLogger } from '../src/logger';
import type { Bus } from '../src/realtime/bus';
import { PresenceTracker, type StatusChoice } from '../src/realtime/presence';

const U = '00000000-0000-4000-8000-000000000001';
const MIN = 60_000;

function setup() {
  const events: Presence[] = [];
  const bus: Bus = {
    publish: (_topic: string, e: WsServerEvent) => {
      if (e.type === 'presence') events.push(e.presence);
    },
    subscribe: () => () => undefined,
  };
  const tracker = new PresenceTracker(bus, null, createLogger('silent'), 30_000, 15_000);
  const last = () => events.at(-1)!;
  return { tracker, events, last };
}

const choice = (c: Partial<StatusChoice>): StatusChoice => ({
  visibility: 'online',
  visibilityUntil: null,
  message: null,
  ...c,
});

describe('presence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T09:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('goes away after 15 minutes without input, without waiting for a heartbeat', () => {
    const { tracker, last } = setup();
    tracker.connect('c1', U, null);
    tracker.heartbeat('c1', U, true, true, null, { client: 'web', idleSeconds: 0 });
    expect(last()).toMatchObject({ state: 'online', device: 'web' });
    // Ten minutes idle is still online.
    vi.advanceTimersByTime(10 * MIN);
    tracker.heartbeat('c1', U, true, true, null, { client: 'web', idleSeconds: 600 });
    expect(tracker.state(U)).toBe('online');
    // The sweep notices the 15-minute mark on its own.
    vi.advanceTimersByTime(5 * MIN + 15_000);
    expect(last().state).toBe('away');
    // Last seen is the last input, not now.
    expect(last().lastSeenAt).toBe('2026-10-29T09:00:00.000Z');
    tracker.close();
  });

  it('a locked desktop is away; the most active device wins', () => {
    const { tracker, last } = setup();
    tracker.connect('desk', U, null);
    tracker.heartbeat('desk', U, false, false, null, {
      client: 'desktop',
      idleSeconds: 3,
      locked: true,
    });
    expect(last()).toMatchObject({ state: 'away', device: 'desktop' });
    tracker.connect('phone', U, null);
    tracker.heartbeat('phone', U, true, true, null, { client: 'mobile', idleSeconds: 0 });
    expect(last()).toMatchObject({ state: 'online', device: 'mobile' });
    // The phone goes to the background: away again.
    tracker.heartbeat('phone', U, false, false, null, { client: 'mobile', idleSeconds: 0 });
    expect(last().state).toBe('away');
    // Unlocking the desktop brings it back online.
    tracker.heartbeat('desk', U, true, false, null, { client: 'desktop', idleSeconds: 0 });
    expect(last()).toMatchObject({ state: 'online', device: 'desktop' });
    tracker.close();
  });

  it('keeps old clients working with only `active`', () => {
    const { tracker, last } = setup();
    tracker.connect('c1', U, null);
    tracker.heartbeat('c1', U, false, true);
    expect(last().state).toBe('away');
    tracker.heartbeat('c1', U, true, true);
    expect(last().state).toBe('online');
    tracker.close();
  });

  it('a meeting shows busy · in a meeting; dnd and invisible stay above it', () => {
    const { tracker, last } = setup();
    tracker.connect('c1', U, choice({}));
    tracker.setMeeting(U, true);
    expect(last()).toMatchObject({ state: 'busy', auto: 'meeting' });
    tracker.setChoice(U, choice({ visibility: 'dnd' }));
    expect(last()).toMatchObject({ state: 'dnd', auto: null });
    tracker.setChoice(U, choice({ visibility: 'invisible' }));
    expect(last()).toMatchObject({ state: 'offline', device: null });
    // Automatic meeting status switched off: plain activity.
    tracker.setChoice(U, choice({ autoMeeting: false }));
    expect(last()).toMatchObject({ state: 'online', auto: null });
    tracker.setChoice(U, choice({}));
    tracker.setMeeting(U, false);
    expect(last()).toMatchObject({ state: 'online', auto: null });
    tracker.close();
  });

  it('presenting (screen share) shows above the meeting, below a chosen dnd', () => {
    const { tracker, last } = setup();
    tracker.connect('c1', U, choice({}));
    // A share outside any meeting the server knows of changes nothing.
    tracker.setScreenShare(U, 'TR_1', true);
    expect(last()).toMatchObject({ state: 'online', auto: null });
    tracker.setMeeting(U, true);
    expect(last()).toMatchObject({ state: 'dnd', auto: 'screen_share' });
    // Two shares: it stays until the last one stops.
    tracker.setScreenShare(U, 'TR_2', true);
    tracker.setScreenShare(U, 'TR_1', false);
    expect(last().auto).toBe('screen_share');
    tracker.setChoice(U, choice({ visibility: 'dnd' }));
    expect(last()).toMatchObject({ state: 'dnd', auto: null });
    // The automatic statuses switched off: neither presenting nor in a meeting.
    tracker.setChoice(U, choice({ autoMeeting: false }));
    expect(last()).toMatchObject({ state: 'online', auto: null });
    tracker.setChoice(U, choice({}));
    expect(last().auto).toBe('screen_share');
    tracker.setScreenShare(U, 'TR_2', false);
    expect(last()).toMatchObject({ state: 'busy', auto: 'meeting' });
    // Leaving the meeting clears any share left over.
    tracker.setScreenShare(U, 'TR_3', true);
    tracker.setMeeting(U, false);
    tracker.setMeeting(U, true);
    expect(last()).toMatchObject({ state: 'busy', auto: 'meeting' });
    tracker.close();
  });

  it('shows a meeting joined without an open app, then offline when it ends', () => {
    const { tracker, last } = setup();
    tracker.setMeeting(U, true, choice({}));
    expect(tracker.get(U)).toMatchObject({ state: 'busy', auto: 'meeting' });
    tracker.setMeeting(U, false);
    expect(last().state).toBe('offline');
    expect(tracker.get(U)).toBeNull();
    tracker.close();
  });

  it('a timed dnd ends on its own and is published', () => {
    const { tracker, last } = setup();
    tracker.connect('c1', U, null);
    const until = new Date(Date.now() + 30 * MIN);
    tracker.setChoice(U, choice({ visibility: 'dnd', visibilityUntil: until }));
    expect(last()).toMatchObject({ state: 'dnd', until: until.toISOString() });
    tracker.heartbeat('c1', U, true, true, null, { client: 'web', idleSeconds: 0 });
    vi.advanceTimersByTime(30 * MIN + 15_000);
    // No heartbeat came for 30 minutes, so the person is also idle by then.
    expect(last()).toMatchObject({ state: 'away', until: null });
    tracker.close();
  });

  it('goes offline 30 s after the last connection, with the last activity as last seen', () => {
    const { tracker, last, events } = setup();
    tracker.connect('c1', U, null);
    tracker.heartbeat('c1', U, true, true, null, { client: 'web', idleSeconds: 60 });
    tracker.disconnect('c1', U);
    vi.advanceTimersByTime(10_000);
    // A reload in the grace period does not flicker.
    tracker.connect('c2', U, null);
    tracker.disconnect('c2', U);
    expect(events.some((e) => e.state === 'offline')).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(last()).toMatchObject({
      state: 'offline',
      device: null,
      lastSeenAt: '2026-10-29T09:00:10.000Z',
    });
    tracker.close();
  });

  it('publishes only changes', () => {
    const { tracker, events } = setup();
    tracker.connect('c1', U, null);
    for (let i = 0; i < 5; i++) {
      tracker.heartbeat('c1', U, true, true, null, { client: 'web', idleSeconds: 0 });
      vi.advanceTimersByTime(25_000);
    }
    expect(events.filter((e) => e.state === 'online')).toHaveLength(2);
    tracker.close();
  });
});
