import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appUserModelId } from '../src/common/app-id';

const builder = createRequire(import.meta.url)('../electron-builder.config.cjs') as {
  appId: string;
};

describe('appUserModelId', () => {
  it('a packaged app uses the id its installer gives the Start Menu shortcut', () => {
    expect(appUserModelId(true)).toBe(builder.appId);
  });

  it('a development run has one of its own', () => {
    expect(appUserModelId(false)).not.toBe(appUserModelId(true));
    expect(appUserModelId(false)).toBe('com.crewhall.desktop.dev');
  });

  it('the app decides by whether it is packaged, and sets no other id', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8');
    expect(main.match(/setAppUserModelId\([^)]*\)+/g)).toEqual([
      'setAppUserModelId(appUserModelId(app.isPackaged))',
    ]);
  });
});
