import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { screen } from 'electron';
import { scrollUnits, type DesktopOs, type InputDriver } from '../common/remote-control';
import { DIST } from './paths';

/** The parts of @jitsi/robotjs the driver uses. */
interface Robot {
  setMouseDelay(ms: number): void;
  setKeyboardDelay(ms: number): void;
  moveMouse(x: number, y: number): void;
  mouseToggle(down: 'down' | 'up', button: 'left' | 'middle' | 'right'): void;
  scrollMouse(x: number, y: number): void;
  keyToggle(key: string, down: 'down' | 'up', modifiers: string[]): void;
  typeString(text: string): void;
}

/**
 * The N-API prebuild of @jitsi/robotjs for this OS, copied to dist/native by scripts/build.mjs
 * (unpacked from the asar). N-API is ABI stable, so the same binary works in Electron.
 */
function loadRobot(): Robot | null {
  const dir =
    process.platform === 'darwin' ? 'darwin-x64+arm64' : `${process.platform}-${process.arch}`;
  const file = join(DIST, 'native', dir, 'robotjs.node').replace('app.asar', 'app.asar.unpacked');
  if (!existsSync(file)) return null;
  try {
    return createRequire(__filename)(file) as Robot;
  } catch {
    return null;
  }
}

let robot: Robot | null | undefined;

/** Injects input with robotjs; null when the native module is missing for this platform. */
export function createRobotDriver(os: DesktopOs): InputDriver | null {
  if (robot === undefined) {
    robot = loadRobot();
    robot?.setMouseDelay(0);
    robot?.setKeyboardDelay(0);
  }
  const r = robot;
  if (!r) return null;
  return {
    move(x, y) {
      // robotjs wants physical pixels on Windows (per-monitor DPI), points on macOS.
      const p = os === 'win32' ? screen.dipToScreenPoint({ x, y }) : { x, y };
      r.moveMouse(Math.round(p.x), Math.round(p.y));
    },
    button(button, down) {
      r.mouseToggle(down ? 'down' : 'up', button);
    },
    scroll(dx, dy) {
      const u = scrollUnits(os, dx, dy);
      r.scrollMouse(u.x, u.y);
    },
    key(name, down, modifiers) {
      r.keyToggle(name, down ? 'down' : 'up', modifiers);
    },
    type(text) {
      r.typeString(text);
    },
  };
}
