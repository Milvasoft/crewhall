import { RoomEvent, type Room } from 'livekit-client';
import { useCallback, useEffect, useState } from 'react';

/**
 * Signalling (WebSocket) can work while the media path (WebRTC/ICE) does not: UDP and the ICE/TCP
 * port closed by a firewall, LiveKit behind a proxy, a wrong node_ip. LiveKit then reports
 * "negotiation timed out" and reconnects in a loop, and mic and camera silently stay off. This
 * watches the peer connections and says so (H9).
 */

export type IceState = RTCIceConnectionState | 'none';

export interface MediaHealth {
  blocked: boolean;
  publisher: IceState;
  subscriber: IceState;
  retry: () => void;
}

/** A media path that went down (failed, disconnected) warns after this long. */
const DOWN_MS = 5_000;
/** A media path that never comes up (stuck checking: firewall, H9) warns after this long. */
const NEVER_UP_MS = 15_000;
/** Reconnects in a row (without media coming up) that count as a blocked path. */
const RECONNECT_LIMIT = 2;

const up = (s: IceState) => s === 'connected' || s === 'completed';
const down = (s: IceState) => s === 'failed' || s === 'disconnected';

/** Publishing or connecting the media path failed (not a device or permission problem). */
export function isMediaPathError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (['NotAllowedError', 'NotFoundError', 'NotReadableError'].includes(e.name)) return false;
  return (
    ['NegotiationError', 'PublishTrackError', 'UnexpectedConnectionState'].includes(e.name) ||
    /negotiation|timed out|timeout|\bice\b|(peer|pc) ?connection|publish/i.test(e.message)
  );
}

/**
 * livekit-client 2.x defaults to one peer connection (`singlePeerConnection`): the publisher
 * connection also receives and there is no subscriber connection. Its "none" then read as a
 * receive path that never came up, and the room warned in every meeting with others in it.
 */
export function readIce(
  pc:
    | {
        publisher: { getICEConnectionState(): RTCIceConnectionState };
        subscriber?: { getICEConnectionState(): RTCIceConnectionState };
      }
    | undefined,
): { publisher: IceState; subscriber: IceState } {
  if (!pc) return { publisher: 'none', subscriber: 'none' };
  const publisher = pc.publisher.getICEConnectionState();
  return {
    publisher,
    subscriber: pc.subscriber ? pc.subscriber.getICEConnectionState() : publisher,
  };
}

function iceStates(room: Room): { publisher: IceState; subscriber: IceState } {
  return readIce(room.engine.pcManager);
}

/** What the room needs from the media path right now, and how it is doing. */
export interface HealthInput {
  /** A microphone, camera or screen of mine is on (muted or unpublished ones do not count). */
  needPublisher: boolean;
  /** Someone else has a live track I receive. */
  needSubscriber: boolean;
  ice: { publisher: IceState; subscriber: IceState };
  /** Since when each needed side has not been up (null: up, or not needed). */
  badSince: { publisher: number | null; subscriber: number | null };
  reconnects: number;
  now: number;
}

/**
 * Blocked only when media is expected and its path is really broken. A camera or microphone
 * switched off on purpose, being alone in the room or nobody publishing is not a failure.
 */
export function isBlocked(h: HealthInput): boolean {
  const side = (need: boolean, state: IceState, since: number | null) => {
    if (!need || up(state) || since === null) return false;
    const elapsed = h.now - since;
    return down(state) ? elapsed > DOWN_MS : elapsed > NEVER_UP_MS;
  };
  if (!h.needPublisher && !h.needSubscriber) return false;
  const anyUp = up(h.ice.publisher) || up(h.ice.subscriber);
  return (
    (h.reconnects >= RECONNECT_LIMIT && !anyUp) ||
    side(h.needPublisher, h.ice.publisher, h.badSince.publisher) ||
    side(h.needSubscriber, h.ice.subscriber, h.badSince.subscriber)
  );
}

/** Mine that are on (not muted), and others' that I receive and are on. */
export function mediaNeeds(room: Room): { needPublisher: boolean; needSubscriber: boolean } {
  const live = (pubs: Iterable<{ track?: unknown; isMuted: boolean }>) =>
    [...pubs].some((p) => Boolean(p.track) && !p.isMuted);
  return {
    needPublisher: live(room.localParticipant.trackPublications.values()),
    needSubscriber: [...room.remoteParticipants.values()].some((p) =>
      live(p.trackPublications.values()),
    ),
  };
}

interface Snapshot extends Omit<HealthInput, 'now'> {
  at: number;
}

const since = (prev: number | null, need: boolean, state: IceState, now: number) =>
  need && !up(state) ? (prev ?? now) : null;

/**
 * `reports` counts media-path errors seen elsewhere (initial publish, turning mic/camera on);
 * `wants` is what the person joined with (mic, camera), used by "Tekrar dene".
 */
export function useMediaHealth(
  room: Room,
  reports: number,
  wants: { audio: boolean; video: boolean },
): MediaHealth {
  const [wanted] = useState(wants);
  const [seenReports, setSeenReports] = useState(0);
  const [retryFailures, setRetryFailures] = useState(0);
  const [snap, setSnap] = useState<Snapshot>(() => ({
    ice: iceStates(room),
    at: Date.now(),
    badSince: { publisher: null, subscriber: null },
    reconnects: 0,
    needPublisher: false,
    needSubscriber: false,
  }));

  useEffect(() => {
    const read = (s: Snapshot): Snapshot => {
      const ice = iceStates(room);
      const now = Date.now();
      const needs = mediaNeeds(room);
      return {
        ...needs,
        ice,
        at: now,
        // Media came up: earlier trouble is over.
        reconnects: up(ice.publisher) || up(ice.subscriber) ? 0 : s.reconnects,
        badSince: {
          publisher: since(s.badSince.publisher, needs.needPublisher, ice.publisher, now),
          subscriber: since(s.badSince.subscriber, needs.needSubscriber, ice.subscriber, now),
        },
      };
    };
    const onReconnecting = () => setSnap((s) => ({ ...s, reconnects: s.reconnects + 1 }));
    room.on(RoomEvent.Reconnecting, onReconnecting);
    const tick = window.setInterval(() => setSnap(read), 2000);
    return () => {
      room.off(RoomEvent.Reconnecting, onReconnecting);
      window.clearInterval(tick);
    };
  }, [room]);

  const { ice } = snap;
  const blocked = reports + retryFailures > seenReports || isBlocked({ ...snap, now: snap.at });

  const retry = useCallback(() => {
    setSeenReports(reports + retryFailures);
    setSnap((s) => ({
      ...s,
      reconnects: 0,
      at: Date.now(),
      badSince: { publisher: null, subscriber: null },
    }));
    // Publishing again renegotiates the publisher connection.
    const again = (e: unknown) => {
      if (isMediaPathError(e)) setRetryFailures((n) => n + 1);
    };
    const local = room.localParticipant;
    if (wanted.audio || local.isMicrophoneEnabled) {
      void local.setMicrophoneEnabled(true).catch(again);
    }
    if (wanted.video || local.isCameraEnabled) void local.setCameraEnabled(true).catch(again);
  }, [reports, retryFailures, room, wanted]);

  return { blocked, publisher: ice.publisher, subscriber: ice.subscriber, retry };
}
