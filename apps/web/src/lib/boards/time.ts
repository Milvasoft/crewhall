import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { type I18nValue } from '@/lib/i18n/I18nContext';

/** Time tracking queries (kararlar 2026-10-29). */
export const timeKeys = {
  card: (cardId: string) => ['boards', 'time', cardId] as const,
  mine: ['boards', 'timer'] as const,
};

export const cardTimeQuery = (cardId: string) =>
  queryOptions({
    queryKey: timeKeys.card(cardId),
    queryFn: ({ signal }) => api.call('listBoardCardTime', { params: { cardId }, signal }),
    staleTime: 10_000,
  });

/** The caller's running timer; checked again when the window comes back. */
export const myTimerQuery = queryOptions({
  queryKey: timeKeys.mine,
  queryFn: ({ signal }) => api.call('getMyBoardTimer', { signal }),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

/** After a timer or entry change: the timer, the card's list and the boards' sums. */
export function invalidateTime(qc: QueryClient, cardId?: string) {
  void qc.invalidateQueries({ queryKey: timeKeys.mine });
  if (cardId) void qc.invalidateQueries({ queryKey: timeKeys.card(cardId) });
  void qc.invalidateQueries({ queryKey: ['boards', 'board'] });
  void qc.invalidateQueries({ queryKey: ['boards', 'card'] });
}

/** "2 sa 30 dk" / "2h 30m"; zero reads "0 dk". */
export function formatMinutes(minutes: number, t: I18nValue['t']) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return t('boards.time.fmt.hm', { h, m });
  if (h) return t('boards.time.fmt.h', { h });
  return t('boards.time.fmt.m', { m });
}

/** A running timer's clock: "1:05:09" or "05:09". */
export function clock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
