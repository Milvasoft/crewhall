import {
  controlReliable,
  MEET_CONTROL_TOPIC,
  MEET_IDENTITY,
  MEET_REMOTE_CONTROL_ATTRIBUTE,
  MeetControlMessage,
  MeetRoomMeta,
  mayControl,
  type MeetControlInput,
} from '@crewhall/shared';
import { Button, cn, Icon, toast } from '@crewhall/ui';
import {
  useDataChannel,
  useLocalParticipant,
  useParticipantAttributes,
  useRoomContext,
} from '@livekit/components-react';
import { RoomEvent, Track, type LocalTrackPublication, type Participant } from 'livekit-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { buttonOf, keyInput, normalizePoint, throttleMoves, wheelPixels } from '@/lib/meet/control';
import { useRoomMeta, useRoomState } from './context';

/**
 * Remote control of a shared screen ("Denetimi iste / ver"). Messages travel on the LiveKit
 * data channel (MEET_CONTROL_TOPIC). Only the desktop app can be controlled: it marks its
 * whole-screen share with MEET_REMOTE_CONTROL_ATTRIBUTE and applies the input itself. The web
 * is the controlling side, and shows the sharer's prompt ("X denetim istiyor: Ver / Reddet"),
 * which the desktop app also displays because it wraps the web.
 */

interface Person {
  identity: string;
  name: string;
}

interface ControlState {
  /** The room allows it (org and meeting settings) and I am not a guest. */
  allowed: boolean;
  /** Viewer: the sharer I asked, the sharer I control. */
  pending: string | null;
  controlling: string | null;
  request: (sharer: Participant) => void;
  release: () => void;
  sendInput: (ev: MeetControlInput) => void;
  /** Sharer: people asking, the one in control. */
  requests: Person[];
  controller: Person | null;
  grant: (p: Person) => void;
  deny: (p: Person) => void;
  revoke: () => void;
}

const ControlCtx = createContext<ControlState | null>(null);

export function useRemoteControl(): ControlState {
  const v = useContext(ControlCtx);
  if (!v) throw new Error('useRemoteControl outside the room');
  return v;
}

const encode = (m: MeetControlMessage) => new TextEncoder().encode(JSON.stringify(m));

