import { MEET_ATTRIBUTES, MEET_REACTIONS } from '@crewhall/shared';
import {
  cn,
  Count,
  Icon,
  Kbd,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  NARROW_QUERY,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
  Tooltip,
  useMediaQuery,
} from '@crewhall/ui';
import {
  useLocalParticipant,
  useMediaDeviceSelect,
  useRoomContext,
} from '@livekit/components-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mediaAvailable } from '@/lib/meet/media';
import { readPrefs, writePrefs } from '@/lib/meet/prefs';
import { applyShareAudio, deviceClass, screenShareOptions } from '@/lib/meet/publish';
import { CamOff, DEVICE_LIST_CLASS, EndCallIcon, MicOff, useFail } from '@/components/meet/bits';
import { deviceLabel, useMediaDevices } from '@/lib/meet/devices';
import { handOf, publishRights, useRoomMeta, useRoomState } from './context';
import { isMediaPathError } from './mediaHealth';
import { useHands, useParticipantCount } from './roomHooks';

function BarButton({
  label,
  active,
  danger,
  pressed,
  onClick,
  children,
  disabled,
  className,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        // Not the disabled attribute: a disabled button gets no hover or focus, so its tooltip,
        // which says why it is off, would never show. A tap says it too (no hover on touch).
        aria-disabled={disabled || undefined}
        onClick={disabled ? () => toast(label) : onClick}
        className={cn(
          'relative flex h-11 min-w-10 items-center justify-center gap-1 rounded-xl px-2.5 text-white transition-colors sm:min-w-11 sm:px-3',
          disabled ? 'cursor-not-allowed bg-white/10 opacity-40' : 'bg-white/10 hover:bg-white/15',
          active && 'bg-white text-black hover:bg-white/90',
          danger &&
            'bg-[color-mix(in_srgb,var(--danger)_30%,transparent)] text-[#ffb4ae] hover:bg-[color-mix(in_srgb,var(--danger)_40%,transparent)]',
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <path
        d="M2 6.5 5 3.5 8 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The arrow next to mic and camera: pick a device. Without permission the devices have no names
 * ("Kamera 1") and "İzin ver" asks for it; an empty list says so instead of showing nothing.
 */
export function DeviceMenu({ kind, label }: { kind: MediaDeviceKind; label: string }) {
  const { t } = useI18n();
  const room = useRoomContext();
  const { activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    room,
    requestPermissions: false,
  });
  const { devices, needsPermission, allow } = useMediaDevices(kind);
  const fail = useFail();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="-ml-1 flex h-11 w-6 items-center justify-center rounded-r-xl bg-white/10 text-white hover:bg-white/15"
        >
          <Caret />
        </button>
      </MenuTrigger>
      <MenuContent align="center" side="top" className={DEVICE_LIST_CLASS}>
        <MenuLabel>{label}</MenuLabel>
        {devices.length === 0 ? <MenuItem disabled>{t('meet.devices.none')}</MenuItem> : null}
        {devices.map((d, i) => (
          <MenuItem
            key={`${d.deviceId}-${i}`}
            title={deviceLabel(d, i, t)}
            disabled={!d.deviceId}
            onSelect={() => {
              setActiveMediaDevice(d.deviceId).catch(fail);
              writePrefs(
                kind === 'audioinput' ? { audioInput: d.deviceId } : { videoInput: d.deviceId },
              );
            }}
          >
            {/* H12: the check in a fixed column on the name's line; other rows keep the gap. */}
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex w-3.5 shrink-0 justify-center">
                {d.deviceId === activeDeviceId ? <Icon name="check" size={14} /> : null}
              </span>
              <span className="min-w-0 truncate">{deviceLabel(d, i, t)}</span>
            </span>
          </MenuItem>
        ))}
        {needsPermission ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon="lock"
              onSelect={(e) => {
                // Stays open: the list fills in once the browser has asked.
                e.preventDefault();
                void allow();
              }}
            >
              {t('meet.devices.allow')}
            </MenuItem>
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** The arrow next to the share button: share the sound too or not (off by default). */
export function ShareMenu() {
  const { t } = useI18n();
  const { localParticipant } = useLocalParticipant();
  const [audio, setAudio] = useState(() => readPrefs().shareAudio);
  const fail = useFail();
  const toggle = () => {
    const next = !audio;
    setAudio(next);
    writePrefs({ shareAudio: next });
    applyShareAudio(localParticipant, next).then((r) => {
      if (r === 'next') toast(t('meet.controls.shareAudioNext'));
    }, fail);
  };
  return (
    // Read again on open: the settings dialog may have changed it.
    <Menu onOpenChange={(open) => open && setAudio(readPrefs().shareAudio)}>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={t('meet.controls.shareOptions')}
          className="-ml-1 flex h-11 w-6 items-center justify-center rounded-r-xl bg-white/10 text-white hover:bg-white/15"
        >
          <Caret />
        </button>
      </MenuTrigger>
      <MenuContent align="center" side="top" className="w-72">
        <MenuLabel>{t('meet.controls.shareOptions')}</MenuLabel>
        <MenuItem
          role="menuitemcheckbox"
          aria-checked={audio}
          onSelect={(e) => {
            // Stays open so the tick is seen to change.
            e.preventDefault();
            toggle();
          }}
        >
          <span className="flex min-w-0 items-start gap-2">
            <span className="flex w-3.5 shrink-0 justify-center pt-0.5">
              {audio ? <Icon name="check" size={14} /> : null}
            </span>
            <span className="flex min-w-0 flex-col">
              <span>{t('meet.controls.shareAudio')}</span>
              <span className="text-xs whitespace-normal text-fg3">
                {t('meet.controls.shareAudioHint')}
              </span>
            </span>
          </span>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Phone browsers have no screen capture (getDisplayMedia): no share button there. */
export function canCaptureScreen(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}

/**
 * Design 7.6: mic and camera (arrows pick devices), screen, hand, reactions, record,
 * settings, red leave; chat and people on the right. Shortcuts: Ctrl D, Ctrl E,
 * Ctrl Shift H, hold Space to talk. Phones keep mic, camera, hand and leave in the bar; devices
 * are picked in the settings; sharing, recording and settings sit under "Daha fazla".
 */
export function ControlBar({
  onRecord,
  onSettings,
  onLeave,
  onEndForAll,
  canRecord,
}: {
  onRecord: () => void;
  onSettings: () => void;
  onLeave: () => void;
  onEndForAll: () => void;
  canRecord: boolean;
}) {
  const { t } = useI18n();
  const fail = useFail();
  const state = useRoomState();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();
  const room = useRoomContext();
  const hands = useHands();
  const meta = useRoomMeta();
  const recording = Boolean(meta?.recording);
  const handUp = Boolean(handOf(localParticipant));
  const myHand = hands.indexOf(localParticipant.identity);
  const { canPublish, canShare } = publishRights(localParticipant);

  // Plain http on the LAN has no camera or microphone: listen only (lib/meet/media.ts).
  const media = mediaAvailable();
  const narrow = useMediaQuery(NARROW_QUERY);
  const share = canCaptureScreen();
  // Space viewers join as listeners (design 7.8): say why and offer to ask for the floor.
  const listener = !canPublish;
  const blockedLabel = !media
    ? t('meet.controls.needsHttps')
    : listener
      ? t('meet.controls.listenerOnly')
      : null;
  const shareBlocked =
    blockedLabel ??
    (canShare
      ? null
      : state.guest
        ? t('meet.controls.shareGuest')
        : t('meet.controls.shareNotAllowed'));
  // The media path failing (H9) shows the room's banner instead of a generic error toast.
  const publishFail = (e: unknown) => {
    if (isMediaPathError(e)) state.reportMediaIssue();
    else fail(e);
  };
  // Only turning something on can hit a broken media path; turning it off is never one.
  const toggleMic = async () => {
    const on = !isMicrophoneEnabled;
    if (media) await localParticipant.setMicrophoneEnabled(on).catch(on ? publishFail : fail);
  };
  const toggleCam = async () => {
    const on = !isCameraEnabled;
    if (media) await localParticipant.setCameraEnabled(on).catch(on ? publishFail : fail);
  };
  const toggleHand = () =>
    localParticipant
      .setAttributes({ [MEET_ATTRIBUTES.hand]: handUp ? '' : new Date().toISOString() })
      .catch(fail);
  const toggleScreen = async () => {
    if (!media) return;
    // Design 7.5: one share at a time.
    const other = [...room.remoteParticipants.values()].find((p) => p.isScreenShareEnabled);
    if (!isScreenShareEnabled && other) {
      toast(t('meet.room.takeOverShare', { name: other.name ?? '' }));
    }
    const prefs = readPrefs();
    const { capture, publish } = screenShareOptions(
      prefs.shareMode,
      deviceClass(),
      prefs.shareAudio,
    );
    await localParticipant
      .setScreenShareEnabled(!isScreenShareEnabled, capture, publish)
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === 'NotAllowedError') return;
        publishFail(e);
      });
  };

  // Keyboard shortcuts (design 7.6).
  const latest = useRef({ toggleMic, toggleCam, toggleHand, isMicrophoneEnabled });
  useEffect(() => {
    latest.current = { toggleMic, toggleCam, toggleHand, isMicrophoneEnabled };
  });
  useEffect(() => {
    let pushToTalk = false;
    const editable = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return el?.closest('input, textarea, [contenteditable="true"]') !== null;
    };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'd') {
        e.preventDefault();
        void latest.current.toggleMic();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && k === 'e') {
        e.preventDefault();
        void latest.current.toggleCam();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 'h') {
        e.preventDefault();
        void latest.current.toggleHand();
      } else if (
        e.code === 'Space' &&
        !e.repeat &&
        !editable(e) &&
        !latest.current.isMicrophoneEnabled &&
        mediaAvailable()
      ) {
        e.preventDefault();
        pushToTalk = true;
        void localParticipant.setMicrophoneEnabled(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && pushToTalk) {
        pushToTalk = false;
        void localParticipant.setMicrophoneEnabled(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [localParticipant]);

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
      {listener && media ? (
        <Tooltip content={t('meet.controls.listenerOnly')}>
          <button
            type="button"
            onClick={() => void toggleHand()}
            className={cn(
              'flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold',
              handUp ? 'bg-white text-black' : 'bg-accent text-black hover:brightness-95',
            )}
          >
            <Icon name="hand" size={16} />
            {handUp ? t('meet.controls.floorAsked') : t('meet.controls.askFloor')}
          </button>
        </Tooltip>
      ) : null}
      <span className="flex items-center">
        <BarButton
          label={
            blockedLabel ??
            (isMicrophoneEnabled ? t('meet.controls.micOff') : t('meet.controls.micOn'))
          }
          danger={!isMicrophoneEnabled}
          onClick={() => void toggleMic()}
          disabled={!canPublish || !media}
          className={media && !narrow ? 'rounded-r-none' : undefined}
        >
          {isMicrophoneEnabled ? <Icon name="mic" size={18} /> : <MicOff size={18} />}
        </BarButton>
        {media && !narrow ? (
          <DeviceMenu kind="audioinput" label={t('meet.settings.microphone')} />
        ) : null}
      </span>
      <span className="flex items-center">
        <BarButton
          label={
            blockedLabel ?? (isCameraEnabled ? t('meet.controls.camOff') : t('meet.controls.camOn'))
          }
          danger={!isCameraEnabled}
          onClick={() => void toggleCam()}
          disabled={!canPublish || !media}
          className={media && !narrow ? 'rounded-r-none' : undefined}
        >
          {isCameraEnabled ? <Icon name="video" size={18} /> : <CamOff size={18} />}
        </BarButton>
        {media && !narrow ? (
          <DeviceMenu kind="videoinput" label={t('meet.settings.camera')} />
        ) : null}
      </span>
      {share && !narrow ? (
        <span className="flex items-center">
          <BarButton
            label={
              shareBlocked ??
              (isScreenShareEnabled ? t('meet.controls.stopShare') : t('meet.controls.share'))
            }
            active={isScreenShareEnabled}
            onClick={() => void toggleScreen()}
            disabled={Boolean(shareBlocked)}
            className={shareBlocked ? undefined : 'rounded-r-none'}
          >
            <Icon name="screen" size={18} />
          </BarButton>
          {shareBlocked ? null : <ShareMenu />}
        </span>
      ) : null}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={handUp ? t('meet.controls.lowerHand') : t('meet.controls.raiseHand')}
            className={cn(
              'relative flex h-11 min-w-10 items-center justify-center rounded-xl px-2.5 text-white sm:min-w-11 sm:px-3',
              handUp ? 'bg-white text-black' : 'bg-white/10 hover:bg-white/15',
            )}
          >
            <Icon name="hand" size={18} />
            {handUp && myHand >= 0 ? (
              <span className="ml-1 text-xs font-bold">{myHand + 1}</span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="flex w-auto flex-col gap-2 p-2">
          <div className="flex gap-1">
            {MEET_REACTIONS.map((e) => (
              <button
                key={e}
                type="button"
                className="flex size-10 items-center justify-center rounded-lg text-2xl hover:bg-bg2"
                onClick={() => state.react(e)}
                aria-label={e}
              >
                {e}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void toggleHand()}
            className="flex items-center gap-2 rounded-lg bg-bg2 px-3 py-2 text-sm font-semibold hover:bg-capsule"
          >
            <Icon name="hand" size={16} />
            {handUp ? t('meet.controls.lowerHand') : t('meet.controls.raiseHand')}
            {handUp && myHand >= 0 ? (
              <span className="text-xs text-fg3">{t('meet.room.handYou', { n: myHand + 1 })}</span>
            ) : null}
            <Kbd className="ml-auto">Ctrl Shift H</Kbd>
          </button>
        </PopoverContent>
      </Popover>
      {narrow ? (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={t('meet.controls.more')}
              className="relative flex h-11 min-w-10 items-center justify-center rounded-xl bg-white/10 px-2.5 text-white"
            >
              <Icon name="dots" size={18} />
              {recording ? (
                <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-danger" />
              ) : null}
            </button>
          </MenuTrigger>
          <MenuContent side="top" align="center">
            {share ? (
              <MenuItem
                icon="screen"
                onSelect={() => (shareBlocked ? toast(shareBlocked) : void toggleScreen())}
              >
                {isScreenShareEnabled ? t('meet.controls.stopShare') : t('meet.controls.share')}
              </MenuItem>
            ) : null}
            {canRecord || recording ? (
              <MenuItem icon="record" danger={recording} onSelect={onRecord}>
                {recording ? t('meet.controls.stopRecording') : t('meet.controls.record')}
              </MenuItem>
            ) : null}
            <MenuItem icon="settings" onSelect={onSettings}>
              {t('meet.controls.settings')}
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : (
        <>
          {/* Guests can never record: nothing to explain, so nothing to show. */}
          {state.guest ? null : (
            <BarButton
              label={
                recording
                  ? t('meet.controls.stopRecording')
                  : canRecord
                    ? t('meet.controls.record')
                    : t('meet.controls.recordModeratorOnly')
              }
              active={recording}
              onClick={onRecord}
              disabled={!canRecord}
            >
              <Icon name="record" size={18} className={recording ? 'text-danger' : undefined} />
            </BarButton>
          )}
          <BarButton label={t('meet.controls.settings')} onClick={onSettings}>
            <Icon name="settings" size={18} />
          </BarButton>
        </>
      )}
      {state.moderator && !state.guest ? (
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={t('meet.controls.leave')}
              className="flex h-11 items-center justify-center gap-1 rounded-xl bg-danger px-4 text-white hover:brightness-95 sm:px-5"
            >
              <EndCallIcon size={22} />
            </button>
          </MenuTrigger>
          <MenuContent side="top" align="center">
            <MenuItem icon="callEnd" onSelect={onLeave}>
              {t('meet.controls.leave')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon="callEnd" danger onSelect={onEndForAll}>
              {t('meet.controls.endForAll')}
            </MenuItem>
          </MenuContent>
        </Menu>
      ) : (
        <Tooltip content={t('meet.controls.leave')}>
          <button
            type="button"
            aria-label={t('meet.controls.leave')}
            onClick={onLeave}
            className="flex h-11 items-center justify-center rounded-xl bg-danger px-4 text-white hover:brightness-95 sm:px-5"
          >
            <EndCallIcon size={22} />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export function SideButtons() {
  const { t } = useI18n();
  const state = useRoomState();
  const count = useParticipantCount();
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <BarButton
        label={t('meet.panels.chat')}
        active={state.panel === 'chat'}
        onClick={() => state.setPanel(state.panel === 'chat' ? null : 'chat')}
      >
        <Icon name="chat" size={18} />
        {state.unreadChat ? (
          <Count className="absolute -top-1.5 -right-1.5 bg-accent text-accent-fg">
            {state.unreadChat > 9 ? '9+' : state.unreadChat}
          </Count>
        ) : null}
      </BarButton>
      <BarButton
        label={t('meet.panels.people')}
        active={state.panel === 'people'}
        onClick={() => state.setPanel(state.panel === 'people' ? null : 'people')}
      >
        <Icon name="users" size={18} />
        <span className="text-xs font-bold">{count}</span>
        {state.moderator && state.lobbyWaiting ? (
          <Count className="absolute -top-1.5 -right-1.5 bg-accent text-accent-fg">
            {state.lobbyWaiting}
          </Count>
        ) : null}
      </BarButton>
    </div>
  );
}
