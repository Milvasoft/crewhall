import { eq } from 'drizzle-orm';
import { users, type Db } from '@crewhall/db';
import {
  PRESENCE_LIMITS,
  type Presence,
  type PresenceDevice,
  type PresenceState,
  type StatusVisibility,
} from '@crewhall/shared';
import type { Logger } from '../logger';
import { presenceTopic, type Bus } from './bus';

/**
 * Presence (doc 17 §6, design 19.15), Teams-like: the union of a person's open connections.
 * - A device is active while its last input is under 15 minutes old and it is not locked
 *   (mobile: in the foreground). Clients send `idleSeconds`; older ones only `active`.
 * - The person shows the most active device: online > away; offline 30 s after the last
 *   connection closed (a reload does not flicker).
 * - Order over that: invisible (offline) > dnd > presenting (sharing the screen in a meeting:
 *   dnd, auto screen_share) > in a meeting (busy, auto meeting) > chosen busy > chosen away >
 *   activity. A chosen state with a passed `until` drops back to activity. Both automatic
 *   states follow the person's "Toplantıdayken otomatik" setting (autoMeeting).
 * - lastSeenAt is the last input on any device; it goes to users.last_seen_at at most every
 *   5 minutes and when the person goes offline.
 * A sweep re-reads everyone every 15 s, so time-based changes (idle, expiry) are published
 * without waiting for a heartbeat. Kept in process memory.
 */

export interface StatusChoice {
  visibility: StatusVisibility;
  visibilityUntil: Date | null;
  message: { text: string; emoji: string | null; expiresAt: Date | null } | null;
  /** "Toplantıdayken otomatik Toplantıda" (default on). */
  autoMeeting?: boolean;
}

export interface HeartbeatExtra {
  client?: PresenceDevice | undefined;
  idleSeconds?: number | undefined;
  locked?: boolean | undefined;
}

interface Conn {
  id: string;
  userId: string;
  client: PresenceDevice | null;
  active: boolean;
  focused: boolean;
  locked: boolean;
  /** Last input on this device; null for clients that only send `active`. */
  lastInputAt: number | null;
  lastBeat: number;
  /** Conversation on screen (H8: no notifications from it while focused). */
  activeConversationId: string | null;
}

interface UserEntry {
  conns: Map<string, Conn>;
  /** Pending switch to offline after the last connection closed. */
  offlineTimer: NodeJS.Timeout | null;
  /** State shown during the offline grace period. */
  lastState: PresenceState;
  lastDevice: PresenceDevice | null;
  /** Last input on any device (ms). */
  lastActiveAt: number;
  lastSeenWrite: number;
}

const OFFLINE_GRACE_MS = PRESENCE_LIMITS.offlineGraceSeconds * 1000;
const IDLE_MS = PRESENCE_LIMITS.idleMinutes * 60_000;
const LAST_SEEN_EVERY_MS = 5 * 60_000;
const SWEEP_MS = 15_000;
/** A connection counts as focused only while its heartbeats are fresh (every 25 s). */
const FOCUS_FRESH_MS = 40_000;
/** A visible tab on a computer counts as someone being there this long after the last input. */
const ATTENDED_MS = 2 * 60_000;

export interface PresenceReader {
  /** At least one visible (focused) web or mobile session: push is not needed. */
  hasFocusedSession(userId: string): boolean;
  /** The conversation is open on a visible session: no notification from it at all (H8). */
  isViewingConversation?(userId: string, conversationId: string): boolean;
  isConnected(userId: string): boolean;
  /** Connected and not invisible, for @here. */
  onlineUserIds(userIds: Iterable<string>): string[];
}