function decode(payload: Uint8Array): MeetControlMessage | null {
  try {
    const r = MeetControlMessage.safeParse(JSON.parse(new TextDecoder().decode(payload)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function RemoteControlProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const room = useRoomContext();
  const state = useRoomState();
  const meta = useRoomMeta();
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const allowed =
    !state.guest &&
    meta?.remoteControl !== false &&
    state.meeting?.permissions.remoteControl !== false;
  const [pending, setPending] = useState<string | null>(null);
  const [controlling, setControlling] = useState<string | null>(null);
  const [requests, setRequests] = useState<Person[]>([]);
  const [controller, setController] = useState<Person | null>(null);

  const onMessage = useRef<(m: MeetControlMessage, from: Participant) => void>(() => undefined);
  const { send } = useDataChannel(MEET_CONTROL_TOPIC, (msg) => {
    const m = decode(msg.payload);
    if (m && msg.from) onMessage.current(m, msg.from);
  });
  const post = useCallback(
    (m: MeetControlMessage, to?: string[]) =>
      void send(encode(m), {
        reliable: controlReliable(m),
        ...(to ? { destinationIdentities: to } : {}),
      }).catch(() => undefined),
    [send],
  );

  const report = useCallback(
    (event: 'granted' | 'revoked', identity: string) => {
      const id = MEET_IDENTITY.parse(identity);
      if (!state.meeting || id?.kind !== 'user') return;
      void api
        .call('reportRemoteControl', {
          params: { meetingId: state.meeting.id },
          body: { event, userId: id.id },
        })
        .catch(() => undefined);
    },
    [state.meeting],
  );

  const me = localParticipant.identity;
  useEffect(() => {
    onMessage.current = (m, from) => {
      switch (m.type) {
        case 'request':
          // Only someone sharing their screen is asked; guests never get control.
          if (!isScreenShareEnabled || !allowed || !mayControl(from.identity)) return;
          setRequests((rs) =>
            rs.some((r) => r.identity === from.identity)
              ? rs
              : [...rs, { identity: from.identity, name: from.name || from.identity }],
          );
          return;
        case 'grant':
          if (m.to === me) {
            setPending(null);
            setControlling(from.identity);
          } else if (controlling === from.identity) {
            // Control moved to someone else.
            setControlling(null);
          }
          return;
        case 'deny':
          if (m.to === me && pending === from.identity) {
            setPending(null);
            toast(t('meet.control.denied', { name: from.name || from.identity }));
          }
          return;
        case 'revoke':
          if (controlling === from.identity) {
            setControlling(null);
            toast(t('meet.control.revoked', { name: from.name || from.identity }));
          }
          if (pending === from.identity) setPending(null);
          return;
        case 'release':
          if (controller?.identity === from.identity) {
            setController(null);
            report('revoked', from.identity);
          }
          return;
        case 'input':
          // Applied by the desktop app (it wraps this page and listens on the same topic).
          return;
      }
    };
  });

  const revoke = useCallback(() => {
    if (!controller) return;
    post({ type: 'revoke' });
    report('revoked', controller.identity);
    setController(null);
  }, [controller, post, report]);

  // Sharing stopped, or a moderator turned it off: control ends (LiveKit events, not render).
  const latest = useRef({ controller, revoke });
  useEffect(() => {
    latest.current = { controller, revoke };
  });
  useEffect(() => {
    const stop = () => {
      if (latest.current.controller) latest.current.revoke();
      setRequests([]);
    };
    const onUnpublished = (pub: LocalTrackPublication) => {
      if (pub.source === Track.Source.ScreenShare) stop();
    };
    const onMeta = (metadata: string) => {
      try {
        if (MeetRoomMeta.parse(JSON.parse(metadata)).remoteControl === false) {
          stop();
          setControlling(null);
          setPending(null);
        }
      } catch {
        /* not ours */
      }
    };
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.RoomMetadataChanged, onMeta);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.RoomMetadataChanged, onMeta);
    };
  }, [room]);

  const value = useMemo<ControlState>(
    () => ({
      allowed,
      pending: allowed ? pending : null,
      controlling: allowed ? controlling : null,
      request: (sharer) => {
        if (!allowed) return;
        setPending(sharer.identity);
        post({ type: 'request' }, [sharer.identity]);
      },
      release: () => {
        if (!controlling) return;
        post({ type: 'release' }, [controlling]);
        setControlling(null);
      },
      sendInput: (ev) => {
        if (controlling) post({ type: 'input', ev }, [controlling]);
      },
      requests: isScreenShareEnabled && allowed ? requests : [],
      controller,
      grant: (p) => {
        // One controller at a time: everyone sees the grant, the previous controller stops.
        post({ type: 'grant', to: p.identity });
        if (controller && controller.identity !== p.identity) {
          report('revoked', controller.identity);
        }
        setController(p);
        setRequests((rs) => rs.filter((r) => r.identity !== p.identity));
        report('granted', p.identity);
      },
      deny: (p) => {
        post({ type: 'deny', to: p.identity }, [p.identity]);
        setRequests((rs) => rs.filter((r) => r.identity !== p.identity));
      },
      revoke,
    }),
    [
      allowed,
      pending,
      controlling,
      requests,
      controller,
      post,
      report,
      revoke,
      isScreenShareEnabled,
    ],
  );
  return <ControlCtx.Provider value={value}>{children}</ControlCtx.Provider>;
}

/** The sharer's desktop app marks a whole-screen share it can apply input to. */
export function useControllable(p: Participant): boolean {
  const { attributes } = useParticipantAttributes({ participant: p });
  return attributes?.[MEET_REMOTE_CONTROL_ATTRIBUTE] === '1';
}

/**
 * On a remote screen share: "Denetim iste", and while in control, the input layer that turns
 * pointer, wheel and keys into protocol input (normalised to the picture, letterbox excluded).
 */
export function ScreenControl({ sharer, name }: { sharer: Participant; name: string }) {
  const { t } = useI18n();
  const control = useRemoteControl();
  const controllable = useControllable(sharer);
  const active = control.controlling === sharer.identity;
  if (!control.allowed || sharer.isLocal || (!controllable && !active)) return null;
  if (active) return <InputLayer name={name} />;
  const asked = control.pending === sharer.identity;
  return (
    <div className="absolute top-3 right-3 z-10">
      <Button
        size="sm"
        variant="out"
        disabled={asked}
        onClick={() => control.request(sharer)}
        className="bg-black/60 text-white"
      >
        <Icon name="cursor" size={14} />
        {asked ? t('meet.control.asked') : t('meet.control.request')}
      </Button>
    </div>
  );
}

