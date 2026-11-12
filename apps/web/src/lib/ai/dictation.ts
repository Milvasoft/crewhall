import { AI_LIMITS, AI_RAW_PATHS, AiTranscription, ApiErrorBody } from '@crewhall/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { config } from '@/config';
import { desktopBridge } from '@/lib/desktop';

/**
 * Sesle yazma for the question box. Browsers with speech recognition (Chrome, Edge, Safari) use
 * the Web Speech API and show the words as they are heard. Elsewhere (Firefox; the desktop app,
 * where the browser's speech service does not work) a short recording goes to the org's own
 * speech server, the one meeting notes use, when there is one.
 */

export type DictationEngine = 'speech' | 'server' | 'none';
export type DictationPhase = 'idle' | 'listening' | 'transcribing';
export type DictationError =
  'denied' | 'noMic' | 'noSpeech' | 'network' | 'failed' | { code: string };

/** The part of the Web Speech API used here (not in TypeScript's DOM types everywhere). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionEvent {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const inDesktopApp = () =>
  desktopBridge() !== null ||
  (typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent));

const canRecord = () =>
  typeof MediaRecorder !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia;

/** Which way dictation works here; `server` needs the org's speech server (AiStatus.dictation). */
export function dictationEngine(serverAvailable: boolean): DictationEngine {
  if (recognitionCtor() && !inDesktopApp()) return 'speech';
  if (serverAvailable && canRecord()) return 'server';
  return 'none';
}

const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function recordingType() {
  return RECORDING_TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
}

function speechError(code: string): DictationError | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return 'denied';
    case 'audio-capture':
      return 'noMic';
    case 'no-speech':
      return 'noSpeech';
    case 'network':
      return 'network';
    default:
      return 'failed';
  }
}

function mediaError(err: unknown): DictationError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noMic';
  return 'failed';
}

async function transcribeOnServer(blob: Blob, signal: AbortSignal): Promise<string> {
  const res = await fetch(new URL(AI_RAW_PATHS.transcribe, config.apiUrl), {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: { 'Content-Type': blob.type.split(';')[0] || 'audio/webm' },
    body: blob,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiErrorBody.safeParse(json);
    throw { code: err.success ? err.data.code : 'internal' };
  }
  return AiTranscription.parse(json).text;
}

interface Session {
  /** What the box held before: kept, and restored on cancel. */
  base: string;
  cancelled: boolean;
  recognition?: Recognition;
  recorder?: MediaRecorder;
  stream?: MediaStream;
  upload?: AbortController;
  timer?: ReturnType<typeof setInterval>;
}

const join = (base: string, text: string) =>
  !text ? base : !base || /\s$/.test(base) ? base + text : `${base} ${text}`;

/**
 * Dictation into a text box. `start` keeps what is already typed and adds the spoken words after
 * it; `cancel` (Esc) puts the box back as it was.
 */
export function useDictation(opts: {
  engine: DictationEngine;
  locale: 'tr' | 'en';
  value: string;
  onChange: (text: string) => void;
}) {
  const { engine, locale } = opts;
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<DictationError | null>(null);
  const latest = useRef(opts);
  useLayoutEffect(() => {
    latest.current = opts;
  });
  const session = useRef<Session | null>(null);

  const finish = useCallback(() => {
    const s = session.current;
    if (s?.timer) clearInterval(s.timer);
    s?.stream?.getTracks().forEach((t) => t.stop());
    session.current = null;
    setPhase('idle');
  }, []);

  const stop = useCallback(() => {
    const s = session.current;
    if (!s) return;
    if (s.recognition) s.recognition.stop();
    else if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    const s = session.current;
    if (!s) return;
    s.cancelled = true;
    latest.current.onChange(s.base);
    s.recognition?.abort();
    if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
    s.upload?.abort();
    finish();
  }, [finish]);

  const tick = useCallback(() => {
    const started = Date.now();
    setSeconds(0);
    return setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= AI_LIMITS.dictationSeconds) stop();
    }, 250);
  }, [stop]);

  const start = useCallback(async () => {
    if (session.current || engine === 'none') return;
    setError(null);
    const base = latest.current.value;
    if (engine === 'speech') {
      const Ctor = recognitionCtor()!;
      const rec = new Ctor();
      rec.lang = locale === 'tr' ? 'tr-TR' : 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let text = '';
        for (let i = 0; i < e.results.length; i++) text += e.results[i]![0].transcript;
        if (!session.current?.cancelled) latest.current.onChange(join(base, text.trim()));
      };
      rec.onerror = (e) => {
        const err = speechError(e.error);
        if (err) setError(err);
      };
      rec.onend = finish;
      session.current = { base, cancelled: false, recognition: rec };
      setPhase('listening');
      session.current.timer = tick();
      try {
        rec.start();
      } catch {
        setError('failed');
        finish();
      }
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setError(mediaError(err));
      return;
    }
    const type = recordingType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    const s: Session = { base, cancelled: false, recorder, stream };
    session.current = s;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (s.timer) clearInterval(s.timer);
      s.stream?.getTracks().forEach((t) => t.stop());
      if (s.cancelled) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
      if (!blob.size) {
        setError('noSpeech');
        finish();
        return;
      }
      setPhase('transcribing');
      s.upload = new AbortController();
      transcribeOnServer(blob, s.upload.signal)
        .then((text) => {
          if (!s.cancelled) {
            if (text.trim()) latest.current.onChange(join(base, text.trim()));
            else setError('noSpeech');
          }
        })
        .catch((err: unknown) => {
          if (s.cancelled) return;
          setError(
            typeof err === 'object' && err && 'code' in err ? (err as { code: string }) : 'network',
          );
        })
        .finally(() => {
          if (session.current === s) finish();
        });
    };
    recorder.start();
    setPhase('listening');
    s.timer = tick();
  }, [engine, locale, finish, tick]);

  useEffect(
    () => () => {
      // Leaving the panel drops a dictation in progress.
      const s = session.current;
      if (!s) return;
      s.cancelled = true;
      s.recognition?.abort();
      if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
      s.upload?.abort();
      if (s.timer) clearInterval(s.timer);
      s.stream?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  return {
    engine,
    phase,
    seconds,
    error,
    active: phase !== 'idle',
    start,
    stop,
    cancel,
    toggle: () => (phase === 'idle' ? void start() : phase === 'listening' ? stop() : undefined),
    clearError: () => setError(null),
  };
}
