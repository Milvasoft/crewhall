import { ERROR_CODES, type AiRunRequest, type ErrorCode } from '@crewhall/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { aiKeys } from './queries';
import { streamAi } from './stream';

export interface AiRunState {
  status: 'idle' | 'running' | 'done' | 'error';
  text: string;
  runId: string | null;
  truncated: boolean;
  /** summarize_unread: messages read (0 = nothing unread). */
  messages: number | null;
  /** errors.<code> */
  error: ErrorCode | null;
}

export const asCode = (code: string): ErrorCode =>
  (ERROR_CODES as readonly string[]).includes(code) ? (code as ErrorCode) : 'internal';

const IDLE: AiRunState = {
  status: 'idle',
  text: '',
  runId: null,
  truncated: false,
  messages: null,
  error: null,
};

/**
 * One AI action with a streamed answer: `run` starts (and cancels any previous one), `cancel`
 * stops the model, `accept` records that the person kept the result ("AI ile" in the audit log).
 */
export function useAiRun() {
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [state, setState] = useState<AiRunState>(IDLE);
  const abort = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const run = useCallback(
    async (body: AiRunRequest) => {
      cancel();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setState({ ...IDLE, status: 'running' });
      try {
        await streamAi(body, {
          signal: ctrl.signal,
          locale,
          onEvent: (e) => {
            if (ctrl.signal.aborted) return;
            setState((s) => {
              switch (e.type) {
                case 'start':
                  return { ...s, runId: e.runId, messages: e.messages ?? null };
                case 'delta':
                  return { ...s, text: s.text + e.text };
                case 'done':
                  return { ...s, status: 'done', runId: e.runId, truncated: e.truncated };
                case 'error':
                  return { ...s, status: 'error', error: asCode(e.code) };
                case 'citations':
                  return s;
              }
            });
          },
        });
        if (!ctrl.signal.aborted) {
          setState((s) => (s.status === 'running' ? { ...s, status: 'done' } : s));
        }
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setState((s) => ({ ...s, status: 'error', error: isApiError(e) ? e.code : 'internal' }));
      } finally {
        if (abort.current === ctrl) abort.current = null;
        void qc.invalidateQueries({ queryKey: aiKeys.status });
      }
    },
    [cancel, locale, qc],
  );

  const accept = useCallback(() => {
    if (state.runId) {
      void api.call('acceptAiRun', { params: { runId: state.runId }, body: {} }).catch(() => {});
    }
  }, [state.runId]);

  const reset = useCallback(() => {
    cancel();
    setState(IDLE);
  }, [cancel]);

  return { state, run, cancel, accept, reset };
}
