import type { ApiClient } from '@crewhall/api-client';
import {
  decryptItem,
  encryptItem,
  fromB64,
  ItemPayload,
  newId,
  openPrivateKey,
  openSettings,
  parseTotp,
  passwordUnlockMaterial,
  toB64,
  totpAt,
  totpForCopy,
  totpSourceOf,
  unwrapVaultKey,
  wipe,
  type ItemType,
} from '@crewhall/crypto';
import type { Vault, VaultItem } from '@crewhall/shared';
import { hostOf, matchesAny } from '../shared/match';
import { RequestError, type VaultEntry, type VaultState } from '../shared/messages';

/**
 * The vault on this browser (doc 17 §7). Zero knowledge as on web and mobile: the password never
 * leaves the extension and only ciphertext comes from the server. The private key is held in
 * chrome.storage.session, which stays in memory, is gone with the browser and is out of reach of
 * content scripts; the service worker is stopped often, so a variable alone would not last.
 */

export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface VaultDeps {
  api: () => Promise<ApiClient>;
  userId: () => Promise<string>;
  session: KeyValue;
  now?: () => number;
  /** Runs with every lock: what else was waiting in memory goes too. */
  onLock?: () => Promise<void>;
}

interface Held {
  userId: string;
  privateKey: string;
  lastActive: number;
  autoLockMinutes: number;
}

interface Row {
  item: VaultItem;
  vault: Vault;
  payload: ItemPayload;
}

const HELD = 'vault.held';
export const DEFAULT_AUTO_LOCK_MINUTES = 10;
const LIST_TTL_MS = 15_000;
const PASSWORD_HISTORY_LIMIT = 50;

export class VaultService {
  private vaultKeys = new Map<string, { keyVersion: number; key: Uint8Array }>();
  private cache: { at: number; rows: Row[] } | null = null;
  /** Highest revision seen per item: an older copy from the server is refused (doc 17 §7). */
  private seen = new Map<string, number>();
  /** Moves with every lock, so work that started before it cannot bring anything back. */
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly deps: VaultDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async held(): Promise<Held | null> {
    const h = (await this.deps.session.get(HELD)) as Held | undefined;
    if (!h) return null;
    if (this.now() - h.lastActive >= h.autoLockMinutes * 60_000) {
      await this.lock();
      return null;
    }
    return h;
  }

  private async require(): Promise<Held> {
    const h = await this.held();
    if (!h) throw new RequestError('vault_locked');
    return h;
  }

  /** Using the vault keeps it open; the alarm in index.ts calls expire() for the idle case. */
  private async touch(h: Held) {
    const generation = this.generation;
    const current = await this.deps.session.get(HELD);
    if (!current || generation !== this.generation) return;
    await this.deps.session.set(HELD, { ...h, lastActive: this.now() });
  }

  private forgetMemory() {
    for (const k of this.vaultKeys.values()) wipe(k.key);
    this.vaultKeys.clear();
    this.cache = null;
  }

  async expire() {
    await this.held();
  }

  async isUnlocked() {
    return (await this.held()) !== null;
  }

  async state(): Promise<VaultState> {
    if (await this.held()) return { setUp: true, unlocked: true };
    const status = await (await this.deps.api()).call('vaultKeys');
    return { setUp: status.setUp, unlocked: false };
  }

