import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, type Room } from 'livekit-client';
import { useEffect, useState } from 'react';
import { handOf } from './context';

/**
 * Narrow subscriptions for the room's always-visible parts. LiveKit's useParticipants re-renders
 * on every room event (speaking, connection quality, ...), several times a second in a lively
 * meeting; the stage and the control bar only need these.
 */

/** Raised hands in order (design 7.6, 7.8): changes only when a hand goes up or down. */
export function handQueue(room: Room): string[] {
  return [room.localParticipant, ...room.remoteParticipants.values()]
    .filter((p) => handOf(p))
    .sort((a, b) => handOf(a).localeCompare(handOf(b)))
    .map((p) => p.identity);
}

const HAND_EVENTS = [
  RoomEvent.ParticipantAttributesChanged,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
] as const;

export function useHands(): string[] {
  const room = useRoomContext();
  const [hands, setHands] = useState(() => handQueue(room));
  useEffect(() => {
    const update = () =>
      setHands((cur) => {
        const next = handQueue(room);
        return next.join() === cur.join() ? cur : next;
      });
    update();
    HAND_EVENTS.forEach((e) => room.on(e, update));
    return () => HAND_EVENTS.forEach((e) => room.off(e, update));
  }, [room]);
  return hands;
}

/** People in the room (me included): changes only when someone comes or goes. */
export function useParticipantCount(): number {
  const room = useRoomContext();
  const [count, setCount] = useState(() => room.remoteParticipants.size + 1);
  useEffect(() => {
    const update = () => setCount(room.remoteParticipants.size + 1);
    update();
    room.on(RoomEvent.ParticipantConnected, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    return () => {
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
    };
  }, [room]);
  return count;
}
