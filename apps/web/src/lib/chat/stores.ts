import { PRESENCE_LIMITS } from '@crewhall/shared';
import { useSyncExternalStore } from 'react';
import { type Presence } from './types';

/** Small external stores for the short-lived realtime state (never in the query cache). */

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

// ---- presence ----

const presence = createStore<ReadonlyMap<string, Presence>>(new Map());

export function setPresence(entries: Presence[]): void {
  if (entries.length === 0) return;
  const next = new Map(presence.get());
  for (const p of entries) next.set(p.userId, p);
  presence.set(next);
}

export function getPresence(userId: string): Presence | null {
  return presence.get().get(userId) ?? null;
}

export function usePresence(userId: string | null | undefined): Presence | null {
  return useSyncExternalStore(
    presence.subscribe,
    () => (userId ? (presence.get().get(userId) ?? null) : null),
    () => null,
  );
}

// ---- typing (3 s, doc 17 §6) ----

export const TYPING_TTL_MS = 3000;
const typing = createStore<ReadonlyMap<string, ReadonlyMap<string, number>>>(new Map());
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function noteTyping(conversationId: string, userId: string, ttlMs = TYPING_TTL_MS): void {
  const key = `${conversationId}:${userId}`;
  const next = new Map(typing.get());
  const inner = new Map(next.get(conversationId) ?? []);
  inner.set(userId, Date.now() + ttlMs);
  next.set(conversationId, inner);
  typing.set(next);
  const old = typingTimers.get(key);
  if (old) clearTimeout(old);
  typingTimers.set(
    key,
    setTimeout(() => clearTyping(conversationId, userId), ttlMs),
  );
}

/** A message from the person ends their typing signal right away. */
export function clearTyping(conversationId: string, userId: string): void {
  const inner = typing.get().get(conversationId);
  if (!inner?.has(userId)) return;
  const next = new Map(typing.get());
  const copy = new Map(inner);
  copy.delete(userId);
  next.set(conversationId, copy);
  typing.set(next);
  const key = `${conversationId}:${userId}`;
  const t = typingTimers.get(key);
  if (t) clearTimeout(t);
  typingTimers.delete(key);
}

const NONE: readonly string[] = [];
const typingCache = new Map<
  string,
  { src: ReadonlyMap<string, number> | undefined; ids: string[] }
>();

export function useTyping(conversationId: string): readonly string[] {
  return useSyncExternalStore(
    typing.subscribe,
    () => {
      const inner = typing.get().get(conversationId);
      if (!inner || inner.size === 0) return NONE;
      const cached = typingCache.get(conversationId);
      if (cached?.src === inner) return cached.ids;
      const ids = [...inner.keys()];
      typingCache.set(conversationId, { src: inner, ids });
      return ids;
    },
    () => NONE,
  );
}

// ---- which chat is on screen (no unread bump, read receipts) ----

const visible = createStore<string | null>(null);
export const setVisibleConversation = (id: string | null) => visible.set(id);
export const getVisibleConversation = () => visible.get();
export const subscribeVisibleConversation = (listener: () => void) => visible.subscribe(listener);
export function useVisibleConversation(): string | null {
  return useSyncExternalStore(visible.subscribe, visible.get, () => null);
}

/**
 * Someone is looking at this page: visible and its window focused. "Visible" alone is also true
 * for a desktop window behind others on a second screen, or a tab nobody is at: the open chat was
 * then marked read and kept quiet while its alerts went unseen.
 */
export function isLooking(): boolean {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return false;
  return typeof document.hasFocus !== 'function' || document.hasFocus();
}

// ---- activity (presence away after 15 minutes) ----

export const AWAY_AFTER_MS = PRESENCE_LIMITS.idleMinutes * 60_000;
let lastActivity = Date.now();
export function noteActivity(): void {
  lastActivity = Date.now();
}
export function isActive(): boolean {
  return Date.now() - lastActivity < AWAY_AFTER_MS;
}
export function idleSeconds(): number {
  return Math.max(0, Math.floor((Date.now() - lastActivity) / 1000));
}

/** Tests start every case from a clean slate. */
export function resetChatStores(): void {
  presence.set(new Map());
  typing.set(new Map());
  typingTimers.forEach((t) => clearTimeout(t));
  typingTimers.clear();
  typingCache.clear();
  visible.set(null);
  lastActivity = Date.now();
}