export class PresenceTracker implements PresenceReader {
  private readonly users = new Map<string, UserEntry>();
  private readonly choices = new Map<string, StatusChoice>();
  /** People in a live meeting or call (meet webhooks), connected or not. */
  private readonly inMeeting = new Set<string>();
  /** Screen share tracks a person publishes in meetings (LiveKit track webhooks). */
  private readonly sharing = new Map<string, Set<string>>();
  /** Last published presence per person, so only changes go out. */
  private readonly published = new Map<string, string>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly bus: Bus,
    private readonly db: Db | null,
    private readonly logger: Logger,
    private readonly graceMs = OFFLINE_GRACE_MS,
    sweepMs = SWEEP_MS,
  ) {
    this.sweeper = setInterval(() => this.sweep(), sweepMs);
    this.sweeper.unref?.();
  }

  /** Status from chat_user_settings, cached for connected people. */
  setChoice(userId: string, choice: StatusChoice) {
    this.choices.set(userId, choice);
    this.emit(userId);
  }

  /** Joined or left a meeting or call; `choice` for people not connected here. */
  setMeeting(userId: string, inMeeting: boolean, choice?: StatusChoice | null) {
    if (choice && !this.choices.has(userId)) this.choices.set(userId, choice);
    if (inMeeting) this.inMeeting.add(userId);
    else {
      this.inMeeting.delete(userId);
      // Out of every meeting: nothing is shared any more.
      this.sharing.delete(userId);
    }
    this.emit(userId);
    if (!inMeeting && !this.users.has(userId)) {
      this.choices.delete(userId);
      this.published.delete(userId);
    }
  }

  /** A screen share track started or stopped; a null track with `on: false` stops them all. */
  setScreenShare(userId: string, trackSid: string | null, on: boolean) {
    const tracks = this.sharing.get(userId) ?? new Set<string>();
    if (on && trackSid) tracks.add(trackSid);
    else if (trackSid) tracks.delete(trackSid);
    else tracks.clear();
    if (tracks.size) this.sharing.set(userId, tracks);
    else this.sharing.delete(userId);
    this.emit(userId);
  }

  connect(connId: string, userId: string, choice: StatusChoice | null) {
    const now = Date.now();
    let entry = this.users.get(userId);
    if (!entry) {
      entry = {
        conns: new Map(),
        offlineTimer: null,
        lastState: 'online',
        lastDevice: null,
        lastActiveAt: now,
        lastSeenWrite: 0,
      };
      this.users.set(userId, entry);
    }
    if (choice && !this.choices.has(userId)) this.choices.set(userId, choice);
    if (entry.offlineTimer) {
      clearTimeout(entry.offlineTimer);
      entry.offlineTimer = null;
    }
    // Opening the app is activity; the first heartbeat right after says more.
    entry.lastActiveAt = now;
    entry.conns.set(connId, {
      id: connId,
      userId,
      client: null,
      active: true,
      // Until its first heartbeat says so: a reconnect in the background must not hold pushes back.
      focused: false,
      locked: false,
      lastInputAt: null,
      lastBeat: now,
      activeConversationId: null,
    });
    this.emit(userId);
    this.touchLastSeen(userId, entry);
  }

  heartbeat(
    connId: string,
    userId: string,
    active: boolean,
    focused: boolean,
    activeConversationId?: string | null,
    extra: HeartbeatExtra = {},
  ) {
    const entry = this.users.get(userId);
    const conn = entry?.conns.get(connId);
    if (!entry || !conn) return;
    const now = Date.now();
    conn.active = active;
    conn.focused = focused;
    conn.locked = extra.locked ?? false;
    if (extra.client) conn.client = extra.client;
    conn.lastInputAt = extra.idleSeconds !== undefined ? now - extra.idleSeconds * 1000 : null;
    // Older clients don't send it: keep what they had (null).
    if (activeConversationId !== undefined) conn.activeConversationId = activeConversationId;
    conn.lastBeat = now;
    const input = conn.lastInputAt ?? (active && !conn.locked ? now : null);
    if (input !== null && input > entry.lastActiveAt) entry.lastActiveAt = Math.min(input, now);
    this.emit(userId);
    this.touchLastSeen(userId, entry);
  }

  disconnect(connId: string, userId: string) {
    const entry = this.users.get(userId);
    if (!entry) return;
    entry.conns.delete(connId);
    if (entry.conns.size > 0) {
      this.emit(userId);
      return;
    }
    entry.offlineTimer = setTimeout(() => {
      entry.offlineTimer = null;
      if (entry.conns.size > 0) return;
      this.users.delete(userId);
      this.emit(userId, entry.lastActiveAt);
      if (!this.inMeeting.has(userId)) {
        this.choices.delete(userId);
        this.published.delete(userId);
      }
      this.writeLastSeen(userId, entry.lastActiveAt);
    }, this.graceMs);
    entry.offlineTimer.unref?.();
  }

  isConnected(userId: string) {
    const entry = this.users.get(userId);
    return !!entry && (entry.conns.size > 0 || entry.offlineTimer !== null);
  }

  hasFocusedSession(userId: string) {
    const entry = this.users.get(userId);
    if (!entry) return false;
    const now = Date.now();
    for (const c of entry.conns.values()) if (attending(c, now)) return true;
    return false;
  }

  /** Every open connection of a person, for the push diagnostics. */
  sessions(userId: string) {
    const now = Date.now();
    return [...(this.users.get(userId)?.conns.values() ?? [])].map((c) => ({
      client: c.client,
      focused: c.focused,
      attending: attending(c, now),
      idleSeconds: c.lastInputAt === null ? null : Math.floor((now - c.lastInputAt) / 1000),
      beatSecondsAgo: Math.floor((now - c.lastBeat) / 1000),
      conversationId: c.activeConversationId,
    }));
  }

  /** The person has this conversation open on a visible session (H8). */
  isViewingConversation(userId: string, conversationId: string) {
    const entry = this.users.get(userId);
    if (!entry) return false;
    const now = Date.now();
    for (const c of entry.conns.values()) {
      if (attending(c, now) && c.activeConversationId === conversationId) {
        this.logger.debug({ userId, conversationId }, 'no notification: conversation on screen');
        return true;
      }
    }
    return false;
  }

  onlineUserIds(userIds: Iterable<string>) {
    const out: string[] = [];
    for (const id of userIds) {
      const state = this.state(id);
      if (state !== 'offline' && state !== 'away') out.push(id);
    }
    return out;
  }

  /** What others see; `null` when the tracker knows nothing (not connected, not in a meeting). */
  get(userId: string): Presence | null {
    const entry = this.users.get(userId);
    if (!entry && !this.inMeeting.has(userId)) return null;
    return this.build(userId, entry?.lastActiveAt ?? null);
  }

  state(userId: string): PresenceState {
    return this.resolve(userId).state;
  }

  /** Re-reads everyone known: idle devices, passed `until`s and expired messages go out. */
  sweep() {
    for (const id of new Set([...this.users.keys(), ...this.inMeeting])) this.emit(id);
  }

  private resolve(userId: string): {
    state: PresenceState;
    auto: Presence['auto'];
    device: PresenceDevice | null;
    until: Date | null;
  } {
    const entry = this.users.get(userId);
    const choice = this.liveChoice(userId);
    const connected = !!entry && (entry.conns.size > 0 || entry.offlineTimer !== null);
    const meeting = this.inMeeting.has(userId) && (choice?.autoMeeting ?? true);
    const offline = { state: 'offline' as const, auto: null, device: null, until: null };
    if (choice?.visibility === 'invisible' || (!connected && !meeting)) return offline;
    const activity = entry ? this.activity(entry) : { state: 'away' as const, device: null };
    const until = choice?.visibilityUntil ?? null;
    if (choice?.visibility === 'dnd')
      return { state: 'dnd', auto: null, device: activity.device, until };
    // Teams' "Sunuyor": like dnd, above "Toplantıda".
    if (meeting && this.sharing.has(userId)) {
      return { state: 'dnd', auto: 'screen_share', device: activity.device, until: null };
    }
    if (meeting) return { state: 'busy', auto: 'meeting', device: activity.device, until: null };
    if (choice?.visibility === 'busy' || choice?.visibility === 'away') {
      return { state: choice.visibility, auto: null, device: activity.device, until };
    }
    return { state: activity.state, auto: null, device: activity.device, until: null };
  }

  /** The most active device: online beats away; during the grace period the last one shown. */
  private activity(entry: UserEntry): { state: 'online' | 'away'; device: PresenceDevice | null } {
    if (entry.conns.size === 0) {
      return {
        state: entry.lastState === 'online' ? 'online' : 'away',
        device: entry.lastDevice,
      };
    }
    const now = Date.now();
    let best: Conn | null = null;
    let bestActive = false;
    for (const c of entry.conns.values()) {
      const active = connActive(c, now);
      if (
        !best ||
        (active && !bestActive) ||
        (active === bestActive &&
          (c.lastInputAt ?? c.lastBeat) > (best.lastInputAt ?? best.lastBeat))
      ) {
        best = c;
        bestActive = active;
      }
    }
    return { state: bestActive ? 'online' : 'away', device: best?.client ?? null };
  }

  private build(userId: string, lastActiveAt: number | null): Presence {
    const r = this.resolve(userId);
    const choice = this.liveChoice(userId);
    return {
      userId,
      state: r.state,
      auto: r.auto,
      message: choice?.message
        ? {
            text: choice.message.text,
            emoji: choice.message.emoji,
            expiresAt: choice.message.expiresAt?.toISOString() ?? null,
          }
        : null,
      lastSeenAt: lastActiveAt !== null ? new Date(lastActiveAt).toISOString() : null,
      device: r.state === 'offline' ? null : r.device,
      until: r.until?.toISOString() ?? null,
    };
  }

  /** A chosen state with a passed `until` counts as online again; expired messages drop. */
  private liveChoice(userId: string): StatusChoice | null {
    const choice = this.choices.get(userId);
    if (!choice) return null;
    const now = Date.now();
    const expired = choice.visibilityUntil && choice.visibilityUntil.getTime() <= now;
    const msgExpired = choice.message?.expiresAt && choice.message.expiresAt.getTime() <= now;
    if (!expired && !msgExpired) return choice;
    return {
      ...choice,
      visibility: expired ? 'online' : choice.visibility,
      visibilityUntil: expired ? null : choice.visibilityUntil,
      message: msgExpired ? null : choice.message,
    };
  }

  /** Publishes the person's presence when something others see changed. */
  private emit(userId: string, lastActiveAt?: number) {
    const entry = this.users.get(userId);
    const presence = this.build(userId, lastActiveAt ?? entry?.lastActiveAt ?? null);
    const key = [
      presence.state,
      presence.auto,
      presence.device,
      presence.until,
      presence.message?.text,
      presence.message?.emoji,
    ].join('|');
    if (this.published.get(userId) === key) return;
    this.published.set(userId, key);
    if (entry && presence.state !== 'offline' && entry.conns.size > 0) {
      const a = this.activity(entry);
      entry.lastState = a.state;
      entry.lastDevice = a.device;
    }
    this.bus.publish(presenceTopic(userId), { type: 'presence', presence });
  }

  private touchLastSeen(userId: string, entry: UserEntry) {
    const now = Date.now();
    if (now - entry.lastSeenWrite < LAST_SEEN_EVERY_MS) return;
    entry.lastSeenWrite = now;
    this.writeLastSeen(userId, entry.lastActiveAt);
  }

  private writeLastSeen(userId: string, at: number) {
    if (!this.db) return;
    this.db
      .update(users)
      .set({ lastSeenAt: new Date(at) })
      .where(eq(users.id, userId))
      .catch((err: unknown) => this.logger.warn({ err }, 'last_seen_at write failed'));
  }

  /** Stops the sweep and pending offline timers (server shutdown, tests). */
  close() {
    clearInterval(this.sweeper);
    for (const e of this.users.values()) if (e.offlineTimer) clearTimeout(e.offlineTimer);
    this.users.clear();
  }
}

/**
 * Someone is at this session, so a push would be noise. Visible is not enough on a computer: a
 * tab stays visible on an unattended PC all day, and the phone must ring then. A phone in the
 * foreground counts as it is: it locks itself.
 */
function attending(c: Conn, now: number): boolean {
  if (!c.focused || now - c.lastBeat > FOCUS_FRESH_MS) return false;
  if (c.client === 'mobile') return true;
  return c.lastInputAt !== null ? now - c.lastInputAt < ATTENDED_MS : c.active;
}

/** Input in the last 15 minutes, not locked, and (mobile) in the foreground. */
function connActive(c: Conn, now: number): boolean {
  if (c.locked) return false;
  if (c.client === 'mobile' && !c.focused) return false;
  if (c.lastInputAt !== null) return now - c.lastInputAt < IDLE_MS;
  return c.active;
}
