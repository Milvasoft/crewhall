/**
 * Per-device meeting choices (design 7.3 and 7.9: "Seçimler cihaz başına hatırlanır").
 * Browser storage may be unavailable (private mode): everything falls back to defaults.
 */
export interface MeetPrefs {
  audioInput: string | null;
  videoInput: string | null;
  audioOutput: string | null;
  joinMuted: boolean;
  joinCameraOff: boolean;
  blur: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  /** Send quality: auto uses 3-layer simulcast (design 7.9). */
  quality: 'auto' | '720p' | '360p';
  /** Receive the lowest layer of others' video. */
  dataSaver: boolean;
  /** Screen share: sharp text (few frames) or smooth motion (video). */
  shareMode: 'detail' | 'motion';
  /**
   * Screen share also sends the shared tab's or system's sound. Off by default: a share should
   * not leak notification sounds or music unless the presenter asks for it.
   */
  shareAudio: boolean;
  /** Guest name, remembered for the next invitation. */
  guestName: string;
  /** A short sound when someone joins or leaves the meeting. */
  joinLeaveSound: boolean;
}

const KEY = 'crewhall.meet.prefs';

export const DEFAULT_PREFS: MeetPrefs = {
  audioInput: null,
  videoInput: null,
  audioOutput: null,
  joinMuted: false,
  joinCameraOff: false,
  blur: false,
  noiseSuppression: true,
  echoCancellation: true,
  quality: 'auto',
  dataSaver: false,
  shareMode: 'detail',
  shareAudio: false,
  guestName: '',
  joinLeaveSound: true,
};

export function readPrefs(): MeetPrefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<MeetPrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(patch: Partial<MeetPrefs>): MeetPrefs {
  const next = { ...readPrefs(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked: keep in memory only */
  }
  return next;
}

/** A guest's pending knock survives a reload of the waiting page. */
export interface GuestTicket {
  requestId: string;
  secret: string;
  name: string;
}

const ticketKey = (slug: string) => `crewhall.meet.ticket.${slug}`;

export function readTicket(slug: string): GuestTicket | null {
  try {
    const raw = window.sessionStorage.getItem(ticketKey(slug));
    return raw ? (JSON.parse(raw) as GuestTicket) : null;
  } catch {
    return null;
  }
}

export function writeTicket(slug: string, ticket: GuestTicket | null) {
  try {
    if (ticket) window.sessionStorage.setItem(ticketKey(slug), JSON.stringify(ticket));
    else window.sessionStorage.removeItem(ticketKey(slug));
  } catch {
    /* ignore */
  }
}
