import {
  daysUntil,
  EXPIRY_BADGE_DAYS,
  type ItemPayload,
  type ItemSummary,
  type ItemType,
} from '@crewhall/crypto';
import {
  type Vault,
  VAULT_CATEGORY_SLUGS,
  type VaultCategorySlug,
  type VaultItem,
} from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { itemsQuery } from './api';
import { decryptVaultItem, summarizeVaultItems, useVaultSession } from './session';

/** Decrypted view of the vault for the screens; recomputed in memory, never stored. */

/** List categories, also the URL segment (`/vault/:vaultId/:category`). */
export const CATEGORIES = VAULT_CATEGORY_SLUGS;
export type Category = VaultCategorySlug;

export const TYPE_BY_CATEGORY: Partial<Record<Category, ItemType>> = {
  logins: 'login',
  notes: 'note',
  cards: 'card',
  'api-keys': 'api_key',
  'ssh-keys': 'ssh_key',
  identities: 'identity',
};

export const CATEGORY_ICON: Record<Category, IconName> = {
  all: 'layers',
  favorites: 'star',
  logins: 'user',
  notes: 'note',
  cards: 'card',
  'api-keys': 'key',
  'ssh-keys': 'terminal',
  identities: 'id',
  trash: 'trash',
};

export const TYPE_ICON: Record<ItemType, IconName> = {
  login: 'user',
  note: 'note',
  card: 'card',
  api_key: 'key',
  ssh_key: 'terminal',
  identity: 'id',
};

export const isCategory = (v: string): v is Category =>
  (CATEGORIES as readonly string[]).includes(v);

export interface DecryptedItem {
  item: VaultItem;
  vault: Vault;
  /** List fields only. Null when the ciphertext failed to authenticate or went back in revision. */
  summary: ItemSummary | null;
  error: 'tampered' | 'rollback' | null;
}

const collator = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });
const byName = (x: DecryptedItem, y: DecryptedItem) =>
  collator.compare(x.summary?.name ?? '', y.summary?.name ?? '');

async function summarizeAll(vault: Vault, rows: VaultItem[]): Promise<DecryptedItem[]> {
  const list = await summarizeVaultItems(vault, rows);
  return list.map((r) => ({ ...r, vault }));
}

/**
 * One vault's items for lists (H13): summaries from the worker, cached per revision, so opening
 * the vault decrypts each item once and re-renders decrypt nothing. Null while loading.
 */
export function useVaultItems(vault: Vault | undefined) {
  const { unlocked } = useVaultSession();
  const q = useQuery({ ...itemsQuery(vault?.id ?? ''), enabled: Boolean(vault && unlocked) });
  const [items, setItems] = useState<{ data: VaultItem[]; list: DecryptedItem[] } | null>(null);
  useEffect(() => {
    if (!vault || !q.data || !unlocked) return;
    let alive = true;
    const data = q.data;
    void summarizeAll(vault, data).then((list) => {
      if (alive) setItems({ data, list: list.sort(byName) });
    });
    return () => {
      alive = false;
    };
  }, [vault, q.data, unlocked]);
  const fresh = items && items.data === q.data ? items.list : null;
  return {
    ...q,
    isPending: q.isPending || (Boolean(q.data) && !fresh && !items),
    items: unlocked ? (fresh ?? items?.list ?? []) : [],
  };
}

/** Stable combine: TanStack shares the result structurally, so effects see real changes only. */
function combine(results: { data?: VaultItem[]; isPending: boolean }[]) {
  return { datas: results.map((r) => r.data), loading: results.some((r) => r.isPending) };
}

/** Equal for equal vault lists (a person has a handful of vaults, so this stays cheap). */
const vaultSetKey = (vaults: Vault[]) => JSON.stringify(vaults);

/** Items of several vaults (health report, import duplicate check, log names). */
export function useItemsOf(vaultsIn: Vault[]) {
  const { unlocked } = useVaultSession();
  // Callers often pass a freshly filtered array on every render; following that identity made
  // the effect below re-run and re-render forever (the import page froze). Keep one array per
  // set of vaults instead.
  const [vaults, setVaults] = useState(vaultsIn);
  if (vaultSetKey(vaults) !== vaultSetKey(vaultsIn)) setVaults(vaultsIn);
  const { datas, loading } = useQueries({
    queries: vaults.map((v) => ({ ...itemsQuery(v.id), enabled: Boolean(unlocked) })),
    combine,
  });
  const [items, setItems] = useState<DecryptedItem[]>([]);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    if (!unlocked) return;
    let alive = true;
    void Promise.all(vaults.map((v, i) => (datas[i] ? summarizeAll(v, datas[i]) : []))).then(
      (lists) => {
        if (!alive) return;
        setItems(lists.flat());
        setBusy(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [unlocked, vaults, datas]);
  return { items: unlocked ? items : [], loading: loading || busy };
}

/** The whole payload, decrypted in the page only for the item being shown or edited. */
export function payloadOf(d: Pick<DecryptedItem, 'vault' | 'item'>): ItemPayload | null {
  const r = decryptVaultItem(d.vault, d.item);
  return r.ok ? r.payload : null;
}

export function inCategory(d: DecryptedItem, c: Category): boolean {
  const trashed = d.item.deletedAt !== null;
  if (c === 'trash') return trashed;
  if (trashed) return false;
  if (c === 'all') return true;
  if (c === 'favorites') return Boolean(d.summary?.favorite);
  return d.item.type === TYPE_BY_CATEGORY[c];
}

/** Tag filter; null shows everything. */
export function hasTag(d: DecryptedItem, tag: string | null | undefined): boolean {
  return !tag || Boolean(d.summary?.tags.includes(tag));
}

/** Tags in use outside the trash with their item counts, sorted by name. */
export function tagCounts(items: DecryptedItem[]): [tag: string, count: number][] {
  const counts = new Map<string, number>();
  for (const d of items) {
    if (d.item.deletedAt !== null) continue;
    for (const tag of new Set(d.summary?.tags ?? [])) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b, 'tr-TR'));
}

/** Trims, drops empties and duplicates; keeps the first spelling of each tag. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().slice(0, 100);
    if (tag && !out.some((x) => x.toLocaleLowerCase('tr-TR') === tag.toLocaleLowerCase('tr-TR'))) {
      out.push(tag);
    }
  }
  return out.slice(0, 50);
}

/**
 * Search runs here, on decrypted summaries; the server never sees the query (design 8.4). Name,
 * user name, site, tags and type-specific labels; secrets and note bodies are not searched.
 */
export function matches(d: DecryptedItem, term: string): boolean {
  const q = term.trim().toLocaleLowerCase('tr-TR');
  if (!q) return true;
  const s = d.summary;
  if (!s) return false;
  return [s.name, s.username, s.uri, s.sshHost, s.fullName, ...s.tags].some((h) =>
    h.toLocaleLowerCase('tr-TR').includes(q),
  );
}

export function hostOf(url: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return url;
  }
}

/** Days until expiry when within the badge window (design 8.4: 14 days), else null. */
export function expiryBadge(s: Pick<ItemSummary, 'expiresAt'>, now = new Date()): number | null {
  if (!s.expiresAt) return null;
  const days = daysUntil(new Date(`${s.expiresAt}T00:00:00Z`), now);
  return days <= EXPIRY_BADGE_DAYS ? days : null;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? (parts[1]?.[0] ?? '') : '';
  return (a + b).toLocaleUpperCase('tr-TR');
}

/** Only http(s) links open; anything else (javascript:, data:) stays plain text. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
