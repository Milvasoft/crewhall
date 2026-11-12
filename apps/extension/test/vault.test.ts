import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '@crewhall/api-client';
import {
  createAccountKeys,
  decryptItem,
  encryptItem,
  ItemPayload,
  newId,
  newVaultKey,
  passwordUnlockMaterial,
  toB64,
  wrapVaultKey,
  type ItemType,
} from '@crewhall/crypto';
import { CaptureService } from '../src/background/capture';
import { VaultService, type KeyValue } from '../src/background/vault';
import { DEFAULT_SETTINGS } from '../src/shared/storage';

const USER = '0190f0a0-0000-7000-8000-000000000065';
const PASSWORD = 'deneme-kasa-sifresi-92';
const SITE = 'https://example.com/login';

function memory(): KeyValue & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
    keys: async () => [...data.keys()],
  };
}

interface Row {
  id: string;
  vaultId: string;
  type: string;
  revision: number;
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  itemKeyWrapped: string;
  deletedAt: string | null;
}

async function world() {
  const setup = await createAccountKeys({
    userId: USER,
    password: PASSWORD,
    kdf: { m: 32768, t: 2, p: 1 },
  });
  const material = await passwordUnlockMaterial(PASSWORD, setup.upload.kdf);
  const vaultId = newId();
  const vaultKey = newVaultKey();
  const vault = {
    id: vaultId,
    kind: 'personal',
    name: null,
    keyVersion: 1,
    myWrappedKey: wrapVaultKey(vaultKey, setup.publicKey, { vaultId, keyVersion: 1, userId: USER }),
    canEdit: true,
  };
  const rows: Row[] = [];
  const seal = (id: string, revision: number, payload: ItemPayload): Row => ({
    id,
    vaultId,
    type: payload.type,
    revision,
    keyVersion: 1,
    deletedAt: null,
    ...encryptItem(
      vaultKey,
      { vaultId, itemId: id, revision, keyVersion: 1, type: payload.type },
      payload,
    ),
  });
  const addLogin = (fields: Partial<Record<'name' | 'username' | 'password' | 'totp', string>> & { uris: string[] }) => {
    const row = seal(newId(), 1, ItemPayload.parse({ v: 1, type: 'login', name: 'Site', ...fields }));
    rows.push(row);
    return row;
  };
  const open = (r: Row) =>
    decryptItem(
      vaultKey,
      { vaultId, itemId: r.id, revision: r.revision, keyVersion: 1, type: r.type as ItemType },
      r,
    );
  const reported: unknown[] = [];
  const call = vi.fn(async (name: string, args?: { body?: Record<string, unknown>; params?: Record<string, string> }) => {
    switch (name) {
      case 'vaultKeys':
        return { setUp: true, kdf: setup.upload.kdf };
      case 'vaultUnlock':
        if (args?.body?.verifier !== toB64(material.verifier)) {
          throw Object.assign(new Error('wrong'), { code: 'vault_unlock_failed' });
        }
        return {
          method: 'password',
          publicKey: setup.upload.publicKey,
          wrappedPrivateKey: setup.upload.encryptedPrivateKey,
          keyVersion: 1,
          settings: null,
        };
      case 'vaultList':
        return { items: [vault] };
      case 'vaultItems':
        return { items: rows, nextCursor: null };
      case 'vaultCreateItem':
        rows.push({ ...(args!.body as unknown as Row), vaultId, revision: 1, deletedAt: null });
        return {};
      case 'vaultUpdateItem': {
        const i = rows.findIndex((r) => r.id === args!.params!.itemId);
        rows[i] = { ...rows[i]!, ...(args!.body as unknown as Row) };
        return {};
      }
      case 'vaultReportEvents':
        reported.push(args!.body);
        return {};
      default:
        throw new Error(`unexpected ${name}`);
    }
  });
  let clock = 1_800_000_000_000;
  const session = memory();
  const service = new VaultService({
    api: async () => ({ call }) as unknown as ApiClient,
    userId: async () => USER,
    session,
    now: () => clock,
  });
  return {
    service,
    session,
    call,
    rows,
    open,
    seal,
    addLogin,
    reported,
    advance: (ms: number) => (clock += ms),
  };
}

