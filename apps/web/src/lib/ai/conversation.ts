import type { AiActResult, AiCitation, ErrorCode } from '@crewhall/shared';
import { useSyncExternalStore } from 'react';
import { useMe } from '@/lib/session';

/**
 * The last conversation of "Crewhall'a sor", kept outside the panel: closing the panel does not
 * stop a running answer, and reopening it (or reloading the page) brings the conversation back.
 * It is UI state, so it lives in sessionStorage, per person and org, and goes away with the tab:
 * on a shared computer the answers do not outlive the session. Only the newest turns are kept.
 */

export interface AskTurn {
  id: number;
  question: string;
  answer: string;
  citations: AiCitation[];
  /** `interrupted`: the page went away while it was running. */
  status: 'running' | 'done' | 'error' | 'interrupted';
  error: ErrorCode | null;
}

export interface ActTurn {
  id: number;
  request: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  result: AiActResult | null;
  error: ErrorCode | null;
}

export type AskMode = 'ask' | 'act';

export interface Conversation {
  mode: AskMode;
  ask: AskTurn[];
  act: ActTurn[];
}

/** Turns kept per mode; older ones drop off. */
export const KEPT_TURNS = 20;
const ANSWER_CHARS = 8_000;
const EMPTY: Conversation = { mode: 'ask', ask: [], act: [] };

let key: string | null = null;
let state: Conversation = EMPTY;
let nextId = 1;
const listeners = new Set<() => void>();
/** What is being typed in the panel: outlives the panel, not the page, and is never stored. */
let draft = '';

const storageKey = (orgId: string, userId: string) => `crewhall.ask.${orgId}.${userId}`;

function load(k: string): Conversation {
  try {
    const raw = sessionStorage.getItem(k);
    if (!raw) return EMPTY;
    const saved = JSON.parse(raw) as Partial<Conversation>;
    // Whatever was running belonged to a page that is gone.
    const stop = <T extends { status: string }>(t: T): T =>
      t.status === 'running' ? { ...t, status: 'interrupted' } : t;
    return {
      mode: saved.mode === 'act' ? 'act' : 'ask',
      ask: Array.isArray(saved.ask) ? saved.ask.map(stop) : [],
      act: Array.isArray(saved.act) ? saved.act.map(stop) : [],
    };
  } catch {
    return EMPTY;
  }
}

function save() {
  if (!key) return;
  try {
    const trimmed: Conversation = {
      mode: state.mode,
      ask: state.ask.slice(-KEPT_TURNS).map((t) => ({
        ...t,
        answer: t.answer.slice(0, ANSWER_CHARS),
      })),
      act: state.act.slice(-KEPT_TURNS),
    };
    sessionStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    // Storage full or blocked: the conversation still works for this page.
  }
}

/** Switches to the conversation of this person and org (on sign-in or org change). */
export function bindConversation(orgId: string | null, userId: string | null): void {
  const k = orgId && userId ? storageKey(orgId, userId) : null;
  if (k === key) return;
  key = k;
  draft = '';
  state = k ? load(k) : EMPTY;
  nextId = Math.max(0, ...state.ask.map((t) => t.id), ...state.act.map((t) => t.id)) + 1;
  listeners.forEach((l) => l());
}

export function updateConversation(fn: (c: Conversation) => Conversation): void {
  const next = fn(state);
  state = {
    ...next,
    ask: next.ask.slice(-KEPT_TURNS),
    act: next.act.slice(-KEPT_TURNS),
  };
  save();
  listeners.forEach((l) => l());
}

export const newTurnId = () => nextId++;

export const askDraft = () => draft;

export function keepAskDraft(text: string): void {
  draft = text;
}

export function useConversation(): Conversation {
  const me = useMe();
  bindConversation(me?.activeOrgId ?? null, me?.user.id ?? null);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}

/** Tests: forget the bound conversation (storage is cleared by the test setup). */
export function resetConversationStore(): void {
  key = null;
  draft = '';
  state = EMPTY;
  nextId = 1;
}
