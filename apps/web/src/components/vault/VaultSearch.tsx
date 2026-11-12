import { type Vault } from '@crewhall/shared';
import { Icon, SpaceDot, Spinner } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { matches, useItemsOf, type DecryptedItem } from '@/lib/vault/items';
import { ItemAvatar } from './ItemDetail';
import { subtitle } from './VaultMain';
import { vaultName } from './VaultSidebar';

/** Items shown per vault; the rest is a count and a link to that vault. */
const PER_VAULT = 5;

/**
 * Search across every vault the person can open (sonraki-isler "Kasalar arası arama"). Runs on
 * this device only, over the list summaries: they are decrypted once in the vault worker,
 * cached per revision and wiped on lock, so the term never reaches the server. Mounted only
 * while a term is typed, so the first search is what decrypts the other vaults.
 */
export function VaultSearchResults({
  vaults,
  term,
  onPick,
}: {
  vaults: Vault[];
  term: string;
  onPick: () => void;
}) {
  const { t, locale } = useI18n();
  const { items, loading } = useItemsOf(vaults);
  const groups = useMemo(() => {
    const byVault = new Map<string, DecryptedItem[]>();
    for (const d of items) {
      if (d.item.deletedAt || !matches(d, term)) continue;
      const list = byVault.get(d.vault.id);
      if (list) list.push(d);
      else byVault.set(d.vault.id, [d]);
    }
    return vaults.flatMap((v) => {
      const hits = byVault.get(v.id);
      return hits ? [{ vault: v, hits }] : [];
    });
  }, [items, term, vaults]);

  if (!groups.length) {
    return (
      <p className="flex items-center gap-2 px-2.5 py-2 text-xs text-fg3" role="status">
        {loading ? <Spinner size={12} /> : null}
        {loading ? t('vault.searchAll.searching') : t('vault.searchAll.empty')}
      </p>
    );
  }
  return (
    <div role="region" aria-label={t('vault.searchAll.results')} className="flex flex-col gap-2">
      {groups.map(({ vault, hits }) => (
        <section key={vault.id} aria-label={vaultName(vault, t)} className="flex flex-col">
          <span className="flex items-center gap-2 px-2.5 py-1 text-xs font-semibold text-fg2">
            {vault.space ? <SpaceDot color={vault.space.color} /> : <Icon name="user" size={13} />}
            <span className="min-w-0 flex-1 truncate">{vaultName(vault, t)}</span>
            <span className="font-medium text-fg3 tn">{formatNumber(hits.length, locale)}</span>
          </span>
          {hits.slice(0, PER_VAULT).map((d) => (
            <Link
              key={d.item.id}
              to="/vault/$vaultId/$category"
              params={{ vaultId: vault.id, category: 'all' }}
              search={{ item: d.item.id }}
              onClick={onPick}
              className="flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-fg2 hover:bg-bg2 hover:text-fg"
            >
              <ItemAvatar name={d.summary?.name ?? null} type={d.item.type} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-semibold text-fg">
                  {d.summary?.name}
                </span>
                <span className="truncate text-xs text-fg3">
                  {d.summary ? subtitle(d.summary, t) : ''}
                </span>
              </span>
            </Link>
          ))}
          {hits.length > PER_VAULT ? (
            <Link
              to="/vault/$vaultId/$category"
              params={{ vaultId: vault.id, category: 'all' }}
              onClick={onPick}
              className="px-2.5 py-1 text-xs text-fg3 hover:text-fg"
            >
              {t('vault.searchAll.more', { count: hits.length - PER_VAULT })}
            </Link>
          ) : null}
        </section>
      ))}
    </div>
  );
}
