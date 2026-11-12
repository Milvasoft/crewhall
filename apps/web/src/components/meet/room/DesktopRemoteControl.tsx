import { MEET_CONTROL_TOPIC, MEET_REMOTE_CONTROL_ATTRIBUTE } from '@crewhall/shared';
import { useRoomContext } from '@livekit/components-react';
import {
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteParticipant,
} from 'livekit-client';
import { useEffect, useRef } from 'react';
import { desktopBridge, desktopHas } from '@/lib/desktop';
import { useRemoteControl } from './RemoteControl';

/**
 * The sharer's desktop app, when this page runs in it (renders nothing; does nothing in a
 * browser). Mounted inside RemoteControlProvider, which owns the protocol and the audit:
 * - marks a whole-screen share the app can control (MEET_REMOTE_CONTROL_ATTRIBUTE);
 * - gives the app the people asking (it asks on top of every window) and the person in control
 *   (it shows the "is controlling · Stop" band and applies that person's input);
 * - turns the app's answer into grant/deny and its "take back" (Stop, shortcut, own mouse) into
 *   revoke, so the page's prompt and the app's are one decision.
 */
export function DesktopRemoteControl() {
  const room = useRoomContext();
  const control = useRemoteControl();
  const rc = desktopHas('remoteControl') ? desktopBridge()?.remoteControl : undefined;
  const latest = useRef(control);
  useEffect(() => {
    latest.current = control;
  });

  useEffect(() => {
    if (!rc) return;
    const decoder = new TextDecoder();
    const onData = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      if (topic !== MEET_CONTROL_TOPIC || !participant) return;
      rc.input(participant.identity, decoder.decode(payload));
    };
    const syncShare = async () => {
      const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const { controllable } = await rc.shareChanged(Boolean(pub?.track));
      const current = room.localParticipant.attributes[MEET_REMOTE_CONTROL_ATTRIBUTE] ?? '';
      const wanted = controllable ? '1' : '';
      if (current !== wanted) {
        void room.localParticipant.setAttributes({ [MEET_REMOTE_CONTROL_ATTRIBUTE]: wanted });
      }
    };
    const onLocalTrack = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) void syncShare();
    };
    const onDrop = () => rc.end();
    const offAnswer = rc.onAnswer((identity, yes) => {
      const c = latest.current;
      const who = c.requests.find((r) => r.identity === identity);
      if (!who) return;
      if (yes) c.grant(who);
      else c.deny(who);
    });
    const offRevoke = rc.onRevoke(() => latest.current.revoke());

    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.LocalTrackPublished, onLocalTrack);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalTrack);
    room.on(RoomEvent.Reconnecting, onDrop);
    room.on(RoomEvent.Disconnected, onDrop);
    void syncShare();
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.LocalTrackPublished, onLocalTrack);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalTrack);
      room.off(RoomEvent.Reconnecting, onDrop);
      room.off(RoomEvent.Disconnected, onDrop);
      offAnswer();
      offRevoke();
      rc.end();
    };
  }, [room, rc]);

  const { allowed, requests, controller } = control;
  useEffect(() => {
    rc?.setAllowed(allowed);
  }, [rc, allowed]);
  useEffect(() => {
    rc?.setRequests(requests.map((r) => ({ identity: r.identity, name: r.name })));
  }, [rc, requests]);
  useEffect(() => {
    rc?.setController(controller ? { identity: controller.identity, name: controller.name } : null);
  }, [rc, controller]);

  return null;
}
