import { createFileRoute, notFound } from '@tanstack/react-router';
import { z } from 'zod';
import { VaultMain } from '@/components/vault/VaultMain';
import { isCategory } from '@/lib/vault/items';

/** Items of one vault and category (design 8.4); ids in the URL, never item names. */
export const Route = createFileRoute('/_app/vault/$vaultId/$category')({
  params: {
    parse: (p) => {
      if (!isCategory(p.category) || !z.uuid().safeParse(p.vaultId).success) throw notFound();
      return { vaultId: p.vaultId, category: p.category };
    },
    stringify: (p) => p,
  },
  validateSearch: z.object({
    item: z.uuid().optional().catch(undefined),
    edit: z.boolean().optional().catch(undefined),
    move: z.boolean().optional().catch(undefined),
    tag: z.string().max(100).optional().catch(undefined),
    new: z
      .enum(['pick', 'login', 'note', 'card', 'api_key', 'ssh_key', 'identity'])
      .optional()
      .catch(undefined),
  }),
  component: function VaultItems() {
    const { vaultId, category } = Route.useParams();
    return <VaultMain vaultId={vaultId} category={category} search={Route.useSearch()} />;
  },
});
