import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STARTUP_SETTINGS_URL,
  STORE_UPDATES_URL,
  distribution,
  isStorePackage,
} from '../src/common/store';

const appDir = join(__dirname, '..');

type AppxConfig = {
  identityName?: string;
  publisher?: string;
  publisherDisplayName?: string;
  displayName?: string;
  applicationId?: string;
  addAutoLaunchExtension?: boolean;
  customManifestPath?: string;
  customExtensionsPath?: string;
  capabilities?: string[];
  minVersion?: string;
  artifactName?: string;
};
type Config = {
  appx: AppxConfig;
  win: { target: Array<{ target: string }> };
  protocols: Array<{ schemes: string[] }>;
};

/** Loads the builder config fresh, so it reads the environment of the test. */
function config(): Config {
  const require = createRequire(import.meta.url);
  const path = require.resolve('../electron-builder.config.cjs');
  delete require.cache[path];
  return require(path) as Config;
}

function storeEnv(env: Record<string, string>) {
  const clean = { ...process.env };
  for (const name of Object.keys(clean)) if (name.startsWith('MS_STORE_')) delete clean[name];
  return spawnSync(process.execPath, [join(appDir, 'scripts', 'store-env.mjs')], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
}

const IDENTITY = {
  MS_STORE_IDENTITY_NAME: '12345Example.Crewhall',
  MS_STORE_PUBLISHER: 'CN=11111111-2222-3333-4444-555555555555',
  MS_STORE_PUBLISHER_NAME: 'Example',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Microsoft Store package detection', () => {
  it('is a Store package only on Windows with process.windowsStore', () => {
    expect(isStorePackage('win32', true)).toBe(true);
    expect(isStorePackage('win32', false)).toBe(false);
    expect(isStorePackage('win32', undefined)).toBe(false);
    expect(isStorePackage('darwin', true)).toBe(false);
  });

  it('the installer build keeps its updater, login item, Explorer menu, protocol and app id', () => {
    expect(distribution(false)).toEqual({
      selfUpdate: true,
      loginItem: 'app',
      explorerMenu: true,
      registerProtocol: true,
      ownAppUserModelId: true,
    });
  });

  it('the Store build leaves updates, startup, the protocol and the app id to the package', () => {
    expect(distribution(true)).toEqual({
      selfUpdate: false,
      loginItem: 'system',
      explorerMenu: false,
      registerProtocol: false,
      ownAppUserModelId: false,
    });
  });

  it('opens Windows pages, nothing on the web', () => {
    expect(STARTUP_SETTINGS_URL).toBe('ms-settings:startupapps');
    expect(STORE_UPDATES_URL.startsWith('ms-windows-store:')).toBe(true);
  });
});

