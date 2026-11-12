import { type ItemPayload } from '@crewhall/crypto';
import { type Vault, type VaultItem } from '@crewhall/shared';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogHeader,
  Icon,
  Progress,
  SpaceDot,
  toast,
} from '@crewhall/ui';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatNumber } from '@/lib/i18n/format';
import { useI18n, type I18nValue } from '@/lib/i18n/I18nContext';
import { invalidateVault, moveItem } from '@/lib/vault/api';
import { payloadOf, type DecryptedItem } from '@/lib/vault/items';
import { errorMessage } from './errors';
import { vaultName } from './VaultSidebar';

interface Moved {
  item: VaultItem;
  payload: ItemPayload;
  from: Vault;
}

/**
 * Moves items one by one with the existing move flow: each is re-encrypted with the target
 * vault's key on this device (the server only swaps ciphertexts). Items that do not decrypt
 * stay where they are.
 */
async function moveAll(
  items: DecryptedItem[],
  target: Vault,
  onProgress: (done: number) => void,
): Promise<Moved[]> {
  const moved: Moved[] = [];
  for (const d of items) {
    const payload = payloadOf(d);
    if (!payload) continue;
    moved.push({ item: await moveItem(d.item, target, payload), payload, from: d.vault });
    onProgress(moved.length);
  }
  return moved;
}

/** "X kasasına taşındı · Geri al": undo moves each item back the same way. */
function announce(moved: Moved[], target: Vault, qc: QueryClient, t: I18nValue['t']) {
  const sources = new Set(moved.map((m) => m.from.id));
  const refresh = () => {
    invalidateVault(qc, target.id);
    for (const id of sources) invalidateVault(qc, id);
  };
  refresh();
  const name = vaultName(target, t);
  toast(
    moved.length === 1
      ? t('vault.move.done', { vault: name })
      : t('vault.move.doneMany', { count: moved.length, vault: name }),
    {
      duration: 8000,
      action: {
        label: t('vault.move.undo'),
        onClick: () =>
          void (async () => {
            for (const m of moved) await moveItem(m.item, m.from, m.payload);
          })()
            .then(() => toast(t('vault.move.undone')))
            .catch((e: unknown) => toast(errorMessage(e, t)))
            .finally(refresh),
      },
    },
  );
}

/**
 * Small searchable vault picker for "Başka kasaya taşı" (sonraki-isler): vaults the person may
 * write to, without the current one. Used for one item from its menu and for a selection in
 * the list.
 */
export function MoveDialog({
  open,
  onOpenChange,
  from,
  items,
  vaults,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  from: Vault;
  items: DecryptedItem[];
  vaults: Vault[];
  onMoved: (target: Vault) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = vaults.filter((v) => v.canEdit && v.id !== from.id);
  const busy = done !== null;

  const pick = async (target: Vault) => {
    if (busy) return;
    setDone(0);
    setError(null);
    try {
      const moved = await moveAll(items, target, setDone);
      onOpenChange(false);
      onMoved(target);
      if (moved.length) announce(moved, target, qc, t);
    } catch (e) {
      setError(errorMessage(e, t));
      // Some may have moved before the error; show the lists as they are now.
      invalidateVault(qc, target.id);
      invalidateVault(qc, from.id);
    } finally {
      setDone(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent width={420} className="gap-3">
        <DialogHeader
          icon="arrowR"
          title={
            items.length === 1
              ? t('vault.move.title')
              : t('vault.move.titleMany', { count: items.length })
          }
          description={
            items.length === 1 && items[0]?.summary
              ? t('vault.move.body', { name: items[0].summary.name })
              : t('vault.move.bodyMany')
          }
        />
        <Command className="rounded-xl shadow-line">
          <CommandInput
            placeholder={t('vault.move.search')}
            aria-label={t('vault.move.search')}
            disabled={busy}
          />
          <CommandList className="max-h-[300px]">
            <CommandEmpty className="px-3 py-4 text-sm text-fg3">
              {targets.length ? t('vault.move.noMatch') : t('vault.move.noTarget')}
            </CommandEmpty>
            {targets.map((v) => (
              <CommandItem
                key={v.id}
                value={`${vaultName(v, t)} ${v.id}`}
                disabled={busy}
                onSelect={() => void pick(v)}
              >
                {v.space ? (
                  <SpaceDot color={v.space.color} className="mx-1" />
                ) : (
                  <Icon name="user" size={16} />
                )}
                <span className="min-w-0 flex-1 truncate">{vaultName(v, t)}</span>
                <span className="text-xs text-fg3 tn">{formatNumber(v.itemCount, locale)}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
        {busy && items.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-fg2">
              {t('vault.move.progress', {
                done: formatNumber(done, locale),
                total: formatNumber(items.length, locale),
              })}
            </span>
            <Progress value={(100 * done) / items.length} label={t('vault.move.title')} />
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
