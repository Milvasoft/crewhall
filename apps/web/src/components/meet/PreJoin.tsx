import {
  Avatar,
  Button,
  cn,
  Icon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import {
  createLocalAudioTrack,
  createLocalVideoTrack,
  Room,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { mediaAvailable } from '@/lib/meet/media';
import { readPrefs, writePrefs } from '@/lib/meet/prefs';
import { deviceLabel } from '@/lib/meet/devices';
import { CamOff, DEVICE_LIST_CLASS, MicOff, RecDot } from './bits';
import { type JoinChoices } from './room/RoomView';

/**
 * Design 7.3 / 7.13: mirrored camera preview, mic level bar, device choice (remembered per
 * device). Nothing is sent to the server here; tracks stop when the room takes over.
 */
export function PreJoin({
  heading,
  title,
  subtitle,
  inside,
  insideCount,
  recording,
  name,
  joinLabel,
  joining,
  canJoin = true,
  onJoin,
  children,
  footnote,
  elsewhere,
}: {
  heading: string;
  title: string;
  subtitle?: ReactNode;
  inside: { name: string; imageUrl?: string | null }[];
  insideCount: number;
  recording: boolean;
  name: string;
  joinLabel: string;
  joining: boolean;
  canJoin?: boolean;
  onJoin: (c: JoinChoices) => void;
  children?: ReactNode;
  footnote?: ReactNode;
  /** I am in this meeting on another device: move it here, or add this device. */
  elsewhere?: {
    note: string;
    transferLabel: string;
    addLabel: string;
    onTransfer: (c: JoinChoices) => void;
    onAdd: () => void;
  };
}) {
  const { t } = useI18n();
  const [prefs] = useState(readPrefs);
  // Plain http on the LAN: no camera or microphone, joining as a listener still works.
  const [media] = useState(mediaAvailable);
  const [micOn, setMicOn] = useState(media && !prefs.joinMuted);
  const [camOn, setCamOn] = useState(media && !prefs.joinCameraOff);
  const [video, setVideo] = useState<LocalVideoTrack | null>(null);
  const [audio, setAudio] = useState<LocalAudioTrack | null>(null);
  const [denied, setDenied] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(prefs.audioInput ?? '');
  const [camId, setCamId] = useState(prefs.videoInput ?? '');
  const [spkId, setSpkId] = useState(prefs.audioOutput ?? '');
  const videoEl = useRef<HTMLVideoElement>(null);
  const level = useMicLevel(micOn ? audio : null);

  const refreshDevices = async () => {
    try {
      const [a, v, o] = await Promise.all([
        Room.getLocalDevices('audioinput', false),
        Room.getLocalDevices('videoinput', false),
        Room.getLocalDevices('audiooutput', false),
      ]);
      setMics(a);
      setCams(v);
      setSpeakers(o);
    } catch {
      /* no devices */
    }
  };

  useEffect(() => {
    if (!camOn || !media) return;
    let track: LocalVideoTrack | null = null;
    let cancelled = false;
    createLocalVideoTrack({
      deviceId: camId || undefined,
      resolution: { width: 1280, height: 720 },
    })
      .then((tr) => {
        if (cancelled) return tr.stop();
        track = tr;
        setVideo(tr);
        setDenied(false);
        void refreshDevices();
      })
      .catch(() => setDenied(true));
    return () => {
      cancelled = true;
      track?.stop();
    };
  }, [camOn, camId, media]);

  useEffect(() => {
    if (!media) return;
    let track: LocalAudioTrack | null = null;
    let cancelled = false;
    createLocalAudioTrack({ deviceId: micId || undefined })
      .then((tr) => {
        if (cancelled) return tr.stop();
        track = tr;
        setAudio(tr);
        void refreshDevices();
      })
      .catch(() => setDenied(true));
    return () => {
      cancelled = true;
      track?.stop();
    };
  }, [micId, media]);

  useEffect(() => {
    const el = videoEl.current;
    if (!el || !video) return;
    video.attach(el);
    return () => {
      video.detach(el);
    };
  }, [video]);

  const join = (send: (c: JoinChoices) => void = onJoin) => {
    writePrefs({
      joinMuted: !micOn,
      joinCameraOff: !camOn,
      audioInput: micId || null,
      videoInput: camId || null,
      audioOutput: spkId || null,
    });
    video?.stop();
    audio?.stop();
    send({ audio: media && micOn && !denied, video: media && camOn && !denied });
  };

  return (
    <div className="mx-auto grid w-full max-w-[1040px] items-center gap-6 p-4 sm:gap-8 sm:p-6 lg:grid-cols-[1.35fr_1fr]">
      <div className="flex flex-col gap-3">
        <div
          data-theme="dark"
          className={cn(
            'relative overflow-hidden rounded-3xl bg-[#1a1b1d] text-white',
            // A message may need more than a 16:9 card on a phone.
            media && !denied
              ? 'aspect-video'
              : 'aspect-video max-sm:aspect-auto max-sm:min-h-[240px]',
          )}
        >
          {!media ? (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
              <Icon name="lock" size={28} />
              <span className="text-[15px] font-bold">{t('meet.prejoin.insecureTitle')}</span>
              <span className="max-w-[380px] text-sm text-white/70">
                {t('meet.prejoin.insecureBody')}
              </span>
            </div>
          ) : denied ? (
            <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
              <Icon name="video" size={28} />
              <span className="text-[15px] font-bold">{t('meet.prejoin.permissionTitle')}</span>
              <span className="max-w-[340px] text-sm text-white/70">
                {t('meet.prejoin.permissionBody')}
              </span>
              <Button size="sm" variant="pri" onClick={() => window.location.reload()}>
                {t('meet.prejoin.permissionRetry')}
              </Button>
            </div>
          ) : camOn && video ? (
            <video
              ref={videoEl}
              autoPlay
              muted
              playsInline
              className="size-full -scale-x-100 object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center">
              <Avatar name={name || '?'} size="xl" className="bg-white/10 text-white" />
            </div>
          )}
          {/* The preview's labels; a message (no camera, no permission) has the card to itself. */}
          {media && !denied ? (
            <>
              <span className="absolute bottom-3 left-3 rounded-md bg-black/55 px-2 py-1 text-xs font-semibold">
                {name ? t('meet.room.you', { name: name.split(' ')[0] ?? '' }) : t('meet.chat.you')}
              </span>
              <span className="absolute top-3 right-3 rounded-md bg-black/55 px-2 py-1 text-[11px] text-white/80">
                {t('meet.prejoin.onlyYou')}
              </span>
            </>
          ) : null}
          {media ? (
            <div
              className={cn(
                'absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-2',
                denied && 'hidden',
              )}
            >
              <button
                type="button"
                aria-label={micOn ? t('meet.controls.micOff') : t('meet.controls.micOn')}
                onClick={() => setMicOn(!micOn)}
                className={cn(
                  'flex size-11 items-center justify-center rounded-full',
                  micOn ? 'bg-white/15 hover:bg-white/25' : 'bg-danger text-white',
                )}
              >
                {micOn ? <Icon name="mic" size={18} /> : <MicOff size={18} />}
              </button>
              <button
                type="button"
                aria-label={camOn ? t('meet.controls.camOff') : t('meet.controls.camOn')}
                onClick={() => setCamOn(!camOn)}
                className={cn(
                  'flex size-11 items-center justify-center rounded-full',
                  camOn ? 'bg-white/15 hover:bg-white/25' : 'bg-danger text-white',
                )}
              >
                {camOn ? <Icon name="video" size={18} /> : <CamOff size={18} />}
              </button>
            </div>
          ) : null}
        </div>
        <div
          className={cn('flex items-center gap-3 rounded-xl bg-bg2 px-4 py-3', !media && 'hidden')}
        >
          <Icon name="mic" size={16} />
          <span className="text-sm font-semibold">{t('meet.settings.microphone')}</span>
          <span className="text-xs text-fg3">{t('meet.prejoin.speakHint')}</span>
          <span className="ml-auto flex h-2 w-40 overflow-hidden rounded-full bg-line2">
            <span
              className="h-full bg-success transition-[width] duration-75"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{heading}</span>
          <h1 className="text-h1 font-bold">{title}</h1>
          {subtitle ? <p className="text-sm text-fg2">{subtitle}</p> : null}
        </div>
        {insideCount ? (
          <div className="flex items-center gap-2">
            <span className="flex">
              {inside.slice(0, 4).map((p, i) => (
                <Avatar
                  key={i}
                  name={p.name}
                  src={p.imageUrl}
                  size="md"
                  className={cn(i > 0 && '-ml-2', 'ring-2 ring-bg')}
                />
              ))}
            </span>
            <span className="text-sm text-fg2">
              {t('meet.prejoin.inside', { count: insideCount })}
            </span>
          </div>
        ) : (
          <p className="text-sm text-fg2">{t('meet.prejoin.nobody')}</p>
        )}
        {children}
        <div className={cn('flex flex-col gap-3', !media && 'hidden')}>
          <DeviceSelect
            icon="video"
            label={t('meet.settings.camera')}
            devices={cams}
            value={camId}
            onChange={setCamId}
          />
          <DeviceSelect
            icon="mic"
            label={t('meet.settings.microphone')}
            devices={mics}
            value={micId}
            onChange={setMicId}
          />
          {speakers.length ? (
            <DeviceSelect
              icon="speaker"
              label={t('meet.settings.speaker')}
              devices={speakers}
              value={spkId}
              onChange={setSpkId}
            />
          ) : null}
        </div>
        {elsewhere ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">{elsewhere.note}</p>
            <Button
              variant="pri"
              size="lg"
              full
              loading={joining}
              disabled={!canJoin}
              onClick={() => join(elsewhere.onTransfer)}
            >
              {elsewhere.transferLabel}
            </Button>
            <Button
              variant="out"
              size="lg"
              full
              disabled={!canJoin || joining}
              onClick={() => join(elsewhere.onAdd)}
            >
              {elsewhere.addLabel}
            </Button>
          </div>
        ) : (
          <Button
            variant="pri"
            size="lg"
            full
            loading={joining}
            disabled={!canJoin}
            onClick={() => join()}
          >
            {joinLabel}
          </Button>
        )}
        <p
          className={cn(
            'flex items-center gap-2 text-xs',
            recording ? 'font-semibold text-danger' : 'text-fg3',
          )}
        >
          {recording ? <RecDot /> : null}
          {recording ? t('meet.prejoin.recording') : (footnote ?? t('meet.prejoin.notRecording'))}
        </p>
      </div>
    </div>
  );
}

function DeviceSelect({
  icon,
  label,
  devices,
  value,
  onChange,
}: {
  icon: 'video' | 'mic' | 'speaker';
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  if (!devices.length) return null;
  const current = devices.some((d) => d.deviceId === value) ? value : devices[0]!.deviceId;
  return (
    <label className="flex items-center gap-3">
      <span className="flex w-28 shrink-0 items-center gap-2 text-sm text-fg2">
        <Icon name={icon} size={16} />
        {label}
      </span>
      <Select value={current || 'default'} onValueChange={onChange}>
        <SelectTrigger size="sm" className="min-w-0 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={DEVICE_LIST_CLASS}>
          {devices.map((d, i) => (
            <SelectItem
              key={`${d.deviceId || 'default'}-${i}`}
              value={d.deviceId || 'default'}
              check="start"
              title={deviceLabel(d, i, t)}
            >
              {deviceLabel(d, i, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

/** 0..1 input level from an analyser (design 7.3: "Konuş, çubuk hareket etmeli"). */
function useMicLevel(track: LocalAudioTrack | null) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track) return;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      setLevel(Math.min(1, peak / 64));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [track]);
  return track ? level : 0;
}
