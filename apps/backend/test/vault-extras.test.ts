import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as C from '@crewhall/crypto';
import { ApiError } from '@crewhall/api-client';
import { clearBreachCache } from '../src/services/vault/breach';
import { purgeVault } from '../src/services/vault/purge';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Roadmap 20 against real Postgres: the org vault policy, the leaked password check relay
 * (k-anonymity, an org mirror standing in for Have I Been Pwned) and one-time share links. The
 * test plays the clients and does the cryptography with @crewhall/crypto.
 */

const FAST = { m: 32768, t: 2, p: 1 };

async function setupKeys(c: Client, userId: string) {
  const setup = await C.createAccountKeys({ userId, password: 'vault-password-2026!', kdf: FAST });
  const personalId = C.newId();
  const personalKey = C.newVaultKey();
  const wrappedKey = C.wrapVaultKey(personalKey, setup.publicKey, {
    vaultId: personalId,
    keyVersion: 1,
    userId,
  });
  await c.api.call('vaultSetupKeys', {
    body: { ...setup.upload, personalVault: { id: personalId, wrappedKey } },
  });
  return { personalId, personalKey };
}

async function addItem(c: Client, vaultId: string, vaultKey: Uint8Array, p: C.ItemPayloadInput) {
  const parsed = C.ItemPayload.parse(p);
  const id = C.newId();
  const enc = C.encryptItem(
    vaultKey,
    { vaultId, itemId: id, revision: 1, keyVersion: 1, type: parsed.type },
    parsed,
  );
  await c.api.call('vaultCreateItem', {
    params: { vaultId },
    body: { id, type: parsed.type, keyVersion: 1, ...enc },
  });
  return { id, payload: parsed };
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

/** A stand-in range API: records what it was asked and answers like api.pwnedpasswords.com. */
function mirror() {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  let status = 200;
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.statusCode = status;
    res.end(
      [
        '1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824',
        '0018A45C4D1DEF81644B54AB7F969B88D65:0',
      ].join('\r\n'),
    );
  });
  return {
    seen,
    server,
    setStatus: (s: number) => (status = s),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe('vault extras (roadmap 20)', () => {
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let ownerVault: { personalId: string; personalKey: Uint8Array };
  let docker: { id: string; payload: C.ItemPayload };
  const m = mirror();

  beforeAll(async () => {
    await new Promise<void>((r) => m.server.listen(0, '127.0.0.1', r));
    app = await createTestApp();
    const s = await setupWithOwner(app);
    owner = s.owner;
    member = (await join(app, owner, 'can@milvasoft.com', 'member')).person;
    ownerVault = await setupKeys(owner, s.ownerId);
    const memberMe = await member.api.call('me');
    await setupKeys(member, memberMe.user.id);
    docker = await addItem(owner, ownerVault.personalId, ownerVault.personalKey, {
      v: 1,
      type: 'login',
      name: 'Docker Hub',
      username: 'crewhall-deploy',
      password: 'T7#qWm2!vR9pLx4$Kd8z',
      totp: 'JBSWY3DPEHPK3PXP',
    });
  });
  afterAll(async () => {
    await app.close();
    await new Promise((r) => m.server.close(r));
  });
  beforeEach(() => clearBreachCache());

  describe('policy', () => {
    it('defaults: check on, public range API, links on; members read but cannot change', async () => {
      const p = await member.api.call('vaultPolicy');
      expect(p).toEqual({
        breachCheck: true,
        breachRangeUrl: null,
        shareLinks: true,
        shareMaxHours: 720,
        shareMaxViews: 20,
        canEdit: false,
      });
      const err = await apiError(
        member.api.call('vaultUpdatePolicy', { body: { breachCheck: false } }),
      );
      expect(err.status).toBe(403);
      expect((await owner.api.call('vaultPolicy')).canEdit).toBe(true);
    });

    it('admins set a mirror and limits; the change is logged', async () => {
      const p = await owner.api.call('vaultUpdatePolicy', {
        body: { breachRangeUrl: m.url(), shareMaxViews: 5 },
      });
      expect(p).toMatchObject({ breachRangeUrl: m.url(), shareMaxViews: 5, shareLinks: true });
      expect((await member.api.call('vaultPolicy')).shareMaxViews).toBe(5);
      const log = await owner.api.call('vaultEvents', { query: { action: 'policy.update' } });
      expect(log.items).toHaveLength(1);
      expect(JSON.stringify(log.items[0]?.meta)).not.toContain('127.0.0.1');
    });
  });

  describe('leaked password check', () => {
    it('relays only the 5-digit prefix, padded, through the org mirror', async () => {
      const { prefix, suffix } = C.pwnedQuery('password');
      const before = m.seen.length;
      const r = await member.api.call('vaultBreachRange', { params: { prefix } });
      expect(C.pwnedCount(r.range, suffix)).toBe(9545824);
      expect(m.seen.slice(before)).toHaveLength(1);
      expect(m.seen.at(-1)?.url).toBe('/range/5BAA6');
      expect(m.seen.at(-1)?.headers['add-padding']).toBe('true');
      // Cached: the same prefix does not go out again.
      await member.api.call('vaultBreachRange', { params: { prefix } });
      expect(m.seen.length).toBe(before + 1);
    });

    it('rejects anything but five upper-case hex digits', async () => {
      for (const prefix of ['5baa6', '5BAA61', 'ZZZZZ', '5BAA']) {
        const err = await apiError(member.api.call('vaultBreachRange', { params: { prefix } }));
        expect(err.status).toBe(404);
      }
    });

    it('answers 503 when the range API fails and 403 when the org turned it off', async () => {
      m.setStatus(500);
      const down = await apiError(
        member.api.call('vaultBreachRange', { params: { prefix: 'AAAAA' } }),
      );
      expect(down.code).toBe('vault_breach_unavailable');
      m.setStatus(200);
      await owner.api.call('vaultUpdatePolicy', { body: { breachCheck: false } });
      const off = await apiError(
        member.api.call('vaultBreachRange', { params: { prefix: 'AAAAA' } }),
      );
      expect(off.code).toBe('vault_breach_disabled');
      await owner.api.call('vaultUpdatePolicy', { body: { breachCheck: true } });
    });
  });

  describe('share links', () => {
    async function share(maxViews: number, hours = 24) {
      const key = C.newShareKey();
      const enc = C.encryptShare(key, C.sharePayloadOf(docker.payload));
      const created = await owner.api.call('vaultCreateShare', {
        params: { itemId: docker.id },
        body: { ...enc, maxViews, expiresInHours: hours },
      });
      return { key, created, token: created.token! };
    }

    it('stores only ciphertext; opens count down and the last one deletes the row', async () => {
      const { key, created, token } = await share(2);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created).toMatchObject({ itemId: docker.id, maxViews: 2, views: 0 });

      const anon = new Client(app);
      const preview = await anon.api.call('vaultPublicShare', { params: { token } });
      expect(preview.viewsLeft).toBe(2);

      const rows = await app.deps.db.execute<{ c: string; t: string }>(
        sql`select encode(ciphertext, 'escape') as c, encode(token_hash, 'hex') as t from vault_shares`,
      );
      const dump = JSON.stringify(rows.rows);
      for (const plain of ['Docker Hub', 'crewhall-deploy', 'T7#qWm2', token, C.shareFragment(key)]) {
        expect(dump).not.toContain(plain);
      }

      const first = await anon.api.call('vaultOpenShare', { params: { token } });
      expect(first.viewsLeft).toBe(1);
      expect(C.decryptShare(key, first)).toMatchObject({
        name: 'Docker Hub',
        password: 'T7#qWm2!vR9pLx4$Kd8z',
        totp: '',
      });
      const second = await anon.api.call('vaultOpenShare', { params: { token } });
      expect(second.viewsLeft).toBe(0);
      const count = await app.deps.db.execute<{ n: number }>(
        sql`select count(*)::int as n from vault_shares where id = ${created.id}`,
      );
      expect(count.rows[0]?.n).toBe(0);
      const gone = await apiError(anon.api.call('vaultOpenShare', { params: { token } }));
      expect(gone.status).toBe(410);
      expect(gone.code).toBe('vault_share_gone');

      const log = await owner.api.call('vaultEvents', { query: { action: 'share.open' } });
      expect(log.items.length).toBeGreaterThanOrEqual(2);
      expect(log.items[0]?.actor).toBeNull();
    });

    it('a single-use link opened twice at once is handed out once', async () => {
      const { token } = await share(1);
      const results = await Promise.allSettled(
        [1, 2, 3].map(() => new Client(app).api.call('vaultOpenShare', { params: { token } })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('lists and revokes; others cannot see or revoke my personal links', async () => {
      const { created, token } = await share(3);
      const mine = await owner.api.call('vaultShares', { query: { itemId: docker.id } });
      expect(mine.items.map((s) => s.id)).toContain(created.id);
      expect(mine.items.every((s) => s.token === undefined)).toBe(true);
      expect((await member.api.call('vaultShares', { query: {} })).items).toEqual([]);
      const denied = await apiError(
        member.api.call('vaultRevokeShare', { params: { shareId: created.id } }),
      );
      expect(denied.status).toBe(404);
      await owner.api.call('vaultRevokeShare', { params: { shareId: created.id } });
      const gone = await apiError(new Client(app).api.call('vaultPublicShare', { params: { token } }));
      expect(gone.code).toBe('vault_share_gone');
    });

    it('cannot share an item of a vault I cannot open', async () => {
      const key = C.newShareKey();
      const enc = C.encryptShare(key, C.sharePayloadOf(docker.payload));
      const err = await apiError(
        member.api.call('vaultCreateShare', {
          params: { itemId: docker.id },
          body: { ...enc, maxViews: 1, expiresInHours: 1 },
        }),
      );
      expect(err.status).toBe(404);
    });

    it('enforces the org limits and the off switch', async () => {
      const key = C.newShareKey();
      const enc = C.encryptShare(key, C.sharePayloadOf(docker.payload));
      const tooMany = await apiError(
        owner.api.call('vaultCreateShare', {
          params: { itemId: docker.id },
          body: { ...enc, maxViews: 6, expiresInHours: 1 },
        }),
      );
      expect(tooMany.code).toBe('vault_share_limit');
      const { token } = await share(5);
      await owner.api.call('vaultUpdatePolicy', { body: { shareLinks: false } });
      const off = await apiError(
        owner.api.call('vaultCreateShare', {
          params: { itemId: docker.id },
          body: { ...enc, maxViews: 1, expiresInHours: 1 },
        }),
      );
      expect(off.code).toBe('vault_share_disabled');
      // Links made before the switch stop working too.
      const open = await apiError(new Client(app).api.call('vaultOpenShare', { params: { token } }));
      expect(open.code).toBe('vault_share_disabled');
      await owner.api.call('vaultUpdatePolicy', { body: { shareLinks: true } });
    });

    it('expired links are refused and purged with their ciphertext', async () => {
      const { created, token } = await share(1, 1);
      await app.deps.db.execute(
        sql`update vault_shares set expires_at = now() - interval '1 minute' where id = ${created.id}`,
      );
      const err = await apiError(new Client(app).api.call('vaultPublicShare', { params: { token } }));
      expect(err.code).toBe('vault_share_gone');
      await purgeVault(app.deps.db);
      const left = await app.deps.db.execute<{ n: number }>(
        sql`select count(*)::int as n from vault_shares where id = ${created.id}`,
      );
      expect(left.rows[0]?.n).toBe(0);
    });

    it('a malformed token is simply gone', async () => {
      const err = await apiError(
        new Client(app).api.call('vaultPublicShare', { params: { token: 'nope' } }),
      );
      expect(err.code).toBe('vault_share_gone');
    });
  });
});