  async unlock(password: string): Promise<VaultState> {
    const api = await this.deps.api();
    const status = await api.call('vaultKeys');
    if (!status.kdf) throw new RequestError('vault_not_set_up');
    const material = await passwordUnlockMaterial(password, status.kdf);
    const bundle = await api.call('vaultUnlock', {
      body: { method: 'password', verifier: toB64(material.verifier) },
    });
    const userId = await this.deps.userId();
    const privateKey = openPrivateKey({
      kek: material.kek,
      wrapped: bundle.wrappedPrivateKey,
      userId,
      method: 'password',
      publicKey: bundle.publicKey,
    });
    let autoLockMinutes = DEFAULT_AUTO_LOCK_MINUTES;
    try {
      const opened = openSettings(privateKey, userId, bundle.settings, 0).value as {
        autoLockMinutes?: unknown;
      };
      if (typeof opened.autoLockMinutes === 'number' && opened.autoLockMinutes > 0) {
        autoLockMinutes = opened.autoLockMinutes;
      }
    } catch {
      // Unreadable settings: the default is the safe choice.
    }
    await this.deps.session.set(HELD, {
      userId,
      privateKey: toB64(privateKey),
      lastActive: this.now(),
      autoLockMinutes,
    } satisfies Held);
    wipe(privateKey);
    wipe(material.kek);
    wipe(material.verifier);
    return { setUp: true, unlocked: true };
  }

  async lock(): Promise<VaultState> {
    this.generation++;
    this.forgetMemory();
    await this.deps.session.remove(HELD);
    await this.deps.onLock?.();
    return { setUp: true, unlocked: false };
  }

  private keyOf(h: Held, v: Vault): Uint8Array {
    const known = this.vaultKeys.get(v.id);
    if (known?.keyVersion === v.keyVersion) return known.key;
    if (known) wipe(known.key);
    const privateKey = fromB64(h.privateKey);
    try {
      const key = unwrapVaultKey(privateKey, v.myWrappedKey, {
        vaultId: v.id,
        keyVersion: v.keyVersion,
        userId: h.userId,
      });
      this.vaultKeys.set(v.id, { keyVersion: v.keyVersion, key });
      return key;
    } finally {
      wipe(privateKey);
    }
  }

  private decrypt(h: Held, vault: Vault, item: VaultItem): ItemPayload | null {
    if (item.keyVersion !== vault.keyVersion) return null;
    if ((this.seen.get(item.id) ?? 0) > item.revision) return null;
    try {
      const payload = decryptItem(
        this.keyOf(h, vault),
        {
          vaultId: item.vaultId,
          itemId: item.id,
          revision: item.revision,
          keyVersion: item.keyVersion,
          type: item.type as ItemType,
        },
        item,
      );
      this.seen.set(item.id, item.revision);
      return payload;
    } catch {
      return null; // Fails authentication: it never reaches a page.
    }
  }

