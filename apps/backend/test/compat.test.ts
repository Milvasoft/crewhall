import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_LEVEL, type PublicBootstrap, type ServerCompat } from '@crewhall/shared';
import type { Env } from '../src/env';
import { deprecationHeaders, serverCompat } from '../src/services/compat';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

let app: TestApp;
let owner: Client;

const as = (client: string) => ({ 'X-Crewhall-Client': client });

beforeAll(async () => {
  app = await createTestApp({
    MIN_CLIENT_ANDROID: '1.2.0',
    MIN_MOBILE_VERSION: '0.9.0',
    CLIENT_STORE_URL_ANDROID: 'https://play.google.com/store/apps/details?id=com.example.crewhall',
    BUILD_ID: '4821',
    BUILD_COMMIT: 'f00dbabe',
  });
  ({ owner } = await setupWithOwner(app));
});

afterAll(async () => {
  await app.close();
});

describe('server compatibility', () => {
  it('names the build the image came from, and nothing outside CI', async () => {
    const compat = await new Client(app).raw<ServerCompat>('GET', '/api/v1/meta/compat');
    expect(compat.body).toMatchObject({ build: '4821', commit: 'f00dbabe' });
    const plain = JSON.parse(JSON.stringify(serverCompat({} as Env))) as ServerCompat;
    expect(plain).not.toHaveProperty('build');
    expect(plain).not.toHaveProperty('commit');
  });

  it('tells apps the version, apiLevel, capabilities and accepted versions', async () => {
    const boot = await owner.raw<PublicBootstrap>('GET', '/api/v1/bootstrap');
    expect(boot.body.server).toMatchObject({
      apiLevel: API_LEVEL,
      minClientVersion: { ios: '0.9.0', android: '1.2.0', desktop: '0.0.0' },
    });
    expect(boot.body.server!.capabilities).toEqual(
      expect.arrayContaining(['ui.prefs', 'delivery.settings', 'mail.bulk', 'meet.volume']),
    );
    expect(boot.body.clientStatus).toBeUndefined();

    // A module switched off takes its capabilities along.
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: false } } } });
    const off = await owner.raw<PublicBootstrap>('GET', '/api/v1/bootstrap');
    expect(off.body.server!.capabilities).not.toContain('mail.bulk');
    expect(off.body.server!.capabilities).toContain('meet.volume');
    await owner.api.call('updateOrg', { body: { settings: { modules: { mail: true } } } });
  });

  it('refuses an outdated app with 426 except on bootstrap, compat and auth', async () => {
    const old = as('android/1.1.9');
    const refused = await owner.raw<{ code: string; details: unknown }>(
      'GET',
      '/api/v1/me',
      undefined,
      old,
    );
    expect(refused.status).toBe(426);
    expect(refused.body).toMatchObject({
      code: 'client_outdated',
      details: {
        platform: 'android',
        min: '1.2.0',
        current: '1.1.9',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.example.crewhall',
      },
    });

    const boot = await owner.raw<PublicBootstrap>('GET', '/api/v1/bootstrap', undefined, old);
    expect(boot.status).toBe(200);
    expect(boot.body.clientStatus).toBe('outdated');
    expect((await owner.raw('GET', '/api/v1/meta/compat', undefined, old)).status).toBe(200);
    expect((await owner.raw('GET', '/api/auth/get-session', undefined, old)).status).toBe(200);
  });

  it('lets current apps, web and requests without the header through', async () => {
    for (const headers of [
      as('android/1.2.0'),
      as('android/2.0.0-beta.1'),
      as('ios/0.9.0'),
      as('desktop/0.1.0'),
      as('web/0.0.1'),
      as('garbage'),
      {},
    ]) {
      const res = await owner.raw('GET', '/api/v1/me', undefined, headers);
      expect(res.status).toBe(200);
    }
    const boot = await owner.raw<PublicBootstrap>(
      'GET',
      '/api/v1/bootstrap',
      undefined,
      as('ios/0.9.0'),
    );
    expect(boot.body.clientStatus).toBe('ok');
  });

  it('describes accepted versions and deprecations on getCompat', async () => {
    const compat = await owner.raw<ServerCompat>('GET', '/api/v1/meta/compat');
    expect(compat.body).toMatchObject({
      apiLevel: API_LEVEL,
      minClientVersion: { ios: '0.9.0', android: '1.2.0', desktop: '0.0.0' },
      storeUrls: {
        ios: null,
        android: 'https://play.google.com/store/apps/details?id=com.example.crewhall',
        desktop: null,
      },
    });
    // Full width became a personal choice (UiPrefs.pagesFullWidth); the page field is on its way out.
    expect(compat.body.deprecations).toEqual(
      (['getPage', 'updatePage', 'getPublicPage'] as const).map((endpoint) =>
        expect.objectContaining({
          endpoint,
          field: 'fullWidth',
          since: '2026-10-23',
          removeAfter: '2027-04-23',
          replacement: 'UiPrefs.pagesFullWidth',
        }),
      ),
    );
    expect(compat.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('formats Deprecation and Sunset headers', () => {
    expect(deprecationHeaders({ since: '2026-01-01', removeAfter: '2026-07-01' })).toEqual({
      Deprecation: '@1767225600',
      Sunset: 'Wed, 01 Jul 2026 00:00:00 GMT',
    });
  });
});
