import { powerMonitor } from 'electron';
import { SYSTEM_LOCK } from '../common/ipc';
import type { DeviceState } from '../common/presence';
import type { DesktopApp } from './app';

/**
 * The computer's state (Electron powerMonitor): Windows session lock and sleep end the vault at
 * once (the page hears SYSTEM_LOCK) and make the person "away" for presence; the OS idle time
 * says whether someone is at the computer.
 */
export class SystemWatch {
  private locked = false;
  /** Just woke or unlocked: the next beat says "someone is here" (idleSeconds 0). */
  private woke = false;

  constructor(private readonly d: DesktopApp) {}

  start(): void {
    const away = () => {
      this.locked = true;
      this.d.beatNow();
      this.d.tellAppPages(SYSTEM_LOCK);
    };
    // Presence contract (backend): locked before sleep, idleSeconds 0 right on resume or unlock.
    const back = () => {
      this.locked = false;
      this.woke = true;
      this.d.beatNow();
    };
    powerMonitor.on('lock-screen', away);
    powerMonitor.on('suspend', away);
    powerMonitor.on('unlock-screen', back);
    powerMonitor.on('resume', back);
  }

  state(): DeviceState {
    let idleSeconds = 0;
    let lockedNow = false;
    try {
      idleSeconds = powerMonitor.getSystemIdleTime();
      lockedNow = powerMonitor.getSystemIdleState(60) === 'locked';
    } catch {
      // Not ready yet (before app ready): treat as active.
    }
    // The OS idle time can still count the sleep; the wake-up itself is the latest input.
    if (this.woke) {
      this.woke = false;
      idleSeconds = 0;
    }
    // Still on the Windows lock screen after waking: away until unlock-screen.
    return { idleSeconds, locked: this.locked || lockedNow };
  }
}
