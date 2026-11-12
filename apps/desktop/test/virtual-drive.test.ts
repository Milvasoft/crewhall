import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  driveAccount,
  foldersOverlap,
  isSameOrInside,
  overallState,
} from '../src/common/virtual-drive';
import type { PairStatus } from '../src/sync/engine';

describe('installer.nsh', () => {
  const script = readFileSync(join(import.meta.dirname, '../resources/installer.nsh'), 'utf8');

  it('removes the drive before the files it needs are gone, and not on an update', () => {
    const guard = script.indexOf('${ifNot} ${isUpdated}');
    expect(guard).toBeGreaterThan(-1);
    expect(script.indexOf('--remove-virtual-drive')).toBeGreaterThan(guard);
  });

  // Installed for all users, an uninstaller's $APPDATA is ProgramData.
  it("looks for the person's own shortcut in the person's own folder", () => {
    const shortcut = script.indexOf('$APPDATA\\Microsoft\\Windows\\SendTo');
    const current = script.indexOf('SetShellVarContext current');
    const all = script.indexOf('SetShellVarContext all');
    expect(current).toBeGreaterThan(-1);
    expect(current).toBeLessThan(shortcut);
    expect(all).toBeGreaterThan(shortcut);
  });
});

describe('isSameOrInside', () => {
  it('knows the folder itself and what is under it', () => {
    expect(isSameOrInside('C:\\A', 'C:\\A', 'win32')).toBe(true);
    expect(isSameOrInside('C:\\A\\B', 'C:\\A', 'win32')).toBe(true);
    expect(isSameOrInside('C:\\A', 'C:\\A\\B', 'win32')).toBe(false);
  });

  it('is not fooled by a name that merely starts the same', () => {
    expect(isSameOrInside('C:\\Crewhall2', 'C:\\Crewhall', 'win32')).toBe(false);
    expect(isSameOrInside('C:\\Crewhall\\x', 'C:\\Crewhall', 'win32')).toBe(true);
  });

  it('ignores case and a trailing separator on Windows', () => {
    expect(isSameOrInside('c:\\users\\M\\crewhall\\', 'C:\\Users\\m\\Crewhall', 'win32')).toBe(
      true,
    );
    expect(isSameOrInside('C:/Users/m/Crewhall/d', 'C:\\Users\\m\\Crewhall', 'win32')).toBe(true);
  });

  it('keeps case where the disk does', () => {
    expect(isSameOrInside('/home/m/a', '/home/m/A', 'linux')).toBe(false);
  });
});

describe('foldersOverlap', () => {
  it('holds either way round', () => {
    expect(foldersOverlap('C:\\A\\B', 'C:\\A', 'win32')).toBe(true);
    expect(foldersOverlap('C:\\A', 'C:\\A\\B', 'win32')).toBe(true);
    expect(foldersOverlap('C:\\A', 'C:\\B', 'win32')).toBe(false);
    expect(foldersOverlap('C:\\A', 'D:\\A', 'win32')).toBe(false);
  });
});

describe('overallState', () => {
  const s = (state: PairStatus['state']) => ({ state }) as PairStatus;

  it('shows the worst one', () => {
    expect(overallState([])).toBe('idle');
    expect(overallState([s('idle'), s('idle')])).toBe('idle');
    expect(overallState([s('idle'), s('syncing')])).toBe('syncing');
    expect(overallState([s('syncing'), s('confirm')])).toBe('confirm');
    expect(overallState([s('confirm'), s('error'), s('syncing')])).toBe('error');
  });
});

describe('driveAccount', () => {
  it('uses only what Windows allows in a sync root id', () => {
    const account = driveAccount(
      () => 'abcdef0123456789abcdef0123456789',
      'https://crew.example.com',
    );
    expect(account).toBe('abcdef0123456789');
  });
});