describe('dist:store identity check', () => {
  it('stops when Partner Center values are missing, naming each', () => {
    const run = storeEnv({});
    expect(run.status).toBe(1);
    for (const name of Object.keys(IDENTITY)) expect(run.stderr).toContain(name);
  });

  it('treats an undefined pipeline variable, which arrives as "$(NAME)", as missing', () => {
    const run = storeEnv({ ...IDENTITY, MS_STORE_PUBLISHER: '$(MS_STORE_PUBLISHER)' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('MS_STORE_PUBLISHER is not set');
  });

  it('wants the publisher as Partner Center shows it, and a valid identity name', () => {
    const run = storeEnv({
      ...IDENTITY,
      MS_STORE_PUBLISHER: 'Example Ltd',
      MS_STORE_IDENTITY_NAME: 'Example Crewhall',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('CN=');
    expect(run.stderr).toContain('MS_STORE_IDENTITY_NAME may only hold');
  });

  it('passes with all three', () => {
    expect(storeEnv(IDENTITY).status).toBe(0);
  });
});

describe('appx target', () => {
  it('takes the identity from the environment and keeps no placeholder in the code', () => {
    vi.stubEnv('MS_STORE_IDENTITY_NAME', '');
    vi.stubEnv('MS_STORE_PUBLISHER', '');
    vi.stubEnv('MS_STORE_PUBLISHER_NAME', '');
    vi.stubEnv('MS_STORE_DISPLAY_NAME', '');
    const empty = config().appx;
    expect(empty.identityName).toBeUndefined();
    expect(empty.publisher).toBeUndefined();
    expect(empty.publisherDisplayName).toBeUndefined();
    expect(empty.displayName).toBe('Crewhall');

    for (const [name, value] of Object.entries(IDENTITY)) vi.stubEnv(name, value);
    vi.stubEnv('MS_STORE_DISPLAY_NAME', 'Crewhall Workspace');
    const set = config().appx;
    expect(set.identityName).toBe(IDENTITY.MS_STORE_IDENTITY_NAME);
    expect(set.publisher).toBe(IDENTITY.MS_STORE_PUBLISHER);
    expect(set.publisherDisplayName).toBe(IDENTITY.MS_STORE_PUBLISHER_NAME);
    expect(set.displayName).toBe('Crewhall Workspace');
  });

  it('leaves the NSIS installer as the default Windows target', () => {
    const c = config();
    expect(c.win.target.map((t) => t.target)).toEqual(['nsis']);
    expect(c.protocols.flatMap((p) => p.schemes)).toContain('crewhall');
  });

  it('declares camera and microphone, and a startup task instead of the Run key', () => {
    const appx = config().appx;
    expect(appx.capabilities).toEqual(expect.arrayContaining(['webcam', 'microphone']));
    // electron-builder's own task would start the app in a window; ours passes --hidden.
    expect(appx.addAutoLaunchExtension).toBe(false);
    const extensions = readFileSync(join(appDir, appx.customExtensionsPath ?? ''), 'utf8');
    expect(extensions).toMatch(/Category="windows\.startupTask"/);
    expect(extensions).toMatch(/Executable="app\\Crewhall\.exe"/);
    expect(extensions).toMatch(/uap10:Parameters="--hidden"/);
    expect(extensions).toMatch(/<desktop:StartupTask TaskId="\w+" Enabled="true"/);
    // An XML comment may not contain "--": makeappx would refuse the manifest.
    for (const comment of extensions.match(/<!--([\s\S]*?)-->/g) ?? []) {
      expect(comment.slice(4, -3)).not.toContain('--');
    }
  });

  it('declares uap10 in the manifest template, on a Windows that knows it', () => {
    const appx = config().appx;
    const manifest = readFileSync(join(appDir, 'resources', appx.customManifestPath ?? ''), 'utf8');
    expect(manifest).toContain(
      'xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"',
    );
    expect(manifest).toContain(
      'xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"',
    );
    expect(appx.minVersion).toBe('10.0.19041.0');
    // electron-builder throws on a macro it does not know.
    const known = new Set([
      'publisher',
      'publisherDisplayName',
      'version',
      'applicationId',
      'identityName',
      'executable',
      'displayName',
      'description',
      'backgroundColor',
      'logo',
      'square150x150Logo',
      'square44x44Logo',
      'lockScreen',
      'defaultTile',
      'splashScreen',
      'arch',
      'resourceLanguages',
      'capabilities',
      'extensions',
      'minVersion',
      'maxVersionTested',
    ]);
    const used = [...manifest.matchAll(/\$\{([a-zA-Z0-9]+)\}/g)].map((m) => m[1] ?? '');
    expect(used.filter((name) => !known.has(name))).toEqual([]);
    expect(used).toEqual(expect.arrayContaining(['extensions', 'identityName', 'publisher']));
  });

  it('has every Store tile at its size', () => {
    const sizes: Record<string, [number, number]> = {
      'StoreLogo.png': [50, 50],
      'Square44x44Logo.png': [44, 44],
      'SmallTile.png': [71, 71],
      'Square150x150Logo.png': [150, 150],
      'LargeTile.png': [310, 310],
      'Wide310x150Logo.png': [310, 150],
    };
    const dir = join(appDir, 'resources', 'appx');
    // electron-builder packs every file in the folder as an asset.
    expect(readdirSync(dir).sort()).toEqual(Object.keys(sizes).sort());
    for (const [name, [width, height]] of Object.entries(sizes)) {
      const png = readFileSync(join(dir, name));
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height]);
    }
  });
});
