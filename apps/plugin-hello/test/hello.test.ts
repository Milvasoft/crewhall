import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { SESSION_TOKEN_TYPE, signRequest } from '@crewhall/plugin-sdk/server';
import { createHelloPlugin, loadManifest } from '../src/server';

/** The sample plugin against signed requests as Crewhall sends them. */

const API = 'https://hub.acme.com';
const SECRET = 's'.repeat(43);
let plugin: ReturnType<typeof createHelloPlugin>;
let token: string;

const post = async (path: string, payload: unknown, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return plugin.app.request(path, {
    method: 'POST',
    headers: await signRequest(secret, 'inst-1', body),
    body,
  });
};

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'EdDSA' }],
  });
  const manifest = await loadManifest();
  plugin = createHelloPlugin({ manifest, clientJs: '/* client */', jwks });
  token = await new SignJWT({
    org: 'o1',
    inst: 'inst-1',
    name: 'Elif',
    email: 'elif@acme.com',
    scope: 'hub:read chat:send',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k', typ: SESSION_TOKEN_TYPE })
    .setIssuer(API)
    .setAudience(manifest.id)
    .setSubject('u1')
    .setExpirationTime('5m')
    .sign(privateKey);
});

describe('hello plugin', () => {
  it('has a valid manifest that uses every entry point', async () => {
    const m = await loadManifest();
    expect(m.entryPoints.tabs).toHaveLength(1);
    expect(m.entryPoints.cards).toHaveLength(1);
    expect(m.entryPoints.commands).toHaveLength(1);
    expect(m.entryPoints.tools).toHaveLength(1);
    expect(m.entryPoints.events).toHaveLength(1);
  });

  it('keeps the secret from a signed install and refuses unsigned requests', async () => {
    const install = {
      type: 'install',
      installationId: 'inst-1',
      apiUrl: API,
      org: { id: 'o1', name: 'Acme', domain: 'hub.acme.com' },
      pluginVersion: '1.0.0',
      permissions: ['hub:read', 'chat:send'],
      secret: SECRET,
    };
    expect((await post('/crewhall/lifecycle', install, 'x'.repeat(43))).status).toBe(401);
    expect((await post('/crewhall/lifecycle', install)).status).toBe(200);
    expect(plugin.store.get('inst-1')?.orgName).toBe('Acme');
    const forged = await post(
      '/commands/hello',
      {
        installationId: 'inst-1',
        command: 'hello',
        args: '',
        conversationId: 'c',
        user: { id: 'u1', name: 'Elif' },
        token,
        locale: 'tr',
      },
      'y'.repeat(43),
    );
    expect(forged.status).toBe(401);
  });

  it('answers /hello with a note and a message, checking the session token', async () => {
    const res = await post('/commands/hello', {
      installationId: 'inst-1',
      command: 'hello',
      args: 'Can',
      conversationId: 'c1',
      user: { id: 'u1', name: 'Elif' },
      token,
      locale: 'tr',
    });
    expect(await res.json()).toEqual({
      reply: 'Merhaba Elif, Can için selam yazdım.',
      post: '👋 Merhaba Can!',
    });
  });

  it('runs its tool and counts events', async () => {
    const tool = await post('/tools/greet', {
      installationId: 'inst-1',
      tool: 'greet',
      input: { name: 'Can' },
      user: { id: 'u1', name: 'Elif' },
      token,
    });
    expect(await tool.json()).toEqual({ content: { greeting: 'Merhaba Can' }, summary: 'Can' });
    await post('/events', {
      id: 'e1',
      type: 'message.created',
      installationId: 'inst-1',
      occurredAt: new Date().toISOString(),
      data: { conversationId: 'c1' },
    });
    expect(plugin.events.count).toBe(1);
  });

  it('serves its pages for the iframe and forgets the installation on uninstall', async () => {
    const tab = await plugin.app.request('/tab');
    expect(await tab.text()).toContain('<script type="module" src="/client.js">');
    expect(
      (await post('/crewhall/lifecycle', { type: 'uninstall', installationId: 'inst-1' })).status,
    ).toBe(200);
    expect(plugin.store.get('inst-1')).toBeUndefined();
  });
});