describe('VaultService', () => {
  it('opens with the right password only and keeps the key out of disk storage shape', async () => {
    const w = await world();
    await expect(w.service.unlock('yanlis')).rejects.toMatchObject({ code: 'vault_unlock_failed' });
    expect(await w.service.isUnlocked()).toBe(false);
    await w.service.unlock(PASSWORD);
    expect(await w.service.isUnlocked()).toBe(true);
    expect(JSON.stringify([...w.session.data.values()])).not.toContain(PASSWORD);
  });

  it('lists decrypted logins with the ones for this page first, without secrets', async () => {
    const w = await world();
    w.addLogin({ name: 'Başka', username: 'x', password: 'p1', uris: ['https://other.test'] });
    const match = w.addLogin({ name: 'Örnek', username: 'ada', password: 'p2', uris: [SITE] });
    await w.service.unlock(PASSWORD);
    const list = await w.service.list(SITE);
    expect(list.map((e) => e.name)).toEqual(['Örnek', 'Başka']);
    expect(list[0]).toMatchObject({ id: match.id, matches: true, username: 'ada', host: 'example.com' });
    expect(JSON.stringify(list)).not.toContain('p2');
  });

  it('gives the payload for filling and reports the field, not the value', async () => {
    const w = await world();
    const row = w.addLogin({ username: 'ada', password: 'gizli', uris: [SITE] });
    await w.service.unlock(PASSWORD);
    const { payload, vaultId } = await w.service.login(row.id);
    expect(payload.password).toBe('gizli');
    await w.service.report(row.id, vaultId, 'password');
    expect(JSON.stringify(w.reported)).toContain('"field":"password"');
    expect(JSON.stringify(w.reported)).not.toContain('gizli');
  });

  it('makes a TOTP code', async () => {
    const w = await world();
    const row = w.addLogin({ password: 'x', totp: 'JBSWY3DPEHPK3PXP', uris: [SITE] });
    await w.service.unlock(PASSWORD);
    const { code, period } = await w.service.totp(row.id);
    expect(code).toMatch(/^\d{6}$/);
    expect(period).toBe(30);

    // A code ticking on screen does not keep the vault open.
    w.advance(11 * 60_000);
    await expect(w.service.totp(row.id)).rejects.toMatchObject({ code: 'vault_locked' });
  });

  it('creates a login that decrypts on the other side', async () => {
    const w = await world();
    await w.service.unlock(PASSWORD);
    const [vault] = await w.service.editableVaults();
    await w.service.createLogin(vault!.id, { name: 'yeni', username: 'ada', password: 'yeni-sifre', url: SITE });
    expect(w.open(w.rows[0]!)).toMatchObject({ type: 'login', name: 'yeni', password: 'yeni-sifre', uris: [SITE] });
    expect(JSON.stringify(w.call.mock.calls.at(-1))).not.toContain('yeni-sifre');
  });

  it('changes a password and keeps the old one in the history', async () => {
    const w = await world();
    const row = w.addLogin({ username: 'ada', password: 'eski', uris: [SITE] });
    await w.service.unlock(PASSWORD);
    await w.service.updatePassword(row.id, 'yeni');
    expect(w.rows[0]!.revision).toBe(2);
    const payload = w.open(w.rows[0]!);
    expect(payload).toMatchObject({ password: 'yeni' });
    expect(payload.passwordHistory[0]).toMatchObject({ password: 'eski' });
  });

  it('locks after being left alone and when asked', async () => {
    const w = await world();
    w.addLogin({ password: 'x', uris: [SITE] });
    await w.service.unlock(PASSWORD);
    w.advance(9 * 60_000);
    await w.service.list(null); // Use keeps it open.
    w.advance(9 * 60_000);
    expect(await w.service.isUnlocked()).toBe(true);
    w.advance(2 * 60_000);
    await w.service.expire();
    expect(w.session.data.size).toBe(0);
    await expect(w.service.list(null)).rejects.toMatchObject({ code: 'vault_locked' });

    await w.service.unlock(PASSWORD);
    await w.service.lock();
    expect(w.session.data.size).toBe(0);
  });

  it('refuses an older copy of an item and anything that fails authentication', async () => {
    const w = await world();
    const row = w.addLogin({ name: 'Yeni hali', password: 'v2', uris: [SITE] });
    const updated = w.seal(row.id, 5, ItemPayload.parse({ v: 1, type: 'login', name: 'Son', password: 'v5', uris: [SITE] }));
    w.rows[0] = updated;
    await w.service.unlock(PASSWORD);
    expect((await w.service.list(SITE)).map((e) => e.name)).toEqual(['Son']);

    // The server hands back revision 1 later on.
    w.rows[0] = row;
    w.advance(20_000);
    expect(await w.service.list(SITE)).toEqual([]);

    w.rows[0] = { ...updated, ciphertext: toB64(new Uint8Array(64)) };
    w.advance(20_000);
    expect(await w.service.list(SITE)).toEqual([]);
  });

  it('leaves trashed items out', async () => {
    const w = await world();
    const row = w.addLogin({ password: 'x', uris: [SITE] });
    w.rows[0] = { ...row, deletedAt: new Date().toISOString() };
    await w.service.unlock(PASSWORD);
    expect(await w.service.list(SITE)).toEqual([]);
  });
});