  private async rows(h: Held): Promise<Row[]> {
    if (this.cache && this.now() - this.cache.at < LIST_TTL_MS) return this.cache.rows;
    const generation = this.generation;
    const api = await this.deps.api();
    const { items: vaults } = await api.call('vaultList');
    const rows: Row[] = [];
    for (const vault of vaults) {
      let cursor: string | undefined;
      do {
        const page = await api.call('vaultItems', {
          params: { vaultId: vault.id },
          query: { limit: 500, ...(cursor ? { cursor } : {}) },
        });
        for (const item of page.items) {
          if (item.deletedAt !== null) continue;
          const payload = this.decrypt(h, vault, item);
          if (payload) rows.push({ item, vault, payload });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    if (generation !== this.generation) {
      this.forgetMemory();
      throw new RequestError('vault_locked');
    }
    this.cache = { at: this.now(), rows };
    return rows;
  }

  async list(pageUrl: string | null): Promise<VaultEntry[]> {
    const h = await this.require();
    await this.touch(h);
    return (await this.rows(h))
      .map(({ item, vault, payload }): VaultEntry => {
        const login = payload.type === 'login' ? payload : null;
        return {
          id: item.id,
          vaultId: vault.id,
          vaultName: vault.name,
          type: payload.type,
          name: payload.name,
          username: login?.username ?? '',
          host: login?.uris[0] ? hostOf(login.uris[0]) : '',
          hasTotp: Boolean(totpSourceOf(payload)),
          favorite: payload.favorite,
          matches: Boolean(login && pageUrl && matchesAny(login.uris, pageUrl)),
        };
      })
      .sort(
        (a, b) =>
          Number(b.matches) - Number(a.matches) ||
          Number(b.favorite) - Number(a.favorite) ||
          a.name.localeCompare(b.name, 'tr'),
      );
  }

  private async row(itemId: string, touch = true): Promise<{ held: Held; row: Row }> {
    const held = await this.require();
    if (touch) await this.touch(held);
    const row = (await this.rows(held)).find((r) => r.item.id === itemId);
    if (!row) throw new RequestError('vault_item_not_found');
    return { held, row };
  }

  async login(itemId: string) {
    const { row } = await this.row(itemId);
    if (row.payload.type !== 'login') throw new RequestError('vault_item_not_login');
    return { payload: row.payload, vaultId: row.vault.id };
  }

  /** The popup refreshes the code every second: only copying counts as using the vault. */
  async totp(itemId: string, opts: { forCopy?: boolean } = {}) {
    const { row } = await this.row(itemId, Boolean(opts.forCopy));
    const config = parseTotp(totpSourceOf(row.payload));
    if (!config) throw new RequestError('vault_no_totp');
    const at = this.now();
    const code = totpAt(config, at);
    return {
      code: opts.forCopy ? totpForCopy(config, at) : code.code,
      remaining: code.remaining,
      period: config.period,
    };
  }

  /** "Which field, never its value" (design 8.11), as the web app reports it. */
  async report(itemId: string, vaultId: string, field: string) {
    const api = await this.deps.api();
    await api
      .call('vaultReportEvents', {
        body: { events: [{ vaultId, itemId, action: 'copy', field }] },
      })
      .catch(() => undefined);
  }

  /** The login already saved for this site and user, if any. */
  async findLogin(pageUrl: string, username: string) {
    const h = await this.require();
    const logins = (await this.rows(h)).filter(
      (r) => r.payload.type === 'login' && matchesAny(r.payload.uris, pageUrl),
    );
    return (
      logins.find((r) => r.payload.type === 'login' && r.payload.username === username) ?? null
    );
  }

  async editableVaults() {
    await this.require();
    const { items } = await (await this.deps.api()).call('vaultList');
    return items.filter((v) => v.canEdit);
  }

  private encrypted(h: Held, vault: Vault, id: string, revision: number, payload: ItemPayload) {
    return {
      type: payload.type,
      keyVersion: vault.keyVersion,
      ...encryptItem(
        this.keyOf(h, vault),
        { vaultId: vault.id, itemId: id, revision, keyVersion: vault.keyVersion, type: payload.type },
        payload,
      ),
    };
  }

  async createLogin(
    vaultId: string,
    input: { name: string; username: string; password: string; url: string },
  ) {
    const h = await this.require();
    await this.touch(h);
    const vault = (await this.editableVaults()).find((v) => v.id === vaultId);
    if (!vault) throw new RequestError('vault_item_not_found');
    const payload = ItemPayload.parse({
      v: 1,
      type: 'login',
      name: input.name,
      username: input.username,
      password: input.password,
      uris: [input.url],
    });
    const id = newId();
    await (
      await this.deps.api()
    ).call('vaultCreateItem', {
      params: { vaultId },
      body: { id, ...this.encrypted(h, vault, id, 1, payload) },
    });
    this.cache = null;
  }

  async updatePassword(itemId: string, password: string) {
    const { held, row } = await this.row(itemId);
    if (row.payload.type !== 'login') throw new RequestError('vault_item_not_login');
    const payload: ItemPayload = {
      ...row.payload,
      password,
      passwordHistory: [
        { password: row.payload.password, changedAt: new Date(this.now()).toISOString() },
        ...row.payload.passwordHistory,
      ].slice(0, PASSWORD_HISTORY_LIMIT),
    };
    const revision = row.item.revision + 1;
    await (
      await this.deps.api()
    ).call('vaultUpdateItem', {
      params: { itemId },
      body: { revision, ...this.encrypted(held, row.vault, itemId, revision, payload) },
    });
    this.cache = null;
  }
}
