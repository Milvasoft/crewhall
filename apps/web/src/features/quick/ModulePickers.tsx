import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Input,
  Skeleton,
  type IconName,
} from '@crewhall/ui';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState, type ReactNode } from 'react';
import { spaceName } from '@/components/spaces/spaceUtils';
import { vaultName } from '@/components/vault/VaultSidebar';
import { conversationsQuery } from '@/lib/chat/queries';
import { useI18n } from '@/lib/i18n/I18nContext';
import { vaultsQuery } from '@/lib/vault/api';
import { useItemsOf } from '@/lib/vault/items';
import { useVaultSession } from '@/lib/vault/session';
import { useSpaces } from '@/lib/useSpaces';
import { pageTreeQuery } from '@/lib/wiki/api';

/** What a new page, chat or vault card points at (H4); the picker returns its config. */
export type ModulePick =
  | { type: 'page'; config: { nodeId: string } }
  | { type: 'chat'; config: { conversationId: string } }
  | { type: 'vault_item'; config: { vaultId: string; itemId: string } };

export type PickerKind = ModulePick['type'];

interface Option {
  id: string;
  label: string;
  meta: string;
  icon: ReactNode;
  pick: ModulePick;
}

const TITLE = {
  page: 'quick.picker.pageTitle',
  chat: 'quick.picker.chatTitle',
  vault_item: 'quick.picker.vaultTitle',
} as const;
const ICON: Record<PickerKind, IconName> = { page: 'page', chat: 'chat', vault_item: 'vault' };

/** Search-and-pick dialog for the page, chat and vault item cards. */
export function ModulePicker({
  kind,
  onPick,
  onClose,
}: {
  kind: PickerKind | null;
  onPick: (pick: ModulePick) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={kind !== null} onOpenChange={(v) => (v ? null : onClose())}>
      {kind ? <PickerBody key={kind} kind={kind} onPick={onPick} onClose={onClose} /> : null}
    </Dialog>
  );
}

interface BodyProps {
  kind: PickerKind;
  onPick: (pick: ModulePick) => void;
  onClose: () => void;
}

function PickerBody(p: BodyProps) {
  if (p.kind === 'page') return <PagePicker {...p} />;
  if (p.kind === 'chat') return <ChatPicker {...p} />;
  return <VaultPicker {...p} />;
}

function PagePicker(p: BodyProps) {
  return <PickerView {...p} source={usePageOptions()} />;
}

function ChatPicker(p: BodyProps) {
  return <PickerView {...p} source={useChatOptions()} />;
}

function VaultPicker(p: BodyProps) {
  return <PickerView {...p} source={useVaultOptions()} />;
}

function PickerView({ kind, onPick, onClose, source }: BodyProps & { source: Source }) {
  const { t, locale } = useI18n();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const needle = q.trim().toLocaleLowerCase(locale);
  const shown = source.options.filter(
    (o) => !needle || `${o.label} ${o.meta}`.toLocaleLowerCase(locale).includes(needle),
  );
  const pick = source.options.find((o) => o.id === chosen)?.pick;

  return (
    <DialogContent width={480}>
      <DialogHeader icon={ICON[kind]} title={t(TITLE[kind])} />
      {source.locked ? (
        <div className="flex flex-col items-start gap-3">
          <p className="m-0 text-cap text-fg2">{t('quick.picker.vaultLocked')}</p>
          <Button variant="inv" size="sm" asChild>
            <Link to="/vault" onClick={onClose}>
              {t('quick.vault.unlock')}
            </Link>
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick) onPick(pick);
          }}
        >
          <Input
            autoFocus
            icon="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('quick.picker.search')}
            aria-label={t('quick.picker.search')}
          />
          <div
            role="listbox"
            aria-label={t(TITLE[kind])}
            className="flex max-h-[320px] min-h-[120px] flex-col gap-0.5 overflow-y-auto"
          >
            {source.loading ? (
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)
            ) : shown.length === 0 ? (
              <p className="m-0 py-6 text-center text-cap text-fg3">{t('quick.picker.empty')}</p>
            ) : (
              shown.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={chosen === o.id}
                  onClick={() => setChosen(o.id)}
                  onDoubleClick={() => onPick(o.pick)}
                  className={cn(
                    'flex min-h-10 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-bg2',
                    chosen === o.id && 'bg-capsule',
                  )}
                >
                  <span className="flex size-7 shrink-0 items-center justify-center">{o.icon}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-cap font-semibold">{o.label}</span>
                    {o.meta ? <span className="truncate text-xs text-fg3">{o.meta}</span> : null}
                  </span>
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" disabled={!pick}>
              {t('quick.picker.add')}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}

interface Source {
  options: Option[];
  loading: boolean;
  locked?: boolean;
}

/** Pages of every space the person can see, with the space as the subtitle. */
function usePageOptions(): Source {
  const { t } = useI18n();
  const { items: spaces } = useSpaces();
  const trees = useQueries({
    queries: spaces.map((s) => ({ ...pageTreeQuery(s.id), retry: false })),
  });
  const options = useMemo(
    () =>
      spaces.flatMap((s, i) =>
        (trees[i]?.data?.items ?? []).map<Option>((p) => ({
          id: p.id,
          label: p.name,
          meta: spaceName(s, t),
          icon: p.icon ? (
            <span className="text-[15px] leading-none">{p.icon}</span>
          ) : (
            <Icon name="page" size={16} className="text-fg2" />
          ),
          pick: { type: 'page', config: { nodeId: p.id } },
        })),
      ),
    [spaces, trees, t],
  );
  return { options, loading: trees.some((q) => q.isPending) };
}

/** The person's conversations, archived ones left out. */
function useChatOptions(): Source {
  const convs = useQuery(conversationsQuery);
  const options = useMemo(
    () =>
      (convs.data ?? [])
        .filter((c) => !c.archivedAt && c.type !== 'alert')
        .map<Option>((c) => ({
          id: c.id,
          label: c.title,
          meta: c.spaceName ?? '',
          icon: <Icon name="chat" size={16} className="text-fg2" />,
          pick: { type: 'chat', config: { conversationId: c.id } },
        })),
    [convs.data],
  );
  return { options, loading: convs.isPending };
}

/** Decrypted on this device; the card later stores only the vault and item ids. */
function useVaultOptions(): Source {
  const { t } = useI18n();
  const { unlocked } = useVaultSession();
  const vaults = useQuery({ ...vaultsQuery, enabled: Boolean(unlocked) });
  const { items, loading } = useItemsOf(vaults.data ?? []);
  const options = useMemo(
    () =>
      items
        .filter((d) => d.summary && !d.item.deletedAt)
        .map<Option>((d) => ({
          id: d.item.id,
          label: d.summary!.name,
          meta: vaultName(d.vault, t),
          icon: <Icon name="vault" size={16} className="text-fg2" />,
          pick: { type: 'vault_item', config: { vaultId: d.vault.id, itemId: d.item.id } },
        })),
    [items, t],
  );
  if (!unlocked) return { options: [], loading: false, locked: true };
  return { options, loading: vaults.isPending || loading };
}
