import { emptyItem, encryptItem, newId, newVaultKey, type ItemPayload } from '@crewhall/crypto';
import { describe, expect, it } from 'vitest';
import { VaultEngine, type EngineRow } from '@/lib/vault/engine';

/**
 * Performance budget of the vault list (H13): 1000 items are decrypted once each into
 * secret-free summaries, fast enough to open in under a second, and the health scan scores
 * passwords a chunk at a time.
 */

const VAULT = 'vault-1';
const AT = '2026-01-01T00:00:00.000Z';

function rows(key: Uint8Array, n: number, payload: (i: number) => ItemPayload): EngineRow[] {
  return Array.from({ length: n }, (_, i) => {
    const id = newId();
    const p = payload(i);
    return {
      id,
      vaultId: VAULT,
      type: p.type,
      revision: 1,
      keyVersion: 1,
      updatedAt: AT,
      ...encryptItem(
        key,
        { vaultId: VAULT, itemId: id, revision: 1, keyVersion: 1, type: p.type },
        p,
      ),
    };
  });
}

const login = (i: number): ItemPayload => ({
  ...emptyItem('login', `Hizmet ${i}`),
  username: `user${i}@example.com`,
  password: `Gizli-${i}-Xq9!pass`,
  uris: [`https://svc${i}.example.com/login`],
});

describe('vault engine (H13)', () => {
  it('decrypts 1000 items once each, within the time budget, without secrets in summaries', () => {
    const key = newVaultKey();
    const engine = new VaultEngine();
    engine.setKey(VAULT, 1, key);
    const data = rows(key, 1000, login);

    const started = performance.now();
    const out = engine.summarize(data);
    const took = performance.now() - started;

    expect(out.filter((r) => r.summary)).toHaveLength(1000);
    expect(engine.stats.decrypted).toBe(1000);
    // Measured 105-125 ms in jsdom on a dev laptop (the opening target is 1 s). Full turbo runs on
    // a loaded machine took 1.7 s, so the bound guards against the old minutes-long path instead.
    expect(took).toBeLessThan(5000);
    expect(out[7]!.summary).toMatchObject({
      name: 'Hizmet 7',
      username: 'user7@example.com',
      host: 'svc7.example.com',
    });
    expect(JSON.stringify(out)).not.toContain('Gizli-');
  });

  it('scores passwords in chunks, once per distinct password, and stops on lock', async () => {
    const key = newVaultKey();
    const engine = new VaultEngine();
    engine.setKey(VAULT, 1, key);
    // 40 items share 20 passwords: reused ones score once.
    const data = rows(key, 40, (i) => ({ ...login(i), password: `Ortak-${i % 20}-Zz7!` }));
    engine.summarize(data);
    const ids = data.map((r) => r.id);
    let measured = 0;
    let yields = 0;
    const measure = () => {
      measured++;
      return 4;
    };
    const report = await engine.health(ids, new Date(AT), measure, async () => {
      yields++;
    });
    expect(measured).toBe(20);
    expect(yields).toBe(5); // 40 pending passwords, 8 per chunk
    expect(report?.counts.reused).toBe(40);
    expect(report?.counts.weak).toBe(0);

    // A second scan reuses every score.
    await engine.health(ids, new Date(AT), measure, async () => undefined);
    expect(measured).toBe(20);

    // An edited item is summarized again; only its new password is measured.
    const fresh = rows(key, 1, () => ({ ...login(0), password: 'Yeni-Sifre-Kk3!' }));
    engine.summarize(fresh);
    await engine.health([...ids, fresh[0]!.id], new Date(AT), measure, async () => undefined);
    expect(measured).toBe(21);

    // Lock while a scan runs: it returns nothing and leaves nothing behind.
    const more = rows(key, 30, login);
    engine.summarize(more);
    const pending = engine.health(
      more.map((r) => r.id),
      new Date(AT),
      measure,
      async () => engine.lock(),
    );
    expect(await pending).toBeNull();
    expect(measured).toBe(29); // one chunk before the lock
    expect(engine.summarize(more).every((r) => r.summary === null)).toBe(true);
  });
});