describe('CaptureService', () => {
  const local = new Map<string, unknown>();

  beforeEach(() => {
    local.clear();
    local.set('settings', { ...DEFAULT_SETTINGS, vault: true });
    local.set('connection', { origin: 'https://crewhall.test', token: 't', userId: USER });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: async (k: string) => (local.has(k) ? { [k]: local.get(k) } : {}),
          set: async (o: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(o)) local.set(k, v);
          },
          remove: async (k: string) => void local.delete(k),
        },
      },
    });
  });

  async function setup() {
    const w = await world();
    await w.service.unlock(PASSWORD);
    return { ...w, capture: new CaptureService(w.service, w.session, () => 1_800_000_000_000) };
  }

  it('offers to save a new sign-in without giving the prompt the password', async () => {
    const w = await setup();
    await w.capture.submitted(1, SITE, 'ada', 'yeni-sifre');
    const prompt = await w.capture.prompt(1);
    expect(prompt).toMatchObject({ mode: 'new', host: 'example.com', username: 'ada' });
    expect(JSON.stringify(prompt)).not.toContain('yeni-sifre');
    await w.capture.save(1, prompt!.id);
    expect(w.open(w.rows[0]!)).toMatchObject({ username: 'ada', password: 'yeni-sifre', uris: ['https://example.com'] });
    expect(await w.capture.prompt(1)).toBeNull();
  });

  it('says nothing when the vault already has it', async () => {
    const w = await setup();
    w.addLogin({ username: 'ada', password: 'ayni', uris: [SITE] });
    await w.capture.submitted(1, SITE, 'ada', 'ayni');
    expect(await w.capture.prompt(1)).toBeNull();
  });

  it('offers an update when the password changed', async () => {
    const w = await setup();
    w.addLogin({ name: 'Örnek', username: 'ada', password: 'eski', uris: [SITE] });
    await w.capture.submitted(1, SITE, 'ada', 'yeni');
    const prompt = await w.capture.prompt(1);
    expect(prompt).toMatchObject({ mode: 'update', itemName: 'Örnek' });
    await w.capture.save(1, prompt!.id);
    expect(w.open(w.rows[0]!)).toMatchObject({ password: 'yeni' });
  });

  it('saves only what the person was shown', async () => {
    const w = await setup();
    await w.capture.submitted(1, SITE, 'ada', 'gorulen');
    const shown = await w.capture.prompt(1);
    await w.capture.submitted(1, SITE, 'kurban', 'sonradan-konan');
    await expect(w.capture.save(1, shown!.id)).rejects.toMatchObject({ code: 'capture_expired' });
    expect(w.rows).toHaveLength(0);
  });

  it('drops what was typed when the vault locks and when five minutes pass', async () => {
    const w = await setup();
    await w.capture.submitted(1, SITE, 'ada', 'x');
    await w.capture.clear();
    expect(await w.capture.prompt(1)).toBeNull();

    let now = 1_800_000_000_000;
    const timed = new CaptureService(w.service, w.session, () => now);
    await timed.submitted(2, SITE, 'ada', 'y');
    now += 6 * 60_000;
    await timed.sweep();
    expect([...w.session.data.keys()].filter((k) => k.startsWith('capture.'))).toEqual([]);
  });

  it("never takes anything typed on Crewhall's own pages", async () => {
    const w = await setup();
    await w.capture.submitted(1, 'https://crewhall.test/vault', '', 'kasa-sifresi');
    expect([...w.session.data.keys()].filter((k) => k.startsWith('capture.'))).toEqual([]);
  });

  it('respects "never" and the switches', async () => {
    const w = await setup();
    await w.capture.submitted(1, SITE, 'ada', 'x1');
    await w.capture.dismiss(1, true);
    await w.capture.submitted(1, SITE, 'ada', 'x2');
    expect(await w.capture.prompt(1)).toBeNull();

    local.set('settings', { ...DEFAULT_SETTINGS, vault: true, capture: false });
    await w.capture.submitted(2, 'https://other.test/', 'ada', 'x3');
    expect(await w.capture.prompt(2)).toBeNull();
  });

  it('asks to open the vault when locked and forgets after five minutes', async () => {
    const w = await setup();
    await w.capture.submitted(1, SITE, 'ada', 'x');
    await w.service.lock();
    expect(await w.capture.prompt(1)).toMatchObject({ mode: 'locked', vaults: [] });

    let now = 1_800_000_000_000;
    const later = new CaptureService(w.service, w.session, () => now);
    now += 6 * 60_000;
    expect(await later.prompt(1)).toBeNull();
  });
});
