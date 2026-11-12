import { AI_LIMITS, type AiSearchHit, paths, withQuery } from '@crewhall/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  newTurnId,
  updateConversation,
  useConversation,
  type ActTurn,
  type AskMode,
  type AskTurn,
} from './conversation';
import { clearDecisions, requestDecisions } from './decisions';
import { aiKeys } from './queries';
import { streamAsk } from './stream';
import { asCode } from './useAiRun';

/**
 * "Crewhall'a sor" (yol haritası #11): the side panel's open state (shared by the top bar,
 * Ctrl K and the shortcut) and its conversation.
 */

let panel: { open: boolean; question: string | null } = { open: false, question: null };
const listeners = new Set<() => void>();

/** Opens the panel; with `question` it is asked at once. */
export function openAsk(question: string | null = null): void {
  panel = { open: true, question };
  listeners.forEach((l) => l());
}

export function closeAsk(): void {
  panel = { open: false, question: null };
  listeners.forEach((l) => l());
}

export function useAskPanel() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => panel,
    () => panel,
  );
}

export type { ActTurn, AskMode, AskTurn } from './conversation';

/** The request running in the background (one at a time); "Durdur" aborts it. */
let running: AbortController | null = null;

const patchAsk = (id: number, fn: (t: AskTurn) => AskTurn) =>
  updateConversation((c) => ({ ...c, ask: c.ask.map((x) => (x.id === id ? fn(x) : x)) }));

/**
 * The panel's question/answer turns; follow-ups carry the last few turns as history. The answer
 * keeps streaming when the panel closes and is there when it opens again.
 */
