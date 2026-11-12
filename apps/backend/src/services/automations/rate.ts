/**
 * Sliding-window counters (incoming hook rate, runs per rule). In process memory: one api and
 * one worker process per install today; a restart only forgets.
 */
const windows = new Map<string, number[]>();

export function allowRate(key: string, max: number, windowMs: number, now = Date.now()) {
  const recent = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    windows.set(key, recent);
    return false;
  }
  recent.push(now);
  windows.set(key, recent);
  if (windows.size > 20_000) windows.clear();
  return true;
}

/** Tests start from empty windows. */
export function resetRates() {
  windows.clear();
}
