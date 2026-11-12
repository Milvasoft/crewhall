import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { resetDemo } from '../src/services/demo';
import { DEMO_ACCOUNTS, setDemoMode } from '../src/services/demo-flag';
import { s3ObjectStore } from '../src/ops/objects';
import { Client, createTestApp, type TestApp } from './helpers';

/**
 * Hourly-reset live demo: the reset brings back the sample, visitors sign in with the
 * listed accounts without a second factor, and settings that could lock others out are off.
 */
describe('live demo', { timeout: 300_000 }, () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({ DEMO_MODE: 'true' });
  });
  afterAll(async () => {
    setDemoMode(false);
    await app.close();
  });

  const signIn = async (email: string) => {
    const c = new Client(app);
    const account = DEMO_ACCOUNTS.find((a) => a.email === email)!;
    const res = await c.auth('/sign-in/email', { email, password: account.password });
    expect(res.status).toBe(200);
    return c;
  };

  it('seeds the sample and lists the demo accounts', async () => {
    await resetDemo(app.deps);
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.needsSetup).toBe(false);
    expect(boot.demo?.accounts.map((a) => a.role)).toEqual(['owner', 'admin', 'member', 'guest']);
    expect(Date.parse(boot.demo!.resetAt)).toBeGreaterThan(Date.now());

    // The owner gets in without a second factor and works normally.
    const owner = await signIn(DEMO_ACCOUNTS[0]!.email);
    const me = await owner.api.call('me');
    expect(me.twoFactorRequired).toBe(false);
    expect((await owner.api.call('listSpaces')).items.length).toBeGreaterThan(1);
  });

  it('contains nothing of a real company: every table, binary documents included', async () => {
    // Names, people, products and systems of the development seed's real company.
    const forbidden =
      /milvasoft|dumpapp|milvaion|opsiyon|netcup|cavepass|visualstudio\.com|nuget\.org|hub\.docker|k[öo]sen|bu[ğg]ra|@milvasoft/i;
    const tables = await app.deps.db.execute<{ name: string }>(
      sql`select tablename as name from pg_tables where schemaname = 'public'`,
    );
    const hits: string[] = [];
    for (const { name } of tables.rows) {
      const rows = await app.deps.db.execute<{ j: string }>(
        sql.raw(`select row_to_json(scan_row)::text as j from "${name}" scan_row`),
      );
      for (const { j } of rows.rows) {
        // bytea (Yjs documents of pages, cards, drawings) comes as hex: read it as text too.
        const binary = [...j.matchAll(/\\\\x([0-9a-f]+)/g)].map((m) => Buffer.from(m[1]!, 'hex'));
        const texts = [j, ...binary.flatMap((b) => [b.toString('utf8'), b.toString('latin1')])];
        const found = texts.map((t) => forbidden.exec(t)?.[0]).find(Boolean);
        if (found) hits.push(`${name}: ${found}`);
      }
    }
    // The scan must have seen the Yjs documents, or it proves nothing about them.
    const pages = await app.deps.db.execute<{ j: string }>(
      sql`select row_to_json(p)::text as j from pages p limit 1`,
    );
    expect(pages.rows[0]?.j).toMatch(/\\\\x[0-9a-f]{20}/);
    expect(tables.rows.length).toBeGreaterThan(50);
    expect(hits).toEqual([]);

    const boot = await new Client(app).api.call('bootstrap');
    expect(JSON.stringify(boot)).not.toMatch(forbidden);
    expect(boot.branding.orgName).toBe('Nova Teknoloji A.Ş.');
    for (const a of boot.demo!.accounts) expect(a.email).toMatch(/@[a-z]+\.example$/);
  });

  it('keeps shared accounts and lock-out settings untouchable', async () => {
    const owner = await signIn(DEMO_ACCOUNTS[0]!.email);
    await expect(
      owner.api.call('updateSecurityPolicy', { body: { session: { hours: 1 } } as never }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const res = await owner.auth('/change-password', {
      currentPassword: DEMO_ACCOUNTS[0]!.password,
      newPassword: 'baska-bir-sifre-123',
    });
    expect(res.status).toBe(403);
    // Still the same password.
    await signIn(DEMO_ACCOUNTS[0]!.email);
  });

  it('wipes what visitors added, files included, at the next reset', async () => {
    const owner = await signIn(DEMO_ACCOUNTS[0]!.email);
    const spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.kind === 'shared')!.id;
    await owner.api.call('createFolder', {
      params: { spaceId },
      body: { parentId: null, name: 'Ziyaretçi klasörü' },
    });
    const s3 = new S3Client({
      endpoint: inject('s3Endpoint'),
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      forcePathStyle: true,
    });
    await s3.send(
      new PutObjectCommand({ Bucket: app.env.S3_BUCKET, Key: 'ziyaretci/dosya.txt', Body: 'x' }),
    );

    await resetDemo(app.deps);
    const again = await signIn(DEMO_ACCOUNTS[0]!.email);
    const space = (await again.api.call('listSpaces')).items.find((s) => s.kind === 'shared')!;
    const search = await again.api.call('searchNodes', { query: { q: 'Ziyaretçi' } as never });
    expect(search.items).toEqual([]);
    expect(space.name).toBeTruthy();
    const store = s3ObjectStore({
      endpoint: inject('s3Endpoint'),
      region: 'us-east-1',
      bucket: app.env.S3_BUCKET,
      accessKeyId: 'test',
      secretAccessKey: 'test',
    });
    const keys: string[] = [];
    for await (const o of store.list()) keys.push(o.key);
    expect(keys).not.toContain('ziyaretci/dosya.txt');
  });
});
