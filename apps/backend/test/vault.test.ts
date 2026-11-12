import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as C from '@crewhall/crypto';
import { ApiError } from '@crewhall/api-client';
import { reconcileSpaceBytes } from '../src/services/drive/quota';
import { purgeVault } from '../src/services/vault/purge';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

/**
 * Vault end to end against real Postgres and SeaweedFS (doc 17 §14 Faz 5 "bitti" criteria).
 * The test plays the clients: it does every bit of cryptography with @crewhall/crypto, the
 * way web and mobile do, and checks that the server only ever stores ciphertext.
 */

const FAST = { m: 32768, t: 2, p: 1 };

interface Person {
  c: Client;
  userId: string;
  password: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  recoveryKey: string;
  personalId: string;
  personalKey: Uint8Array;
}

async function setupKeys(c: Client, userId: string, password: string): Promise<Person> {
  const setup = await C.createAccountKeys({ userId, password, kdf: FAST });
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
  return {
    c,
    userId,
    password,
    privateKey: setup.privateKey,
    publicKey: setup.publicKey,
    recoveryKey: setup.recoveryKey,
    personalId,
    personalKey,
  };
}

function encrypt(
  vaultKey: Uint8Array,
  vaultId: string,
  payload: C.ItemPayloadInput,
  opts: { id?: string; revision?: number; keyVersion?: number } = {},
) {
  const parsed = C.ItemPayload.parse(payload);
  const id = opts.id ?? C.newId();
  const keyVersion = opts.keyVersion ?? 1;
  const enc = C.encryptItem(
    vaultKey,
    { vaultId, itemId: id, revision: opts.revision ?? 1, keyVersion, type: parsed.type },
    parsed,
  );
  return { id, type: parsed.type, keyVersion, ...enc };
}

function decrypt(
  vaultKey: Uint8Array,
  item: {
    id: string;
    vaultId: string;
    revision: number;
    keyVersion: number;
    type: C.ItemType;
    ciphertext: string;
    nonce: string;
    itemKeyWrapped: string;
  },
) {
  return C.decryptItem(
    vaultKey,
    {
      vaultId: item.vaultId,
      itemId: item.id,
      revision: item.revision,
      keyVersion: item.keyVersion,
      type: item.type,
    },
    item,
  );
}

async function unlockWithPassword(p: Person) {
  const status = await p.c.api.call('vaultKeys');
  const m = await C.passwordUnlockMaterial(p.password, status.kdf!);
  const bundle = await p.c.api.call('vaultUnlock', {
    body: { method: 'password', verifier: C.toB64(m.verifier) },
  });
  return C.openPrivateKey({
    kek: m.kek,
    wrapped: bundle.wrappedPrivateKey,
    userId: p.userId,
    method: 'password',
    publicKey: bundle.publicKey,
  });
}

