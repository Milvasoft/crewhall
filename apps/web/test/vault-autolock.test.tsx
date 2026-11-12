import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoLock } from '@/lib/vault/autolock';
import { getSession, lock, setUnlocked } from '@/lib/vault/session';
import { DEFAULT_SETTINGS, parseSettings, type VaultSettings } from '@/lib/vault/settings';

/** Vault lock timings (user decision 2026-10-29): idle 10 min, hidden 5 min, desktop system lock. */

function unlock(settings: Partial<VaultSettings> = {}) {
  setUnlocked({
    userId: 'u1',
    privateKey: new Uint8Array(32).fill(1),
    publicKey: 'pk',
    method: 'password',
    verifier: null,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    settingsState: 'ok',
  });
}

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
  });
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});
afterEach(() => {
  act(() => lock('manual'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.crewhallDesktop;
});

describe('vault settings defaults and migration', () => {
  it('locks after 10 idle minutes and 5 hidden minutes by default', () => {
    expect(DEFAULT_SETTINGS.autoLockMinutes).toBe(10);
    expect(DEFAULT_SETTINGS.hiddenLockMinutes).toBe(5);
  });

  it('moves settings saved before the hidden wait to the new defaults', () => {
    expect(parseSettings({ autoLockMinutes: 5, lockOnHidden: true })).toMatchObject({
      autoLockMinutes: 10,
      hiddenLockMinutes: 5,
      lockOnHidden: true,
    });
    // A choice the person made stays; "never when hidden" stays off.
    expect(parseSettings({ autoLockMinutes: 30, lockOnHidden: false })).toMatchObject({
      autoLockMinutes: 30,
      hiddenLockMinutes: null,
      lockOnHidden: false,
    });
    expect(parseSettings({ autoLockMinutes: 5, hiddenLockMinutes: 0 })).toMatchObject({
      autoLockMinutes: 5,
      hiddenLockMinutes: 0,
    });
  });
});

describe('auto lock', () => {
  it('waits the hidden time and keeps the vault open when the tab comes back sooner', () => {
    unlock();
    renderHook(() => useAutoLock());
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(4 * 60_000));
    expect(getSession().unlocked).not.toBeNull();
    act(() => setVisibility('visible'));
    // Back at the vault: a key press counts as activity.
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })));
    act(() => void vi.advanceTimersByTime(2 * 60_000));
    expect(getSession().unlocked).not.toBeNull();

    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(5 * 60_000 + 5000));
    expect(getSession().unlocked).toBeNull();
    expect(getSession().lockReason).toBe('hidden');
  });

  it('locks at once with "Hemen" and never with "Kapalı"', () => {
    unlock({ hiddenLockMinutes: 0 });
    const first = renderHook(() => useAutoLock());
    act(() => setVisibility('hidden'));
    expect(getSession().unlocked).toBeNull();
    first.unmount();

    act(() => setVisibility('visible'));
    unlock({ hiddenLockMinutes: null });
    renderHook(() => useAutoLock());
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(9 * 60_000));
    expect(getSession().unlocked).not.toBeNull();
  });

  it('locks after 10 idle minutes', () => {
    unlock();
    renderHook(() => useAutoLock());
    act(() => void vi.advanceTimersByTime(10 * 60_000 + 5000));
    expect(getSession().lockReason).toBe('idle');
  });

  it('in the desktop app: minimised does not count, a Windows lock or sleep locks at once', () => {
    let systemLock: (() => void) | null = null;
    window.crewhallDesktop = {
      isDesktop: true,
      platform: 'win32',
      features: ['systemLock'],
      onSystemLock: (listener) => {
        systemLock = listener;
        return () => (systemLock = null);
      },
    };
    unlock({ hiddenLockMinutes: 0 });
    renderHook(() => useAutoLock());
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(6 * 60_000));
    expect(getSession().unlocked).not.toBeNull();
    act(() => systemLock?.());
    expect(getSession().lockReason).toBe('system');
  });
});
