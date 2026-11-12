import { render, waitFor } from '@testing-library/react';
import { RoomEvent, Track } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

/** Just enough of a LiveKit room for the relay. */
function fakeRoom() {
  const handlers = new Map<string, Set<Handler>>();
  let screen: { track: object } | undefined;
  const room = {
    on: (event: string, h: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(h);
      return room;
    },
    off: (event: string, h: Handler) => {
      handlers.get(event)?.delete(h);
      return room;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
    localParticipant: {
      attributes: {} as Record<string, string>,
      getTrackPublication: (source: Track.Source) =>
        source === Track.Source.ScreenShare ? screen : undefined,
      setAttributes: vi.fn(async (a: Record<string, string>) => {
        Object.assign(room.localParticipant.attributes, a);
      }),
    },
    share: (on: boolean) => {
      screen = on ? { track: {} } : undefined;
    },
    handlers,
  };
  return room;
}

const ayse = { identity: 'u-ayse', name: 'Ayşe' };

function fakeControl() {
  return {
    allowed: true,
    requests: [] as Array<{ identity: string; name: string }>,
    controller: null as { identity: string; name: string } | null,
    grant: vi.fn(),
    deny: vi.fn(),
    revoke: vi.fn(),
  };
}

let room = fakeRoom();
let control = fakeControl();
vi.mock('@livekit/components-react', () => ({ useRoomContext: () => room }));
vi.mock('../src/components/meet/room/RemoteControl', () => ({ useRemoteControl: () => control }));

function fakeBridge(controllable: boolean) {
  let answer: ((identity: string, yes: boolean) => void) | null = null;
  let revoke: ((reason: string) => void) | null = null;
  const rc = {
    shareChanged: vi.fn(async (active: boolean) => ({ controllable: active && controllable })),
    setAllowed: vi.fn(),
    setRequests: vi.fn(),
    setController: vi.fn(),
    input: vi.fn(),
    end: vi.fn(),
    onAnswer: vi.fn((l: (identity: string, yes: boolean) => void) => {
      answer = l;
      return () => (answer = null);
    }),
    onRevoke: vi.fn((l: (reason: string) => void) => {
      revoke = l;
      return () => (revoke = null);
    }),
    answer: (identity: string, yes: boolean) => answer?.(identity, yes),
    revoke: (reason: string) => revoke?.(reason),
  };
  (window as { crewhallDesktop?: unknown }).crewhallDesktop = {
    isDesktop: true,
    platform: 'win32',
    remoteControl: rc,
  };
  return rc;
}

afterEach(() => {
  delete (window as { crewhallDesktop?: unknown }).crewhallDesktop;
  room = fakeRoom();
  control = fakeControl();
});

async function mount() {
  const { DesktopRemoteControl } = await import('../src/components/meet/room/DesktopRemoteControl');
  const view = render(<DesktopRemoteControl />);
  return { view, rerender: () => view.rerender(<DesktopRemoteControl />) };
}

describe('DesktopRemoteControl', () => {
  it('does nothing in a browser', async () => {
    await mount();
    expect(room.handlers.size).toBe(0);
  });

  it('passes requests, the controller and input to the app, and its decisions to the page', async () => {
    const rc = fakeBridge(true);
    control.requests = [ayse];
    const { view, rerender } = await mount();
    expect(rc.setRequests).toHaveBeenLastCalledWith([ayse]);
    expect(rc.setAllowed).toHaveBeenCalledWith(true);

    // The app's "Ver" grants through the page (which posts grant and writes the audit).
    rc.answer('u-ayse', true);
    expect(control.grant).toHaveBeenCalledWith(ayse);
    rc.answer('u-nobody', false);
    expect(control.deny).not.toHaveBeenCalled();

    control = { ...control, controller: ayse, requests: [] };
    rerender();
    await waitFor(() => expect(rc.setController).toHaveBeenLastCalledWith(ayse));

    const json = '{"type":"input","ev":{"k":"move","x":0.5,"y":0.5}}';
    const bytes = new TextEncoder().encode(json);
    room.emit(RoomEvent.DataReceived, bytes, ayse, undefined, 'meet.control');
    room.emit(RoomEvent.DataReceived, bytes, ayse, undefined, 'meet.signal');
    expect(rc.input).toHaveBeenCalledTimes(1);
    expect(rc.input).toHaveBeenCalledWith('u-ayse', json);

    // Stop / shortcut / own mouse in the app: the page revokes.
    rc.revoke('local_input');
    expect(control.revoke).toHaveBeenCalledTimes(1);

    room.emit(RoomEvent.Reconnecting);
    expect(rc.end).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(rc.end).toHaveBeenCalledTimes(2);
    expect(room.handlers.get(RoomEvent.DataReceived)?.size).toBe(0);
  });

  it('marks a whole-screen share the app can control, and clears the mark', async () => {
    fakeBridge(true);
    await mount();
    room.share(true);
    room.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.ScreenShare });
    await waitFor(() =>
      expect(room.localParticipant.attributes['crewhall.remoteControl']).toBe('1'),
    );
    room.share(false);
    room.emit(RoomEvent.LocalTrackUnpublished, { source: Track.Source.ScreenShare });
    await waitFor(() =>
      expect(room.localParticipant.attributes['crewhall.remoteControl']).toBe(''),
    );
  });

  it('leaves the mark off for a window share', async () => {
    fakeBridge(false);
    await mount();
    room.share(true);
    room.emit(RoomEvent.LocalTrackPublished, { source: Track.Source.ScreenShare });
    await new Promise((r) => setTimeout(r, 20));
    expect(room.localParticipant.setAttributes).not.toHaveBeenCalled();
  });
});
