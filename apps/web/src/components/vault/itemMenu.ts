import { toast } from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { invalidateVault, policyQuery } from '@/lib/vault/api';
import { payloadOf, type DecryptedItem } from '@/lib/vault/items';
import { errorMessage } from './errors';
import { useCopy } from './fields';

export interface ItemMenuHandlers {
  onOpen: (d: DecryptedItem) => void;
  onMove: (d: DecryptedItem) => void;
  onHistory: (d: DecryptedItem) => void;
  onShare: (d: DecryptedItem) => void;
}

/**
 * Right-click menu of a row in the item list: the same actions and rules as the "…" menu of the
 * detail (history, share link, move, trash; restore and purge in the trash). Secrets are
 * decrypted only when a copy is chosen, as the hover copy buttons do.
 */
export function useItemMenu(h: ItemMenuHandlers) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const copy = useCopy();
  const policy = useQuery(policyQuery);

  const act = (d: DecryptedItem, fn: () => Promise<unknown>) =>
    void fn()
      .then(() => invalidateVault(qc, d.vault.id))
      .catch((e: unknown) => toast(errorMessage(e, t)));

  /** `hasPassword` is known only after the menu opened (decrypted then, kept as a flag). */
  return (d: DecryptedItem, hasPassword: boolean): ActionEntry[] => {
    const { item, vault, summary: p } = d;
    const access = { vaultId: vault.id, itemId: item.id };
    const open: ActionEntry = {
      kind: 'item',
      key: 'open',
      icon: 'eye',
      label: t('vault.menu.open'),
      onSelect: () => h.onOpen(d),
    };

    if (item.deletedAt) {
      const entries: ActionEntry[] = [open];
      if (vault.canEdit || vault.myRole === 'manage') entries.push({ kind: 'sep', key: 's1' });
      if (vault.canEdit) {
        entries.push({
          kind: 'item',
          key: 'restore',
          icon: 'undo',
          label: t('vault.trash.restore'),
          onSelect: () =>
            act(d, () => api.call('vaultRestoreItem', { params: { itemId: item.id } })),
        });
      }
      if (vault.myRole === 'manage') {
        entries.push({
          kind: 'item',
          key: 'purge',
          icon: 'trash',
          label: t('vault.trash.purge'),
          danger: true,
          onSelect: () => {
            if (window.confirm(t('vault.trash.purgeConfirm', { name: p?.name ?? '' }))) {
              act(d, () => api.call('vaultPurgeItem', { params: { itemId: item.id } }));
            }
          },
        });
      }
      return entries;
    }

    const entries: ActionEntry[] = [open];
    if (p?.username && (p.type === 'login' || p.type === 'api_key')) {
      entries.push({
        kind: 'item',
        key: 'copyUsername',
        icon: 'copy',
        label: t('vault.menu.copyUsername'),
        onSelect: () => void copy(p.username, 'vault.field.username', access, 'username'),
      });
    }
    if (p?.type === 'login' && hasPassword) {
      entries.push({
        kind: 'item',
        key: 'copyPassword',
        icon: 'key',
        label: t('vault.menu.copyPassword'),
        onSelect: () =>
          void copy(
            () => {
              // Decrypted only now, for this one copy.
              const full = payloadOf(d);
              return full?.type === 'login' ? full.password : '';
            },
            'vault.field.password',
            access,
            'password',
          ),
      });
    }
    entries.push({ kind: 'sep', key: 's1' });
    entries.push({
      kind: 'item',
      key: 'history',
      icon: 'history',
      label: t('vault.history.open'),
      onSelect: () => h.onHistory(d),
    });
    if (vault.canEdit && p) {
      // Share links follow the edit rule (canVault 'vault.share_link'), and the org policy.
      entries.push({
        kind: 'item',
        key: 'share',
        icon: 'link',
        label: t('vault.share.open'),
        disabledReason:
          policy.data && !policy.data.shareLinks ? t('vault.share.disabled') : undefined,
        onSelect: () => h.onShare(d),
      });
      entries.push({
        kind: 'item',
        key: 'move',
        icon: 'arrowR',
        label: t('vault.detail.move'),
        onSelect: () => h.onMove(d),
      });
    }
    if (vault.canEdit) {
      entries.push({ kind: 'sep', key: 's2' });
      entries.push({
        kind: 'item',
        key: 'trash',
        icon: 'trash',
        label: t('vault.detail.trash'),
        danger: true,
        onSelect: () => act(d, () => api.call('vaultTrashItem', { params: { itemId: item.id } })),
      });
    }
    return entries;
  };
}
