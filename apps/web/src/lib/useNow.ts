import { useEffect, useState } from 'react';

/**
 * Current time as state, so render stays pure. Ticks every `intervalMs` when given
 * (countdowns), otherwise it is the mount time.
 */
export function useNow(intervalMs?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!intervalMs) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