function InputLayer({ name }: { name: string }) {
  const { t } = useI18n();
  const { sendInput, release } = useRemoteControl();
  const layer = useRef<HTMLDivElement>(null);
  const moves = useMemo(
    () => throttleMoves<{ x: number; y: number }>((p) => sendInput({ k: 'move', ...p })),
    [sendInput],
  );
  useEffect(() => () => moves.cancel(), [moves]);

  const point = (clientX: number, clientY: number) => {
    const el = layer.current;
    const video = el?.parentElement?.querySelector('video');
    if (!el || !video) return null;
    return normalizePoint(
      clientX,
      clientY,
      el.getBoundingClientRect(),
      video.videoWidth,
      video.videoHeight,
    );
  };

  // Wheel and keys need non-passive listeners to keep the page from scrolling or reacting.
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    el.focus();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      sendInput({ k: 'wheel', ...wheelPixels(e, el.clientHeight) });
    };
    const key = (down: boolean) => (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        if (down) release();
        return;
      }
      const ev = keyInput(e, down);
      if (ev) sendInput(ev);
    };
    const keydown = key(true);
    const keyup = key(false);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('keydown', keydown);
    el.addEventListener('keyup', keyup);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('keydown', keydown);
      el.removeEventListener('keyup', keyup);
    };
  }, [sendInput, release]);

  const button = (e: React.PointerEvent, k: 'down' | 'up') => {
    const b = buttonOf(e.button);
    const p = point(e.clientX, e.clientY);
    if (b === null || !p) return;
    e.preventDefault();
    if (k === 'down') {
      layer.current?.focus();
      layer.current?.setPointerCapture(e.pointerId);
    }
    sendInput({ k, b, ...p });
  };

  return (
    <>
      <div
        ref={layer}
        tabIndex={0}
        role="application"
        aria-label={t('meet.control.layer', { name })}
        className="absolute inset-0 z-10 cursor-crosshair rounded-2xl ring-4 ring-accent outline-none"
        onPointerMove={(e) => {
          const p = point(e.clientX, e.clientY);
          if (p) moves.push(p);
        }}
        onPointerDown={(e) => button(e, 'down')}
        onPointerUp={(e) => button(e, 'up')}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="absolute top-3 left-1/2 z-20 flex w-max max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-black">
        {t('meet.control.controlling', { name })}
        <Button size="xs" variant="out" className="bg-black/10" onClick={release}>
          {t('meet.control.release')}
        </Button>
      </div>
    </>
  );
}

/**
 * The sharer's prompt (web, and the desktop app that wraps it): who asks for control, and who
 * has it now.
 */
export function ControlPrompts() {
  const { t } = useI18n();
  const { requests, controller, grant, deny, revoke } = useRemoteControl();
  if (!requests.length && !controller) return null;
  return (
    <div className="absolute right-3 bottom-3 z-30 flex w-[min(320px,calc(100%-24px))] flex-col gap-2">
      {requests.map((p) => (
        <div
          key={p.identity}
          role="alertdialog"
          aria-label={t('meet.control.wants', { name: p.name })}
          className="flex flex-col gap-2 rounded-xl bg-[#1d1f21] p-3 text-sm text-white shadow-lg"
        >
          <span className="flex items-center gap-2 font-semibold">
            <Icon name="cursor" size={16} />
            {t('meet.control.wants', { name: p.name })}
          </span>
          <span className="flex gap-2">
            <Button size="sm" variant="pri" onClick={() => grant(p)}>
              {t('meet.control.grant')}
            </Button>
            <Button size="sm" variant="gh" className="text-white" onClick={() => deny(p)}>
              {t('meet.control.deny')}
            </Button>
          </span>
        </div>
      ))}
      {controller ? (
        <div
          className={cn(
            'flex items-center justify-between gap-2 rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-black',
          )}
        >
          {t('meet.control.isControlling', { name: controller.name })}
          <Button size="xs" variant="out" className="bg-black/10" onClick={revoke}>
            {t('meet.control.take')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
