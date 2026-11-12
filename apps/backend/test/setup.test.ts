import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogs, spaces } from '@crewhall/db';
import { eq } from 'drizzle-orm';
import { Client, createTestApp, SETUP_BODY, type TestApp } from './helpers';

describe('setup wizard', () => {
  let app: TestApp;
  let anon: Client;

  beforeAll(async () => {
    app = await createTestApp({ SETUP_TOKEN: 'setup-token-123' });
    anon = new Client(app);
  });
  afterAll(() => app.close());

  it('bootstrap reports that setup is needed, with product branding and checks', async () => {
    const boot = await anon.api.call('bootstrap');
    expect(boot.needsSetup).toBe(true);
    expect(boot.branding.appName).toBe('Crewhall');
    expect(boot.setup).toMatchObject({ tokenRequired: true, checks: { database: true } });
  });

  it('rejects a wrong or missing setup token', async () => {
    await expect(anon.api.call('setup', { body: SETUP_BODY })).rejects.toMatchObject({
      status: 403,
      code: 'setup_token_invalid',
    });
    await expect(
      anon.api.call('setup', { body: { ...SETUP_BODY, setupToken: 'nope' } }),
    ).rejects.toMatchObject({ code: 'setup_token_invalid' });
  });

  it('validates the body against the contract schema', async () => {
    const res = await anon.raw<{ code: string; details: { in: string } }>(
      'POST',
      '/api/v1/setup',
      {
        ...SETUP_BODY,
        owner: { ...SETUP_BODY.owner, password: 'short' },
        setupToken: 'setup-token-123',
      },
      { 'Accept-Language': 'en' },
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'validation_failed',
      message: 'Some fields are invalid.',
    });
    expect(res.body.details.in).toBe('body');
  });

  it('creates the org, owner, spaces and invitation links', async () => {
    const result = await anon.api.call('setup', {
      body: {
        ...SETUP_BODY,
        setupToken: 'setup-token-123',
        spaces: [
          { name: 'Milvasoft', color: 's1', isDefault: true },
          { name: 'Altyapı', color: 's2' },
        ],
        invitations: [
          { email: 'elif@milvasoft.com', role: 'admin' },
          { email: 'destek@dumpapp.io', role: 'guest' },
        ],
      },
    });
    expect(result.orgId).toBeTruthy();
    expect(result.invitations).toHaveLength(2);
    expect(result.invitations?.[0]?.url).toMatch(/^http:\/\/localhost:5173\/invite\//);

    const rows = await app.deps.db.select().from(spaces).where(eq(spaces.orgId, result.orgId));
    expect(rows.map((s) => [s.kind, s.slug, s.isDefault]).sort()).toEqual(
      [
        ['personal', expect.stringMatching(/^p-/), false],
        ['shared', 'altyapi', false],
        ['shared', 'milvasoft', true],
      ].sort(),
    );

    // Invitation mails go out with the org's brand; the owner gets a verification mail.
    const invite = app.mailer.outbox.find((m) => m.to === 'elif@milvasoft.com');
    expect(invite?.subject).toBe('Ahmet Buğra Kösen seni Milvasoft çalışma alanına davet etti');
    expect(invite?.html).toContain('Crewhall ile');
    expect(app.mailer.outbox.some((m) => m.to === SETUP_BODY.owner.email)).toBe(true);

    const [log] = await app.deps.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'setup.complete'));
    expect(log?.orgId).toBe(result.orgId);
  });

  it('runs only once', async () => {
    await expect(
      anon.api.call('setup', { body: { ...SETUP_BODY, setupToken: 'setup-token-123' } }),
    ).rejects.toMatchObject({ status: 409, code: 'setup_already_done' });
    await expect(
      anon.api.call('setupSmtpTest', {
        body: { to: 'it@example.com', setupToken: 'setup-token-123' },
      }),
    ).rejects.toMatchObject({ code: 'setup_already_done' });
  });

  it('bootstrap now carries the org brand and theme', async () => {
    const boot = await anon.api.call('bootstrap');
    expect(boot.needsSetup).toBe(false);
    expect(boot.setup).toBeUndefined();
    expect(boot.branding.orgName).toBe('Milvasoft');
    expect(boot.theme.version).toBe(1);
    const css = await anon.fetch('http://localhost:3000/api/theme.css');
    expect(await css.text()).toContain('--ch-accent:#FBC419');
    const manifest = await anon.fetch('http://localhost:3000/api/manifest.webmanifest');
    expect(manifest.headers.get('content-type')).toContain('application/manifest+json');
    expect(await manifest.json()).toMatchObject({ display: 'standalone', short_name: 'Milvasoft' });
  });
});

describe('health', () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('serves healthz, readyz and a contract-shaped 404', async () => {
    const c = new Client(app);
    expect((await c.raw('GET', '/healthz')).body).toEqual({ status: 'ok' });
    expect((await c.raw('GET', '/readyz')).body).toEqual({ status: 'ready' });
    const missing = await c.raw('GET', '/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'not_found' });
  });

  it('accepts setup without a token on a dev server without SETUP_TOKEN', async () => {
    const c = new Client(app);
    expect((await c.api.call('bootstrap')).setup?.tokenRequired).toBe(false);
    const res = await c.api.call('setup', { body: SETUP_BODY });
    expect(res.ownerId).toBeTruthy();
  });
});