async function openVaultKey(p: Person, vaultId: string) {
  const v = await p.c.api.call('vaultGet', { params: { vaultId } });
  return C.unwrapVaultKey(p.privateKey, v.myWrappedKey, {
    vaultId,
    keyVersion: v.keyVersion,
    userId: p.userId,
  });
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

/** Every secret the clients ever handled; none may appear in the database in any form. */
const SECRETS = new Set<string>();
const secret = <T extends string>(s: T) => {
  SECRETS.add(s);
  return s;
};

describe('vault', () => {
  let app: TestApp;
  let owner: Person;
  let mert: Person;
  let can: Person;
  let selin: Person;
  let guest: Client;
  let altyapiId: string;
  let spaceVaultId: string;
  let spaceKey: Uint8Array;
  let dockerId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const s = await setupWithOwner(app);
    const spaces = await s.owner.api.call('listSpaces');
    altyapiId = spaces.items.find((x) => x.name === 'Altyapı')!.id;

    const m = await join(app, s.owner, 'mert@milvasoft.com', 'admin');
    // Admins fall under the org 2FA policy.
    await m.person.enrolTotp();
    const cn = await join(app, s.owner, 'can@milvasoft.com', 'member');
    const sl = await join(app, s.owner, 'selin@milvasoft.com', 'member');
    guest = (await join(app, s.owner, 'misafir@example.com', 'guest')).person;
    await s.owner.api.call('addSpaceMember', {
      params: { spaceId: altyapiId },
      body: { userId: m.me.user.id, role: 'admin' },
    });
    await s.owner.api.call('addSpaceMember', {
      params: { spaceId: altyapiId },
      body: { userId: cn.me.user.id, role: 'editor' },
    });

    owner = await setupKeys(s.owner, s.ownerId, secret('Kasa-Şifresi-Çok-Güçlü-2026!'));
    mert = await setupKeys(m.person, m.me.user.id, secret('mert-vault-password-42'));
    can = await setupKeys(cn.person, cn.me.user.id, secret('can-vault-password-43'));
    selin = await setupKeys(sl.person, sl.me.user.id, secret('selin-vault-password-44'));
    for (const p of [owner, mert, can, selin]) secret(p.recoveryKey.replace(/ /g, ''));
  });
  afterAll(() => app.close());

  describe('keys and unlock', () => {
    it('reports public key state only', async () => {
      const status = await owner.c.api.call('vaultKeys');
      expect(status).toMatchObject({
        setUp: true,
        keyVersion: 1,
        unlockMethods: [],
        failedAttempts: 0,
      });
      expect(status.publicKey).toBe(C.toB64(owner.publicKey));
      expect(JSON.stringify(status)).not.toMatch(/wrapped|encrypted/i);
      const none = await new Client(app).raw('GET', '/api/v1/vault/keys');
      expect(none.status).toBe(401);
    });

    it('refuses a second setup', async () => {
      const again = await C.createAccountKeys({
        userId: owner.userId,
        password: 'x'.repeat(20),
        kdf: FAST,
      });
      const err = await apiError(
        owner.c.api.call('vaultSetupKeys', {
          body: {
            ...again.upload,
            personalVault: { id: C.newId(), wrappedKey: again.upload.encryptedPrivateKey },
          },
        }),
      );
      expect(err.code).toBe('vault_already_set_up');
    });

    it('releases the wrapped key only for the right verifier', async () => {
      const pk = await unlockWithPassword(owner);
      expect(C.toB64(pk)).toBe(C.toB64(owner.privateKey));
    });

    it('waits 30 s after 5 wrong attempts, enforced by the server', async () => {
      const bad = C.toB64(C.randomBytes(32));
      for (let i = 1; i <= 4; i++) {
        const err = await apiError(
          can.c.api.call('vaultUnlock', { body: { method: 'password', verifier: bad } }),
        );
        expect(err.code).toBe('vault_unlock_failed');
        expect(err.details).toEqual({ remaining: 5 - i });
      }
      const fifth = await apiError(
        can.c.api.call('vaultUnlock', { body: { method: 'password', verifier: bad } }),
      );
      expect(fifth.status).toBe(429);
      expect(fifth.code).toBe('vault_unlock_locked');
      // Even the right password waits.
      const status = await can.c.api.call('vaultKeys');
      expect(status.lockedUntil).not.toBeNull();
      const m = await C.passwordUnlockMaterial(can.password, status.kdf!);
      const locked = await apiError(
        can.c.api.call('vaultUnlock', {
          body: { method: 'password', verifier: C.toB64(m.verifier) },
        }),
      );
      expect(locked.code).toBe('vault_unlock_locked');
      await app.deps.db.execute(
        sql`update user_keys set locked_until = now() - interval '1 second' where user_id = ${can.userId}`,
      );
      expect(C.toB64(await unlockWithPassword(can))).toBe(C.toB64(can.privateKey));
      expect((await can.c.api.call('vaultKeys')).failedAttempts).toBe(0);
    });

    it('recovers a forgotten password with the recovery key, then rotates the recovery key', async () => {
      const rec = C.recoveryUnlockMaterial(selin.recoveryKey);
      const bundle = await selin.c.api.call('vaultUnlock', {
        body: { method: 'recovery', verifier: C.toB64(rec.verifier) },
      });
      const pk = C.openPrivateKey({
        kek: rec.kek,
        wrapped: bundle.wrappedPrivateKey,
        userId: selin.userId,
        method: 'recovery',
        publicKey: bundle.publicKey,
      });
      const newPassword = secret('selin-new-vault-password-45');
      const wrap = await C.wrapForPassword(pk, selin.userId, newPassword, C.newKdfParams(FAST));
      await selin.c.api.call('vaultChangePassword', {
        body: { proof: { method: 'recovery', verifier: C.toB64(rec.verifier) }, ...wrap },
      });
      const oldPassword = selin.password;
      selin.password = newPassword;
      expect(C.toB64(await unlockWithPassword(selin))).toBe(C.toB64(selin.privateKey));
      const old = await C.passwordUnlockMaterial(oldPassword, wrap.kdf);
      expect(
        (
          await apiError(
            selin.c.api.call('vaultUnlock', {
              body: { method: 'password', verifier: C.toB64(old.verifier) },
            }),
          )
        ).code,
      ).toBe('vault_unlock_failed');

      // New recovery key: the old one stops working at once.
      const pw = await C.passwordUnlockMaterial(newPassword, wrap.kdf);
      const fresh = C.newRecovery(pk, selin.userId);
      secret(fresh.recoveryKey.replace(/ /g, ''));
      await selin.c.api.call('vaultRotateRecovery', {
        body: {
          proof: { method: 'password', verifier: C.toB64(pw.verifier) },
          recoveryWrappedKey: fresh.recoveryWrappedKey,
          recoveryVerifier: fresh.recoveryVerifier,
        },
      });
      const stale = await apiError(
        selin.c.api.call('vaultUnlock', {
          body: { method: 'recovery', verifier: C.toB64(rec.verifier) },
        }),
      );
      expect(stale.code).toBe('vault_unlock_failed');
      selin.recoveryKey = fresh.recoveryKey;
      await app.deps.db.execute(
        sql`update user_keys set failed_attempts = 0 where user_id = ${selin.userId}`,
      );
    });

    it('adds a passkey PRF unlock method and opens with it', async () => {
      const status = await mert.c.api.call('vaultKeys');
      const pw = await C.passwordUnlockMaterial(mert.password, status.kdf!);
      const prfOutput = C.randomBytes(32);
      const wrap = C.wrapForSecret(mert.privateKey, mert.userId, 'passkey_prf', prfOutput);
      const method = await mert.c.api.call('vaultAddUnlockMethod', {
        body: {
          proof: { method: 'password', verifier: C.toB64(pw.verifier) },
          method: 'passkey_prf',
          label: 'MacBook Touch ID',
          credentialId: 'cred-1',
          prfSalt: C.newPrfSalt(),
          ...wrap,
        },
      });
      expect(method).toMatchObject({
        method: 'passkey_prf',
        label: 'MacBook Touch ID',
        credentialId: 'cred-1',
      });
      const m = C.secretUnlockMaterial(prfOutput);
      const bundle = await mert.c.api.call('vaultUnlock', {
        body: { method: 'passkey_prf', unlockId: method.id, verifier: C.toB64(m.verifier) },
      });
      expect(
        C.toB64(
          C.openPrivateKey({
            kek: m.kek,
            wrapped: bundle.wrappedPrivateKey,
            userId: mert.userId,
            method: 'passkey_prf',
            publicKey: bundle.publicKey,
          }),
        ),
      ).toBe(C.toB64(mert.privateKey));
      // A wrong proof cannot add methods.
      const err = await apiError(
        mert.c.api.call('vaultAddUnlockMethod', {
          body: {
            proof: { method: 'password', verifier: C.toB64(C.randomBytes(32)) },
            method: 'device',
            label: 'x',
            ...wrap,
          },
        }),
      );
      expect(err.code).toBe('vault_unlock_failed');
      await app.deps.db.execute(
        sql`update user_keys set failed_attempts = 0 where user_id = ${mert.userId}`,
      );
    });

    it('stores encrypted settings', async () => {
      const blob = C.encryptSettings(owner.privateKey, owner.userId, { autoLockMinutes: 5 });
      await owner.c.api.call('vaultUpdateSettings', { body: { settings: blob } });
      expect(await owner.c.api.call('vaultGetSettings')).toEqual({ settings: blob });
      const status = await owner.c.api.call('vaultKeys');
      const m = await C.passwordUnlockMaterial(owner.password, status.kdf!);
      const bundle = await owner.c.api.call('vaultUnlock', {
        body: { method: 'password', verifier: C.toB64(m.verifier) },
      });
      expect(C.decryptSettings(owner.privateKey, owner.userId, bundle.settings!)).toEqual({
        autoLockMinutes: 5,
      });
    });

    it('guests have no vault', async () => {
      expect((await guest.raw('GET', '/api/v1/vault/keys')).status).toBe(403);
    });
  });

  describe('personal vault and items', () => {
    it('lists the personal vault, opens its key and round-trips an item', async () => {
      const { items } = await owner.c.api.call('vaultList');
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: owner.personalId,
        kind: 'personal',
        name: null,
        myRole: 'manage',
        canManage: false,
        canEdit: true,
      });
      const key = await openVaultKey(owner, owner.personalId);
      expect(C.toB64(key)).toBe(C.toB64(owner.personalKey));

      const body = encrypt(key, owner.personalId, {
        v: 1,
        type: 'login',
        name: secret('Docker Hub Crewhall'),
        username: secret('crewhall-docker-user'),
        password: secret('T7#qWm2!vR9pLx4$Kd8z'),
        totp: secret('otpauth://totp/Docker:crewhall?secret=JBSWY3DPEHPK3PXQ'),
        uris: [secret('https://hub.docker.example.com')],
        notes: secret('Yalnız organizasyon yönetimi için kullanılır.'),
      });
      dockerId = body.id;
      const created = await owner.c.api.call('vaultCreateItem', {
        params: { vaultId: owner.personalId },
        body,
      });
      expect(created).toMatchObject({
        id: body.id,
        type: 'login',
        revision: 1,
        keyVersion: 1,
        deletedAt: null,
      });
      expect(created.createdBy?.id).toBe(owner.userId);
      const page = await owner.c.api.call('vaultItems', { params: { vaultId: owner.personalId } });
      expect(decrypt(key, page.items[0]!)).toMatchObject({
        name: 'Docker Hub Crewhall',
        password: 'T7#qWm2!vR9pLx4$Kd8z',
      });
      expect(
        (await owner.c.api.call('vaultGet', { params: { vaultId: owner.personalId } })).itemCount,
      ).toBe(1);
    });

    it('nobody else sees a personal vault, org admins included', async () => {
      expect((await mert.c.raw('GET', `/api/v1/vault/vaults/${owner.personalId}`)).status).toBe(
        404,
      );
      expect((await mert.c.raw('GET', `/api/v1/vault/items/${dockerId}`)).status).toBe(404);
      expect((await mert.c.api.call('vaultList')).items.map((v) => v.id)).toEqual([
        mert.personalId,
      ]);
    });

    it('revisions only increase: conflicts and rollbacks are refused', async () => {
      const key = owner.personalKey;
      const v2 = encrypt(
        key,
        owner.personalId,
        {
          v: 1,
          type: 'login',
          name: 'Docker Hub Crewhall',
          password: secret('second-docker-password'),
        },
        { id: dockerId, revision: 2 },
      );
      const saved = await owner.c.api.call('vaultUpdateItem', {
        params: { itemId: dockerId },
        body: { ...v2, revision: 2 },
      });
      expect(saved.revision).toBe(2);

      // Same revision again: someone saved in between (design 8.8).
      const conflict = await apiError(
        owner.c.api.call('vaultUpdateItem', {
          params: { itemId: dockerId },
          body: { ...v2, revision: 2 },
        }),
      );
      expect(conflict.code).toBe('vault_revision_conflict');
      expect(conflict.details).toMatchObject({ currentRevision: 2 });

      // Rolling back to an older revision number is refused too.
      const v1 = encrypt(
        key,
        owner.personalId,
        { v: 1, type: 'login', name: 'x' },
        { id: dockerId, revision: 1 },
      );
      const rollback = await owner.c.raw('PUT', `/api/v1/vault/items/${dockerId}`, {
        ...v1,
        revision: 1,
      });
      expect(rollback.status).toBe(422);

      // A ciphertext for revision 4 sent as revision 3 does not decrypt on the client (AAD).
      const v4 = encrypt(
        key,
        owner.personalId,
        { v: 1, type: 'login', name: 'Docker Hub Crewhall' },
        { id: dockerId, revision: 4 },
      );
      const mislabeled = await owner.c.api.call('vaultUpdateItem', {
        params: { itemId: dockerId },
        body: { ...v4, revision: 3 },
      });
      expect(() => decrypt(key, mislabeled)).toThrow(C.CryptoError);

      const history = await owner.c.api.call('vaultItemRevisions', {
        params: { itemId: dockerId },
      });
      expect(history.items.map((r) => r.revision)).toEqual([2, 1]);
      const old = C.decryptItem(
        key,
        { vaultId: owner.personalId, itemId: dockerId, revision: 2, keyVersion: 1, type: 'login' },
        history.items[0]!,
      );
      expect(old).toMatchObject({ password: 'second-docker-password' });
    });

    it('keeps the last 10 revisions', async () => {
      const key = owner.personalKey;
      let current = (await owner.c.api.call('vaultGetItem', { params: { itemId: dockerId } }))
        .revision;
      for (let i = 0; i < 11; i++) {
        current++;
        const body = encrypt(
          key,
          owner.personalId,
          { v: 1, type: 'login', name: 'Docker Hub Crewhall', password: `pw-${i}` },
          { id: dockerId, revision: current },
        );
        await owner.c.api.call('vaultUpdateItem', {
          params: { itemId: dockerId },
          body: { ...body, revision: current },
        });
      }
      const history = await owner.c.api.call('vaultItemRevisions', {
        params: { itemId: dockerId },
      });
      expect(history.items).toHaveLength(10);
      expect(history.items[0]!.revision).toBe(current - 1);
      const [{ n }] = (
        await app.deps.db.execute(
          sql`select count(*)::int as n from vault_item_revisions where item_id = ${dockerId}`,
        )
      ).rows as [{ n: number }];
      expect(n).toBe(10);
    });

    it('deletes one kept revision for good, never the current one', async () => {
      const item = await owner.c.api.call('vaultGetItem', { params: { itemId: dockerId } });
      const history = await owner.c.api.call('vaultItemRevisions', {
        params: { itemId: dockerId },
      });
      const oldest = history.items.at(-1)!.revision;
      const remove = (who: Person, revision: number | string) =>
        who.c.api.call('vaultDeleteItemRevision', {
          params: { itemId: dockerId, revision: String(revision) },
        });

      expect((await apiError(remove(owner, item.revision))).code).toBe('vault_revision_current');
      expect((await apiError(remove(owner, item.revision + 1))).code).toBe('not_found');
      expect((await apiError(remove(owner, 'x'))).code).toBe('not_found');
      expect((await apiError(remove(mert, oldest))).code).toBe('not_found');

      await remove(owner, oldest);
      const after = await owner.c.api.call('vaultItemRevisions', { params: { itemId: dockerId } });
      expect(after.items.map((r) => r.revision)).toEqual(
        history.items.map((r) => r.revision).filter((r) => r !== oldest),
      );
      expect(
        await owner.c.api.call('vaultGetItem', { params: { itemId: dockerId } }),
      ).toMatchObject({ revision: item.revision });
      expect((await apiError(remove(owner, oldest))).code).toBe('not_found');

      const audited = (
        await app.deps.db.execute(
          sql`select meta from audit_logs where action = 'vault.revision_purge'`,
        )
      ).rows as { meta: { itemId: string; revision: number } }[];
      expect(audited.map((r) => r.meta)).toEqual([{ itemId: dockerId, revision: oldest }]);
      const { items: events } = await owner.c.api.call('vaultEvents', {
        query: { vaultId: owner.personalId },
      });
      expect(events.map((e) => e.action)).toContain('item.revision_purge');
    });

    it('trash, restore and purge', async () => {
      const body = encrypt(owner.personalKey, owner.personalId, {
        v: 1,
        type: 'note',
        name: secret('Silinecek gizli not'),
        notes: secret('çok gizli içerik 123'),
      });
      await owner.c.api.call('vaultCreateItem', { params: { vaultId: owner.personalId }, body });
      const trashed = await owner.c.api.call('vaultTrashItem', { params: { itemId: body.id } });
      expect(trashed.deletedBy?.id).toBe(owner.userId);
      // Trashed items are read-only.
      const edit = encrypt(
        owner.personalKey,
        owner.personalId,
        { v: 1, type: 'note', name: 'y' },
        { id: body.id, revision: 2 },
      );
      expect(
        (
          await apiError(
            owner.c.api.call('vaultUpdateItem', {
              params: { itemId: body.id },
              body: { ...edit, revision: 2 },
            }),
          )
        ).code,
      ).toBe('conflict');
      const restored = await owner.c.api.call('vaultRestoreItem', { params: { itemId: body.id } });
      expect(restored.deletedAt).toBeNull();
      await owner.c.api.call('vaultTrashItem', { params: { itemId: body.id } });
      expect(
        (await owner.c.api.call('vaultEmptyTrash', { params: { vaultId: owner.personalId } }))
          .purged,
      ).toBe(1);
      expect((await owner.c.raw('GET', `/api/v1/vault/items/${body.id}`)).status).toBe(404);
    });
  });

  describe('space vault, sharing and key rotation', () => {
    it('space owners create space vaults; members cannot', async () => {
      const id = C.newId();
      spaceKey = C.newVaultKey();
      const wrappedKey = C.wrapVaultKey(spaceKey, owner.publicKey, {
        vaultId: id,
        keyVersion: 1,
        userId: owner.userId,
      });
      const denied = await apiError(
        can.c.api.call('vaultCreate', {
          body: { id: C.newId(), spaceId: altyapiId, name: 'Altyapı', wrappedKey },
        }),
      );
      expect(denied.code).toBe('forbidden');
      const v = await owner.c.api.call('vaultCreate', {
        body: { id, spaceId: altyapiId, name: 'Altyapı', wrappedKey },
      });
      expect(v).toMatchObject({
        kind: 'space',
        name: 'Altyapı',
        canManage: true,
        memberCount: 1,
        space: { id: altyapiId },
      });
      spaceVaultId = id;
      // Space membership alone does not open the vault (design 8.10).
      expect((await mert.c.raw('GET', `/api/v1/vault/vaults/${id}`)).status).toBe(404);
    });

    it('grants access by sealing the vault key to each person', async () => {
      const candidates = await owner.c.api.call('vaultCandidates', {
        params: { vaultId: spaceVaultId },
      });
      const byEmail = new Map(candidates.items.map((c) => [c.user.email, c]));
      expect(byEmail.get('mert@milvasoft.com')).toMatchObject({
        spaceRole: 'admin',
        fingerprint: C.fingerprint(mert.publicKey),
      });
      expect(byEmail.get('selin@milvasoft.com')?.spaceRole).toBeNull();
      expect(byEmail.has('misafir@example.com')).toBe(false);

      for (const [p, role] of [
        [mert, 'manage'],
        [can, 'edit'],
        [selin, 'read'],
      ] as const) {
        const pub = await owner.c.api.call('vaultPublicKey', { params: { userId: p.userId } });
        expect(C.fingerprint(C.fromB64(pub.publicKey))).toBe(pub.fingerprint);
        const wrappedKey = C.wrapVaultKey(spaceKey, pub.publicKey, {
          vaultId: spaceVaultId,
          keyVersion: 1,
          userId: p.userId,
        });
        const m = await owner.c.api.call('vaultGrant', {
          params: { vaultId: spaceVaultId },
          body: { userId: p.userId, role, keyVersion: 1, wrappedKey },
        });
        expect(m).toMatchObject({ role, user: { id: p.userId } });
      }
      // Selin was outside the space: she joined it as viewer.
      const members = await owner.c.api.call('listSpaceMembers', {
        params: { spaceId: altyapiId },
      });
      expect(members.items.find((m) => m.user.id === selin.userId)?.role).toBe('viewer');
      for (const p of [mert, can, selin]) {
        expect(C.toB64(await openVaultKey(p, spaceVaultId))).toBe(C.toB64(spaceKey));
      }
      // Only managers with a space admin role share.
      const err = await apiError(
        can.c.api.call('vaultGrant', {
          params: { vaultId: spaceVaultId },
          body: {
            userId: owner.userId,
            role: 'read',
            keyVersion: 1,
            wrappedKey: C.wrapVaultKey(spaceKey, owner.publicKey, {
              vaultId: spaceVaultId,
              keyVersion: 1,
              userId: owner.userId,
            }),
          },
        }),
      );
      expect(err.code).toBe('forbidden');
    });

    it('permissions follow vault role and space role', async () => {
      const item = encrypt(spaceKey, spaceVaultId, {
        v: 1,
        type: 'login',
        name: secret('PostgreSQL prod'),
        username: 'postgres',
        password: secret('pg-prod-super-secret-77'),
        uris: [secret('milva-01.internal:5432')],
      });
      await can.c.api.call('vaultCreateItem', { params: { vaultId: spaceVaultId }, body: item });
      const ssh = encrypt(spaceKey, spaceVaultId, {
        v: 1,
        type: 'ssh_key',
        name: secret('milva-01 root SSH key'),
        ...(() => {
          const k = C.generateEd25519SshKey('root@milva-01');
          secret(k.privateKey.split('\n')[1]!);
          return { privateKey: k.privateKey, publicKey: k.publicKey, fingerprint: k.fingerprint };
        })(),
      });
      await mert.c.api.call('vaultCreateItem', { params: { vaultId: spaceVaultId }, body: ssh });

      // Selin reads but cannot write.
      const page = await selin.c.api.call('vaultItems', { params: { vaultId: spaceVaultId } });
      const key = await openVaultKey(selin, spaceVaultId);
      expect(page.items.map((i) => decrypt(key, i).name).sort()).toEqual([
        'PostgreSQL prod',
        'milva-01 root SSH key',
      ]);
      const write = await apiError(
        selin.c.api.call('vaultCreateItem', {
          params: { vaultId: spaceVaultId },
          body: encrypt(spaceKey, spaceVaultId, { v: 1, type: 'note', name: 'n' }),
        }),
      );
      expect(write.code).toBe('forbidden');
      // Can edits but cannot purge or manage.
      expect(
        (await apiError(can.c.api.call('vaultPurgeItem', { params: { itemId: item.id } }))).code,
      ).toBe('forbidden');
      const vault = (await can.c.api.call('vaultList')).items.find((v) => v.id === spaceVaultId)!;
      expect(vault).toMatchObject({
        myRole: 'edit',
        canEdit: true,
        canManage: false,
        memberCount: 4,
        itemCount: 2,
      });
      // A write under a stale key version is refused.
      const stale = await apiError(
        can.c.api.call('vaultCreateItem', {
          params: { vaultId: spaceVaultId },
          body: encrypt(
            spaceKey,
            spaceVaultId,
            { v: 1, type: 'note', name: 'n' },
            { keyVersion: 2 },
          ),
        }),
      );
      expect(stale.code).toBe('vault_key_version_mismatch');
    });

    it('cannot remove the last manager', async () => {
      const err = await apiError(
        owner.c.api.call('vaultUpdateMember', {
          params: { vaultId: owner.personalId, userId: owner.userId },
          body: { role: 'read' },
        }),
      );
      expect(err.code).toBe('vault_personal_not_shareable');
      await owner.c.api.call('vaultUpdateMember', {
        params: { vaultId: spaceVaultId, userId: mert.userId },
        body: { role: 'edit' },
      });
      const last = await apiError(
        owner.c.api.call('vaultUpdateMember', {
          params: { vaultId: spaceVaultId, userId: owner.userId },
          body: { role: 'edit' },
        }),
      );
      expect(last.code).toBe('vault_last_manager');
      await owner.c.api.call('vaultUpdateMember', {
        params: { vaultId: spaceVaultId, userId: mert.userId },
        body: { role: 'manage' },
      });
    });

    it('removing a member rotates the key; the removed member opens nothing new', async () => {
      // Selin's old copy of the key, as a removed member would keep it.
      const selinOldKey = await openVaultKey(selin, spaceVaultId);
      const before = await owner.c.api.call('vaultItems', { params: { vaultId: spaceVaultId } });
      // Leave one revision in the history so rotation re-wraps it.
      const first = before.items[0]!;
      const edited = encrypt(
        spaceKey,
        spaceVaultId,
        { ...decrypt(spaceKey, first), notes: 'edited' } as C.ItemPayloadInput,
        { id: first.id, revision: 2 },
      );
      await owner.c.api.call('vaultUpdateItem', {
        params: { itemId: first.id },
        body: { ...edited, revision: 2 },
      });

      const data = await owner.c.api.call('vaultRotationData', {
        params: { vaultId: spaceVaultId },
      });
      expect(data.vault.keyVersion).toBe(1);
      const newKey = C.newVaultKey();
      const keyVersion = 2;
      const remaining = data.members.filter((m) => m.user.id !== selin.userId);
      const payload = {
        keyVersion,
        removeUserIds: [selin.userId],
        members: remaining.map((m) => ({
          userId: m.user.id,
          wrappedKey: C.wrapVaultKey(newKey, m.publicKey, {
            vaultId: spaceVaultId,
            keyVersion,
            userId: m.user.id,
          }),
        })),
        items: data.items.map((i) => {
          const plain = decrypt(spaceKey, i);
          const enc = C.encryptItem(
            newKey,
            {
              vaultId: spaceVaultId,
              itemId: i.id,
              revision: i.revision + 1,
              keyVersion,
              type: i.type,
            },
            plain,
          );
          return { id: i.id, revision: i.revision + 1, ...enc };
        }),
        revisions: data.revisions.map((r) => ({
          itemId: r.itemId,
          revision: r.revision,
          itemKeyWrapped: C.rewrapItemKey(
            spaceKey,
            newKey,
            {
              vaultId: spaceVaultId,
              itemId: r.itemId,
              revision: r.revision,
              oldKeyVersion: r.keyVersion,
              newKeyVersion: keyVersion,
            },
            r.itemKeyWrapped,
          ),
        })),
      };
      expect(payload.revisions).toHaveLength(1);

      // Incomplete or stale payloads are refused as a whole.
      const missing = await apiError(
        owner.c.api.call('vaultRotate', {
          params: { vaultId: spaceVaultId },
          body: { ...payload, items: payload.items.slice(1) },
        }),
      );
      expect(missing.code).toBe('vault_rotation_incomplete');
      const skip = await apiError(
        owner.c.api.call('vaultRotate', {
          params: { vaultId: spaceVaultId },
          body: { ...payload, keyVersion: 3 },
        }),
      );
      expect(skip.code).toBe('vault_key_version_mismatch');
      const keepSelin = await apiError(
        owner.c.api.call('vaultRotate', {
          params: { vaultId: spaceVaultId },
          body: { ...payload, removeUserIds: [] },
        }),
      );
      expect(keepSelin.code).toBe('vault_rotation_incomplete');
      // A rotation leaves no revision behind, and says which one it missed.
      const noRevision = await apiError(
        owner.c.api.call('vaultRotate', {
          params: { vaultId: spaceVaultId },
          body: { ...payload, revisions: [] },
        }),
      );
      expect(noRevision.code).toBe('vault_rotation_incomplete');
      expect(noRevision.details).toMatchObject({
        missingRevisions: 1,
        revisions: [
          { itemId: payload.revisions[0]!.itemId, revision: payload.revisions[0]!.revision },
        ],
      });
      // Only those who may purge delete a revision.
      const notAllowed = await apiError(
        can.c.api.call('vaultDeleteItemRevision', {
          params: {
            itemId: payload.revisions[0]!.itemId,
            revision: String(payload.revisions[0]!.revision),
          },
        }),
      );
      expect(notAllowed.code).toBe('forbidden');
      // Whoever rotates knows the new key, so a manager cannot rotate themselves out, even with
      // a complete payload and another manager left. Nothing changes.
      const selfOut = await apiError(
        owner.c.api.call('vaultRotate', {
          params: { vaultId: spaceVaultId },
          body: {
            ...payload,
            removeUserIds: [owner.userId],
            members: data.members
              .filter((m) => m.user.id !== owner.userId)
              .map((m) => ({
                userId: m.user.id,
                wrappedKey: C.wrapVaultKey(newKey, m.publicKey, {
                  vaultId: spaceVaultId,
                  keyVersion,
                  userId: m.user.id,
                }),
              })),
          },
        }),
      );
      expect(selfOut.code).toBe('vault_cannot_remove_self');

      const rotated = await owner.c.api.call('vaultRotate', {
        params: { vaultId: spaceVaultId },
        body: payload,
      });
      expect(rotated).toMatchObject({ keyVersion: 2, memberCount: 3 });
      spaceKey = newKey;

      // Selin is out: no vault, no items, and her old key opens none of the new ciphertexts.
      expect((await selin.c.raw('GET', `/api/v1/vault/vaults/${spaceVaultId}`)).status).toBe(404);
      expect((await selin.c.raw('GET', `/api/v1/vault/vaults/${spaceVaultId}/items`)).status).toBe(
        404,
      );
      const after = await mert.c.api.call('vaultItems', { params: { vaultId: spaceVaultId } });
      for (const i of after.items) {
        expect(() => decrypt(selinOldKey, i)).toThrow(C.CryptoError);
        expect(i.keyVersion).toBe(2);
      }
      // Remaining members open the new key and every item, and history still decrypts.
      for (const p of [owner, mert, can]) {
        const k = await openVaultKey(p, spaceVaultId);
        expect(after.items.map((i) => decrypt(k, i).name).sort()).toEqual([
          'PostgreSQL prod',
          'milva-01 root SSH key',
        ]);
      }
      const history = await owner.c.api.call('vaultItemRevisions', {
        params: { itemId: first.id },
      });
      expect(
        C.decryptItem(
          newKey,
          { vaultId: spaceVaultId, itemId: first.id, revision: 1, keyVersion: 2, type: first.type },
          history.items[0]!,
        ).name,
      ).toBe(
        decrypt(
          newKey,
          after.items.find((i) => i.id === first.id)!,
        ).name,
      );
    });

    it('rotation data is one moment: never old items with the key of a newer rotation', async () => {
      const vaultId = C.newId();
      const key = C.newVaultKey();
      await owner.c.api.call('vaultCreate', {
        body: {
          id: vaultId,
          spaceId: altyapiId,
          name: 'Eşzamanlı',
          wrappedKey: C.wrapVaultKey(key, owner.publicKey, {
            vaultId,
            keyVersion: 1,
            userId: owner.userId,
          }),
        },
      });
      await owner.c.api.call('vaultCreateItem', {
        params: { vaultId },
        body: encrypt(key, vaultId, C.emptyItem('login', 'Eşzamanlı giriş'), {}),
      });
      const before = await owner.c.api.call('vaultRotationData', { params: { vaultId } });
      const newKey = C.newVaultKey();
      const rotation = {
        keyVersion: 2,
        removeUserIds: [],
        members: before.members.map((m) => ({
          userId: m.user.id,
          wrappedKey: C.wrapVaultKey(newKey, m.publicKey, {
            vaultId,
            keyVersion: 2,
            userId: m.user.id,
          }),
        })),
        items: before.items.map((i) => ({
          id: i.id,
          revision: i.revision + 1,
          ...C.encryptItem(
            newKey,
            { vaultId, itemId: i.id, revision: i.revision + 1, keyVersion: 2, type: i.type },
            decrypt(key, i),
          ),
        })),
        revisions: [],
      };

      // A device's read stops right after the items, another device's rotation commits, and only
      // then does the read go on to the vault and its key.
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reachedRevisions = () => {};
      const reached = new Promise<void>((resolve) => (reachedRevisions = resolve));
      let armed = true;
      const query = pg.Client.prototype.query as (...args: unknown[]) => unknown;
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
        this: pg.Client,
        ...args: unknown[]
      ) {
        const first = args[0] as string | { text?: string };
        const text = typeof first === 'string' ? first : (first?.text ?? '');
        if (armed && /from "vault_item_revisions"/.test(text)) {
          armed = false;
          reachedRevisions();
          return gate.then(() => query.apply(this, args));
        }
        return query.apply(this, args);
      } as never);
      try {
        const reading = owner.c.api.call('vaultRotationData', { params: { vaultId } });
        await reached;
        await owner.c.api.call('vaultRotate', { params: { vaultId }, body: rotation });
        release();
        const seen = await reading;

        // All from before the rotation, so it opens, and the server refuses a rotation built on it.
        expect(seen.vault.keyVersion).toBe(1);
        expect(seen.items.map((i) => i.keyVersion)).toEqual([1]);
        const opened = C.unwrapVaultKey(owner.privateKey, seen.vault.myWrappedKey, {
          vaultId,
          keyVersion: seen.vault.keyVersion,
          userId: owner.userId,
        });
        expect(decrypt(opened, seen.items[0]!).name).toBe('Eşzamanlı giriş');
        const stale = await apiError(
          owner.c.api.call('vaultRotate', { params: { vaultId }, body: rotation }),
        );
        expect(stale.code).toBe('vault_key_version_mismatch');
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('moves an item between vaults with its re-encryption', async () => {
      const src = encrypt(owner.personalKey, owner.personalId, {
        v: 1,
        type: 'api_key',
        name: secret('NuGet API key taşınacak'),
        key: secret('oy2k-nuget-secret-token-998'),
      });
      await owner.c.api.call('vaultCreateItem', {
        params: { vaultId: owner.personalId },
        body: src,
      });
      const plain = decrypt(owner.personalKey, { ...src, vaultId: owner.personalId, revision: 1 });
      const moved = encrypt(spaceKey, spaceVaultId, plain, { keyVersion: 2 });
      const created = await owner.c.api.call('vaultMoveItem', {
        params: { itemId: src.id },
        body: { targetVaultId: spaceVaultId, item: moved },
      });
      expect(created).toMatchObject({ id: moved.id, vaultId: spaceVaultId, revision: 1 });
      expect((await owner.c.raw('GET', `/api/v1/vault/items/${src.id}`)).status).toBe(404);
      expect(decrypt(spaceKey, created).name).toBe('NuGet API key taşınacak');
    });
  });

  describe('attachments', () => {
    it('stores encrypted bytes only and serves them back', async () => {
      const content = new TextEncoder().encode(secret('attachment-plaintext-content-🔒-güneş'));
      const attachmentId = C.newId();
      const fileKey = C.newFileKey();
      const encrypted = C.encryptAttachment(fileKey, attachmentId, content);
      const up = await owner.c.api.call('vaultCreateAttachment', {
        params: { itemId: dockerId },
        body: { id: attachmentId, size: encrypted.length },
      });
      const parts: { partNumber: number; etag: string }[] = [];
      for (const p of up.parts) {
        const body = encrypted.subarray(
          (p.partNumber - 1) * up.partSize,
          p.partNumber * up.partSize,
        );
        const res = await fetch(p.url, { method: 'PUT', body });
        expect(res.ok).toBe(true);
        parts.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' });
      }
      const done = await owner.c.api.call('vaultCompleteAttachment', {
        params: { itemId: dockerId, attachmentId },
        body: { parts },
      });
      expect(done).toMatchObject({ id: attachmentId, size: encrypted.length });
      const item = await owner.c.api.call('vaultGetItem', { params: { itemId: dockerId } });
      expect(item.attachments.map((a) => a.id)).toEqual([attachmentId]);
      const { url } = await owner.c.api.call('vaultAttachmentUrl', {
        params: { itemId: dockerId, attachmentId },
      });
      const back = new Uint8Array(await (await fetch(url)).arrayBuffer());
      expect(new TextDecoder().decode(C.decryptAttachment(fileKey, attachmentId, back))).toBe(
        'attachment-plaintext-content-🔒-güneş',
      );
      const [blob] = (
        await app.deps.db.execute(
          sql`select b.encrypted, b.sha256, b.ref_count from blobs b join vault_attachments a on a.blob_id = b.id where a.id = ${attachmentId}`,
        )
      ).rows as [{ encrypted: boolean; sha256: string | null; ref_count: number }];
      expect(blob).toEqual({ encrypted: true, sha256: null, ref_count: 1 });
      // The nightly quota.reconcile keeps counting the attachment against its space.
      const usedOf = async () =>
        (
          (
            await app.deps.db.execute(
              sql`select s.used_bytes::bigint as used from spaces s join vault_attachments a on a.space_id = s.id where a.id = ${attachmentId}`,
            )
          ).rows as [{ used: string }]
        )[0].used;
      const before = await usedOf();
      expect(Number(before)).toBeGreaterThanOrEqual(encrypted.length);
      await reconcileSpaceBytes(app.deps.db);
      expect(await usedOf()).toBe(before);
      // Others cannot fetch it.
      expect(
        (await mert.c.raw('GET', `/api/v1/vault/items/${dockerId}/attachments/${attachmentId}/url`))
          .status,
      ).toBe(404);
    });

    it('refuses attachments over 100 MB', async () => {
      const res = await owner.c.raw('POST', `/api/v1/vault/items/${dockerId}/attachments`, {
        id: C.newId(),
        size: 200 * 1024 * 1024,
      });
      expect(res.status).toBe(422);
    });
  });

  describe('Bitwarden import', () => {
    it('imports every item in one transaction, keeping the dates', async () => {
      const fixture = readFileSync(
        new URL('../../../packages/crypto/test/fixtures/bitwarden.json', import.meta.url),
        'utf8',
      );
      const parsed = await C.parseBitwardenExport(fixture);
      for (const i of parsed.items) {
        const p = i.payload as Record<string, unknown>;
        for (const k of ['password', 'notes', 'number', 'privateKey', 'totp'] as const) {
          if (typeof p[k] === 'string' && (p[k] as string).length >= 8) secret(p[k] as string);
        }
      }
      const items = parsed.items.map((i) => ({
        ...encrypt(
          i.group.startsWith('collection') ? spaceKey : owner.personalKey,
          i.group.startsWith('collection') ? spaceVaultId : owner.personalId,
          i.apiKeyLike ? C.noteToApiKey(i.payload) : i.payload,
          { keyVersion: i.group.startsWith('collection') ? 2 : 1 },
        ),
        vaultId: i.group.startsWith('collection') ? spaceVaultId : owner.personalId,
        ...(i.createdAt ? { createdAt: i.createdAt } : {}),
        ...(i.updatedAt ? { updatedAt: i.updatedAt } : {}),
      }));
      // A bad entry (stale key version) fails the whole import: nothing is written.
      const bad = await apiError(
        owner.c.api.call('vaultImport', {
          body: { items: [...items, { ...items[0]!, id: C.newId(), keyVersion: 9 }] },
        }),
      );
      expect(bad.code, JSON.stringify(bad.details)).toBe('vault_key_version_mismatch');
      const countBefore = (
        await owner.c.api.call('vaultGet', { params: { vaultId: owner.personalId } })
      ).itemCount;

      const res = await owner.c.api.call('vaultImport', { body: { items } });
      expect(res.imported).toBe(6);
      expect(res.byVault.find((v) => v.vaultId === spaceVaultId)?.count).toBe(1);
      expect(
        (await owner.c.api.call('vaultGet', { params: { vaultId: owner.personalId } })).itemCount,
      ).toBe(countBefore + 5);

      const page = await owner.c.api.call('vaultItems', { params: { vaultId: owner.personalId } });
      const docker = page.items
        .map((i) => ({ i, p: decrypt(owner.personalKey, i) }))
        .find((x) => x.p.name === 'Docker Hub' && x.p.importedFrom === 'bitwarden')!;
      expect(docker.p).toMatchObject({
        type: 'login',
        username: 'crewhall',
        password: 'T7#qWm2!vR9pLx4$Kd8z',
      });
      expect(docker.i.createdAt).toBe('2025-01-10T08:30:00.000Z');
      const seq = (
        await owner.c.api.call('vaultItems', { params: { vaultId: spaceVaultId } })
      ).items.find((i) => i.type === 'api_key' && decrypt(spaceKey, i).name === 'Seq API key');
      expect(seq && decrypt(spaceKey, seq)).toMatchObject({ key: 'seq_9fJ2kLm3QzX7' });
    });
  });

  describe('access log', () => {
    it('records client and server events; managers read their vaults', async () => {
      await can.c.api.call('vaultReportEvents', {
        body: {
          events: [
            {
              vaultId: spaceVaultId,
              itemId: (await can.c.api.call('vaultItems', { params: { vaultId: spaceVaultId } }))
                .items[0]!.id,
              action: 'copy',
              field: 'password',
            },
          ],
        },
      });
      const log = await owner.c.api.call('vaultEvents', { query: { vaultId: spaceVaultId } });
      const actions = log.items.map((e) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'item.copy',
          'vault.rotate',
          'member.revoke',
          'member.grant',
          'item.create',
          'import',
        ]),
      );
      const copy = log.items.find((e) => e.action === 'item.copy')!;
      expect(copy).toMatchObject({ field: 'password', actor: { id: can.userId } });
      expect(log.items.find((e) => e.action === 'member.revoke')?.targetUser?.id).toBe(
        selin.userId,
      );
      // Not a manager: no log.
      expect(
        (await apiError(can.c.api.call('vaultEvents', { query: { vaultId: spaceVaultId } }))).code,
      ).toBe('forbidden');
      // Own unlock events, including failures, are visible to the person.
      const mine = await can.c.api.call('vaultEvents', { query: { action: 'unlock_failed' } });
      expect(mine.items.length).toBeGreaterThanOrEqual(5);
      // Reported events must point at a real item of that vault.
      expect(
        (
          await can.c.raw('POST', '/api/v1/vault/events', {
            events: [
              { vaultId: spaceVaultId, itemId: dockerId, action: 'reveal', field: 'password' },
            ],
          })
        ).status,
      ).toBe(404);
    });

    it('paginates with a cursor', async () => {
      const first = await owner.c.api.call('vaultEvents', { query: { limit: 3 } });
      expect(first.items).toHaveLength(3);
      const second = await owner.c.api.call('vaultEvents', {
        query: { limit: 3, cursor: first.nextCursor! },
      });
      expect(Number(second.items[0]!.id)).toBeLessThan(Number(first.items[2]!.id));
    });
  });

  describe('deleted spaces', () => {
    it('hides a space vault while its space is in the trash and brings it back on restore', async () => {
      await owner.c.raw('DELETE', `/api/v1/spaces/${altyapiId}`);
      expect((await mert.c.raw('GET', `/api/v1/vault/vaults/${spaceVaultId}`)).status).toBe(404);
      expect((await mert.c.api.call('vaultList')).items.map((v) => v.id)).not.toContain(
        spaceVaultId,
      );
      const restored = await owner.c.raw('POST', `/api/v1/spaces/${altyapiId}/restore`);
      expect(restored.status).toBeLessThan(300);
      const back = await mert.c.api.call('vaultGet', { params: { vaultId: spaceVaultId } });
      expect(back.itemCount).toBeGreaterThan(0);
    });
  });

  describe('housekeeping', () => {
    it('leaves vault data alone while the org has the vault module switched off', async () => {
      const body = encrypt(owner.personalKey, owner.personalId, { v: 1, type: 'note', name: 'x' });
      await owner.c.api.call('vaultCreateItem', { params: { vaultId: owner.personalId }, body });
      await owner.c.api.call('vaultTrashItem', { params: { itemId: body.id } });
      await app.deps.db.execute(
        sql`update vault_items set deleted_at = now() - interval '31 days' where id = ${body.id}`,
      );
      await app.deps.db.execute(
        sql`update organizations set settings = jsonb_set(settings, '{modules}', '{"vault": false}')`,
      );
      await purgeVault(app.deps.db);
      const [{ n }] = (
        await app.deps.db.execute(
          sql`select count(*)::int as n from vault_items where id = ${body.id}`,
        )
      ).rows as [{ n: number }];
      expect(n).toBe(1);
      await app.deps.db.execute(sql`update organizations set settings = settings - 'modules'`);
      await purgeVault(app.deps.db);
      expect((await owner.c.raw('GET', `/api/v1/vault/items/${body.id}`)).status).toBe(404);
    });

    it('purges trash after 30 days with its encrypted blobs, and year-old log rows', async () => {
      const body = encrypt(owner.personalKey, owner.personalId, {
        v: 1,
        type: 'note',
        name: secret('Eski çöp notu 2025'),
      });
      await owner.c.api.call('vaultCreateItem', { params: { vaultId: owner.personalId }, body });
      await owner.c.api.call('vaultTrashItem', { params: { itemId: body.id } });
      await app.deps.db.execute(
        sql`update vault_items set deleted_at = now() - interval '31 days' where id = ${body.id}`,
      );
      await app.deps.db.execute(
        sql`update vault_events set at = now() - interval '400 days' where item_id = ${body.id}`,
      );
      await purgeVault(app.deps.db);
      expect((await owner.c.raw('GET', `/api/v1/vault/items/${body.id}`)).status).toBe(404);
      const [{ n }] = (
        await app.deps.db.execute(
          sql`select count(*)::int as n from vault_events where item_id = ${body.id}`,
        )
      ).rows as [{ n: number }];
      expect(n).toBe(0);
    });
  });

  describe('zero knowledge', () => {
    it('no plaintext secret appears anywhere in a dump of the database', async () => {
      expect(SECRETS.size).toBeGreaterThan(20);
      const tables = (
        await app.deps.db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)
      ).rows.map((r) => (r as { tablename: string }).tablename);
      let dump = '';
      for (const t of tables) {
        const rows = await app.deps.db.execute(sql.raw(`select t::text as row from "${t}" t`));
        for (const r of rows.rows) dump += `${(r as { row: string }).row}\n`;
      }
      // bytea columns dump as \x hex: decode every hex run so secrets inside raw bytes count too.
      const decode = (enc: BufferEncoding) =>
        dump.replace(/\\+x([0-9a-f]+)/g, (_, hex: string) => Buffer.from(hex, 'hex').toString(enc));
      const decoded = decode('latin1');
      const decodedUtf8 = decode('utf8');
      expect(dump.length).toBeGreaterThan(10_000);
      // The decoding must actually see the bytea columns (ciphertext, wrapped keys).
      expect(dump).toMatch(/\\+x[0-9a-f]{64}/);
      expect(decoded).not.toBe(dump);
      expect(dump).toContain('item.copy');
      for (const s of SECRETS) {
        const forms = [s, Buffer.from(s).toString('base64'), Buffer.from(s).toString('hex')];
        for (const f of forms) {
          expect(dump.includes(f), `secret in dump: ${s.slice(0, 12)}…`).toBe(false);
          expect(
            decoded.includes(f) || decodedUtf8.includes(f),
            `secret in bytea: ${s.slice(0, 12)}…`,
          ).toBe(false);
        }
      }
      // Verifiers are stored hashed only.
      const [{ n }] = (
        await app.deps.db.execute(
          sql`select count(*)::int as n from user_keys where length(password_verifier_hash) = 32 and length(recovery_verifier_hash) = 32`,
        )
      ).rows as [{ n: number }];
      expect(n).toBe(4);
    });

    it('the server never imports @crewhall/crypto', () => {
      const src = new URL('../src/', import.meta.url);
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = joinPath(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.ts')) files.push(p);
        }
      };
      walk(src.pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      expect(files.length).toBeGreaterThan(20);
      for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@crewhall\/crypto/);
    });

    it('every vault table carries org_id, except the per-person key tables', async () => {
      const cols = (
        await app.deps.db.execute(
          sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id' and (table_name like 'vault_%' or table_name like 'user_key%')`,
        )
      ).rows.map((r) => (r as { table_name: string }).table_name);
      expect(cols.sort()).toEqual([
        'vault_attachments',
        'vault_events',
        'vault_item_revisions',
        'vault_items',
        'vault_members',
        'vault_policies',
        'vault_shares',
        'vault_vaults',
      ]);
    });
  });
});