export function useAskConversation() {
  const { locale } = useI18n();
  const qc = useQueryClient();
  const turns = useConversation().ask;
  const history = useRef<AskTurn[]>([]);
  history.current = turns;

  const stop = useCallback(() => {
    running?.abort();
    running = null;
    updateConversation((c) => ({
      ...c,
      ask: c.ask.map((x) => (x.status === 'running' ? { ...x, status: 'done' as const } : x)),
    }));
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim().slice(0, AI_LIMITS.questionChars);
      if (!q) return;
      running?.abort();
      const ctrl = new AbortController();
      running = ctrl;
      const id = newTurnId();
      const earlier = history.current
        .filter((x) => x.status === 'done' && x.answer)
        .slice(-AI_LIMITS.askHistory)
        .map((x) => ({ question: x.question, answer: x.answer.slice(0, 8_000) }));
      const patch = (fn: (t: AskTurn) => AskTurn) => patchAsk(id, fn);
      updateConversation((c) => ({
        ...c,
        ask: [
          ...c.ask,
          { id, question: q, answer: '', citations: [], status: 'running', error: null },
        ],
      }));
      try {
        await streamAsk(
          {
            question: q,
            history: earlier,
            locale,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          {
            signal: ctrl.signal,
            locale,
            onEvent: (e) => {
              if (ctrl.signal.aborted) return;
              if (e.type === 'citations') patch((t) => ({ ...t, citations: e.citations }));
              else if (e.type === 'delta') patch((t) => ({ ...t, answer: t.answer + e.text }));
              else if (e.type === 'done') patch((t) => ({ ...t, status: 'done' }));
              else if (e.type === 'error') {
                patch((t) => ({ ...t, status: 'error', error: asCode(e.code) }));
              }
            },
          },
        );
        if (!ctrl.signal.aborted) {
          patch((t) => (t.status === 'running' ? { ...t, status: 'done' } : t));
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          patch((t) => ({ ...t, status: 'error', error: isApiError(e) ? e.code : 'internal' }));
        }
      } finally {
        if (running === ctrl) running = null;
        void qc.invalidateQueries({ queryKey: aiKeys.status });
      }
    },
    [locale, qc],
  );

  /** "Tekrar sor": asks an interrupted question again in its place at the end. */
  const retry = useCallback(
    (turn: AskTurn) => {
      updateConversation((c) => ({ ...c, ask: c.ask.filter((x) => x.id !== turn.id) }));
      void ask(turn.question);
    },
    [ask],
  );

  const reset = useCallback(() => {
    running?.abort();
    running = null;
    updateConversation((c) => ({ ...c, ask: [] }));
  }, []);

  return { turns, ask, stop, reset, retry };
}

/** "Sor" or "Yap", kept with the conversation. */
export function useAskMode(): [AskMode, (mode: AskMode) => void] {
  const mode = useConversation().mode;
  return [mode, useCallback((m: AskMode) => updateConversation((c) => ({ ...c, mode: m })), [])];
}

/** Where a search hit or a source opens in the web app. */
export function hitLocation(
  hit: Pick<
    AiSearchHit,
    | 'kind'
    | 'nodeId'
    | 'spaceId'
    | 'conversationId'
    | 'seq'
    | 'boardId'
    | 'cardNumber'
    | 'refId'
    | 'path'
  >,
  spaceSlug: (spaceId: string) => string | undefined,
): string | null {
  // Live sources (calendar, meetings, people …) come with their path.
  if (hit.path) return hit.path;
  switch (hit.kind) {
    case 'page':
      return hit.nodeId ? paths.page(hit.nodeId) : null;
    case 'board':
      return hit.nodeId ? paths.board(hit.nodeId) : null;
    case 'drawing':
      return hit.nodeId ? paths.drawing(hit.nodeId) : null;
    case 'card':
      return hit.boardId && hit.cardNumber !== null
        ? paths.boardCard(hit.boardId, String(hit.cardNumber))
        : null;
    case 'message':
      return hit.conversationId
        ? withQuery(paths.chatConversation(hit.conversationId), { seq: hit.seq || undefined })
        : null;
    case 'folder': {
      const slug = hit.spaceId ? spaceSlug(hit.spaceId) : undefined;
      return slug && hit.nodeId ? paths.driveFolder(slug, hit.nodeId) : null;
    }
    case 'file': {
      const slug = hit.spaceId ? spaceSlug(hit.spaceId) : undefined;
      return slug && hit.nodeId ? withQuery(paths.driveSpace(slug), { preview: hit.nodeId }) : null;
    }
    case 'row':
      return hit.path ?? null;
    case 'event':
    case 'meeting':
    case 'todo':
    case 'person':
    case 'contact':
    case 'mail':
      return null;
  }
}

/**
 * Eylem yapan asistan (yol haritası #18): each request becomes proposals in the approval queue
 * (Hesabım › Onay bekleyenler); nothing happens before the person approves them. The conversation
 * so far goes along with every request, so "evet" and "saatini 11 yap" have a meaning; a reply that
 * decides a waiting card presses that card's own button.
 */
export function useActConversation() {
  const { locale } = useI18n();
  const qc = useQueryClient();
  const turns = useConversation().act;
  const past = useRef<ActTurn[]>([]);
  past.current = turns;

  const run = useCallback(
    async (request: string) => {
      const text = request.trim().slice(0, 1_000);
      if (!text) return;
      const id = newTurnId();
      const history = past.current
        .flatMap((x) =>
          x.status === 'done' && x.result ? [{ request: x.request, result: x.result }] : [],
        )
        .slice(-AI_LIMITS.actHistory)
        .map(({ request: asked, result: r }) => ({
          request: asked,
          message: r.message.slice(0, 4_000),
          proposals: r.proposals.slice(0, 20),
          skipped: r.skipped.slice(0, 20).map((s) => s.slice(0, 1_000)),
        }));
      const patch = (fn: (t: ActTurn) => ActTurn) =>
        updateConversation((c) => ({ ...c, act: c.act.map((x) => (x.id === id ? fn(x) : x)) }));
      updateConversation((c) => ({
        ...c,
        act: [...c.act, { id, request: text, status: 'running', result: null, error: null }],
      }));
      try {
        const result = await api.call('planAiActions', {
          body: {
            request: text,
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            locale,
            history,
          },
        });
        patch((t) => ({ ...t, status: 'done', result }));
        if (result.decided?.reject.length) requestDecisions(result.decided.reject, 'reject');
        if (result.decided?.approve.length) requestDecisions(result.decided.approve, 'approve');
        void qc.invalidateQueries({ queryKey: ['mcp'] });
      } catch (e) {
        patch((t) => ({ ...t, status: 'error', error: isApiError(e) ? e.code : 'internal' }));
      } finally {
        void qc.invalidateQueries({ queryKey: aiKeys.status });
      }
    },
    [locale, qc],
  );

  const retry = useCallback(
    (turn: ActTurn) => {
      updateConversation((c) => ({ ...c, act: c.act.filter((x) => x.id !== turn.id) }));
      void run(turn.request);
    },
    [run],
  );

  const reset = useCallback(() => {
    clearDecisions();
    updateConversation((c) => ({ ...c, act: [] }));
  }, []);
  return { turns, run, reset, retry };
}
