import { useEffect } from 'react';
import { desktopBridge, desktopHas } from '@/lib/desktop';
import { useNow } from '@/lib/useNow';
import { getSession, lock, touch, useVaultSession } from './session';

/**
 * Auto lock (design 8.3, 8.16; doc 17 §7; user decision 2026-10-29):
 * - after N minutes without mouse, keyboard or touch (default 10);
 * - some minutes after the tab or window is hidden (default 5; "Hemen" and "Kapalı" too).
 *   Coming back before then keeps the vault open;
 * - in the desktop app minimising or hiding to the tray does not count as hidden; the vault locks
 *   at once when Windows locks or the computer sleeps (bridge `onSystemLock`).
 * Ctrl L locks by hand.
 */
export function useAutoLock() {
  const { unlocked } = useVaultSession();
  const minutes = unlocked?.settings.autoLockMinutes ?? 10;
  const hiddenMinutes = unlocked ? unlocked.settings.hiddenLockMinutes : 5;
  const active = Boolean(unlocked);

  useEffect(() => {
    if (!active) return;
    const desktop = desktopHas('systemLock') ? desktopBridge() : null;
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      // Throttle: mousemove fires constantly.
      if (now - last > 1000) {
        last = now;
        touch();
      }
    };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, onActivity, { passive: true });

    let hiddenAt: number | null = null;
    const hiddenTooLong = () =>
      hiddenAt !== null &&
      hiddenMinutes !== null &&
      Date.now() - hiddenAt >= hiddenMinutes * 60_000;
    const timer = setInterval(() => {
      const s = getSession();
      if (!s.unlocked) return;
      if (Date.now() - s.lastActivity >= minutes * 60_000) lock('idle');
      else if (hiddenTooLong()) lock('hidden');
    }, 5000);
    const onVisibility = () => {
      // The desktop app: minimised or in the tray is not "hidden" (system lock below instead).
      if (desktop) return;
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        if (hiddenMinutes === 0) lock('hidden');
      } else {
        // Timers run slowly in a hidden tab: check the wait as soon as it is back.
        if (hiddenTooLong()) lock('hidden');
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    const offSystem = desktop?.onSystemLock?.(() => lock('system'));
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        lock('manual');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      for (const e of events) window.removeEventListener(e, onActivity);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      offSystem?.();
      window.removeEventListener('keydown', onKey);
    };
  }, [active, minutes, hiddenMinutes]);
}

/** Whole minutes until the idle lock, refreshed every few seconds (sidebar status line). */
export function useMinutesLeft(): number | null {
  const { unlocked } = useVaultSession();
  const now = useNow(5000);
  if (!unlocked) return null;
  const left = unlocked.settings.autoLockMinutes * 60_000 - (now - getSession().lastActivity);
  return Math.min(unlocked.settings.autoLockMinutes, Math.max(0, Math.ceil(left / 60_000)));
}
