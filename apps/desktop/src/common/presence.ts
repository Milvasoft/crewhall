/**
 * What the desktop app tells the server about this computer for presence (sonraki-isler
 * "Çevrimiçi durumu", Teams rules): active while someone used it in the last 15 minutes and the
 * session is not locked or asleep. The server decides the shown status from all devices.
 */
export const ACTIVE_WITHIN_SECONDS = 15 * 60;

export interface DeviceState {
  /** Seconds since the last keyboard or mouse input on the computer (OS idle time). */
  idleSeconds: number;
  /** Windows session locked, or the computer asleep. */
  locked: boolean;
}

/**
 * Heartbeat fields from the computer's state (heartbeat `active`, `idleSeconds`, `locked`,
 * `client`), as agreed with the backend: the server keeps "last activity" per device
 * (now − idleSeconds) and the most active device wins.
 */
export function presenceFields(s: DeviceState): {
  active: boolean;
  idleSeconds: number;
  locked: boolean;
  client: 'desktop';
} {
  const idleSeconds = Math.max(0, Math.floor(Number.isFinite(s.idleSeconds) ? s.idleSeconds : 0));
  return {
    active: !s.locked && idleSeconds < ACTIVE_WITHIN_SECONDS,
    idleSeconds,
    locked: s.locked,
    client: 'desktop',
  };
}
