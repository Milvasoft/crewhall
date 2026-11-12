import { type HealthReport } from '@crewhall/crypto';
import { type Vault } from '@crewhall/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { policyQuery } from './api';
import { engine } from './engine-client';
import { useItemsOf } from './items';
import { useVaultSession } from './session';

/**
 * Vault health in the background (H13): the scan (password strength included) runs in the
 * vault worker a few items at a time, starts only once the lists have settled, and is reused
 * until an item changes. The sidebar badge and the health page share one result.
 *
 * When the org policy allows it, the scan also runs the leaked password check (roadmap 20):
 * 5-digit SHA-1 prefixes go to the server's range relay, suffixes are matched in the worker.
 */

/** off: the org turned the check off; failed: some ranges could not be fetched. */
export type BreachState = 'off' | 'ok' | 'failed';

interface State {
  report: HealthReport | null;
  scanning: boolean;
  key: string;
  /** When the report was computed. */
  at: number | null;
  breach: BreachState;
}

let state: State = { report: null, scanning: false, key: '', at: null, breach: 'off' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let run = 0;

function emit(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

const SETTLE_MS = 400;

function schedule(key: string, itemIds: string[], breach: boolean) {
  if (state.key === key && (state.report || state.scanning)) return;
  if (timer) clearTimeout(timer);
  const mine = ++run;
  emit({
    key,
    scanning: true,
    report: state.key.split('|')[0] === key.split('|')[0] ? state.report : null,
  });
  timer = setTimeout(() => {
    timer = null;
    void engine()
      .health(itemIds, new Date(), breach)
      .then((report) => {
        if (mine !== run) return;
        const failed = breach && engine().stats().breachErrors > 0;
        emit({
          report,
          scanning: false,
          at: Date.now(),
          breach: !breach ? 'off' : failed ? 'failed' : 'ok',
        });
      });
  }, SETTLE_MS);
}

export function useVaultHealth(vaults: Vault[]) {
  const { unlocked } = useVaultSession();
  const { items, loading } = useItemsOf(vaults);
  const policy = useQuery({ ...policyQuery, enabled: Boolean(unlocked) });
  const breach = policy.data?.breachCheck ?? false;
  const live = useMemo(() => items.filter((d) => d.summary && !d.item.deletedAt), [items]);
  // The unlock time keeps a report from one unlock out of the next.
  const key = useMemo(
    () =>
      `${unlocked?.unlockedAt ?? 0}|${breach ? 'b' : ''}|${live.map((d) => `${d.item.id}:${d.item.revision}`).join(',')}`,
    [live, unlocked, breach],
  );
  const s = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    if (!unlocked || loading || policy.isLoading) return;
    schedule(
      key,
      live.map((d) => d.item.id),
      breach,
    );
  }, [key, loading, unlocked, live, s.key, breach, policy.isLoading]);
  const current = s.key === key;
  return {
    report: unlocked && current ? s.report : null,
    scanning: !current || s.scanning || loading,
    at: s.at,
    breach: s.breach,
    items,
  };
}

/** Issue count for the sidebar badge; undefined while scanning. */
export function useHealthCount(vaults: Vault[]): number | undefined {
  const { report } = useVaultHealth(vaults);
  return report ? report.rows.length : undefined;
}

/** "Yeniden tara": forget the cached report; the next render schedules a new scan. */
export function rescanHealth() {
  emit({ key: '', report: null, scanning: false });
}
