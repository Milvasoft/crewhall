import { getConnection, getSettings, updateSettings } from '../shared/storage';
import { hostOf } from '../shared/match';
import { RequestError, type CapturePrompt } from '../shared/messages';
import type { KeyValue, VaultService } from './vault';

/**
 * "Kasaya kaydedilsin mi?" after a sign-in. What was typed waits in session storage (memory) for
 * a few minutes, for the page that follows the sign-in to ask. The password never goes to the
 * prompt, only the site and the user name do.
 */

interface Pending {
  /** What the person saw: a frame on the page cannot swap the record after the question is up. */
  id: string;
  url: string;
  host: string;
  username: string;
  password: string;
  at: number;
}

const TTL_MS = 5 * 60_000;
const PREFIX = 'capture.';
const keyOf = (tabId: number) => `${PREFIX}${tabId}`;

export class CaptureService {
  constructor(
    private readonly vault: VaultService,
    private readonly session: KeyValue,
    private readonly now: () => number = Date.now,
  ) {}

  private async pending(tabId: number): Promise<Pending | null> {
    const p = (await this.session.get(keyOf(tabId))) as Pending | undefined;
    if (!p) return null;
    if (this.now() - p.at > TTL_MS) {
      await this.session.remove(keyOf(tabId));
      return null;
    }
    return p;
  }

  async submitted(tabId: number, url: string, username: string, password: string) {
    const settings = await getSettings();
    if (!settings.vault || !settings.capture || !password) return;
    const host = hostOf(url);
    if (!host || settings.neverHosts.includes(host)) return;
    // Crewhall's own forms hold the account and vault passwords: those are never offered.
    const connection = await getConnection();
    if (!connection || new URL(url).origin === connection.origin) return;
    await this.session.set(keyOf(tabId), {
      id: crypto.randomUUID(),
      url,
      host,
      username,
      password,
      at: this.now(),
    });
  }

  /** New, changed or unknowable (locked); null when the vault already has exactly this. */
  async prompt(tabId: number): Promise<CapturePrompt | null> {
    const p = await this.pending(tabId);
    if (!p) return null;
    if (!(await this.vault.isUnlocked())) {
      return {
        id: p.id,
        mode: 'locked',
        host: p.host,
        username: p.username,
        itemName: null,
        vaults: [],
      };
    }
    const existing = await this.vault.findLogin(p.url, p.username);
    if (existing?.payload.type === 'login' && existing.payload.password === p.password) {
      await this.session.remove(keyOf(tabId));
      return null;
    }
    const vaults = (await this.vault.editableVaults()).map((v) => ({ id: v.id, name: v.name }));
    return {
      id: p.id,
      mode: existing ? 'update' : 'new',
      host: p.host,
      username: p.username,
      itemName: existing?.payload.name ?? null,
      vaults,
    };
  }

  async save(tabId: number, id: string, vaultId?: string) {
    const p = await this.pending(tabId);
    if (!p || p.id !== id) throw new RequestError('capture_expired');
    const existing = await this.vault.findLogin(p.url, p.username);
    if (existing) {
      await this.vault.updatePassword(existing.item.id, p.password);
    } else {
      const vaults = await this.vault.editableVaults();
      const target = vaultId ?? vaults.find((v) => v.kind === 'personal')?.id ?? vaults[0]?.id;
      if (!target) throw new RequestError('vault_item_not_found');
      const origin = new URL(p.url).origin;
      await this.vault.createLogin(target, {
        name: p.host,
        username: p.username,
        password: p.password,
        url: origin,
      });
    }
    await this.session.remove(keyOf(tabId));
  }

  /** The vault was locked: nothing typed earlier stays in memory. */
  async clear() {
    for (const key of await this.session.keys()) {
      if (key.startsWith(PREFIX)) await this.session.remove(key);
    }
  }

  /** The five minutes are also enforced for records no page asks about any more. */
  async sweep() {
    for (const key of await this.session.keys()) {
      if (!key.startsWith(PREFIX)) continue;
      const p = (await this.session.get(key)) as Pending | undefined;
      if (p && this.now() - p.at > TTL_MS) await this.session.remove(key);
    }
  }

  forget(tabId: number) {
    return this.session.remove(keyOf(tabId));
  }

  async dismiss(tabId: number, never: boolean) {
    const p = await this.pending(tabId);
    await this.session.remove(keyOf(tabId));
    if (never && p) {
      const { neverHosts } = await getSettings();
      if (!neverHosts.includes(p.host)) {
        await updateSettings({ neverHosts: [...neverHosts, p.host] });
      }
    }
  }
}
