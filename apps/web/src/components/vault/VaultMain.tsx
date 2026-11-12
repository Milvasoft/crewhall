import {
  parseTotp,
  totpForCopy,
  totpSourceOf,
  type ItemPayload,
  type ItemSummary,
  type ItemType,
} from '@crewhall/crypto';
import { type Vault } from '@crewhall/shared';
import {
  Badge,
  Button,
  Checkbox,
  cn,
  EmptyState,
  Icon,
  Input,
  SelectAllCheckbox,
  Spinner,
  Tag,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionContextMenu, type ActionEntry } from '@/components/common/ActionMenu';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useNow } from '@/lib/useNow';
import { createPersonalVault, invalidateVault, vaultsQuery } from '@/lib/vault/api';
import {
  CATEGORIES,
  expiryBadge,
  hasTag,
  inCategory,
  matches,
  payloadOf,
  tagCounts,
  useVaultItems,
  type Category,
  type DecryptedItem,
} from '@/lib/vault/items';
import { errorMessage } from './errors';
import { CopyButton } from './fields';
import { useHealthCount } from '@/lib/vault/health';
import { HistoryDialog, ItemAvatar, ItemDetail } from './ItemDetail';
import { ItemForm, newPayload, TypePicker } from './ItemForm';
import { useItemMenu } from './itemMenu';
import { ShareDialog } from './ShareDialog';
import { MoveDialog } from './MoveDialog';
import { VirtualList } from './VirtualList';
import { vaultName, VaultSidebar } from './VaultSidebar';
import { ResizablePane } from '@/components/shell/ResizablePane';

export interface VaultSearch {
  item?: string;
  edit?: boolean;
  new?: ItemType | 'pick';
  move?: boolean;
  /** Tag filter, kept while moving between items and categories. */
  tag?: string;
}

export { useHealthCount } from '@/lib/vault/health';

/** Second line of a row, from the summary only (no secret is decrypted for the list). */
export function subtitle(p: ItemSummary, t: ReturnType<typeof useI18n>['t']): string {
  switch (p.type) {
    case 'login':
      return [p.username, p.host].filter(Boolean).join(' · ');
    case 'api_key':
      return [t('vault.type.api_key'), p.host || p.username].filter(Boolean).join(' · ');
    case 'card':
      return [t('vault.type.card'), p.cardLast4 ? `•••• ${p.cardLast4}` : '']
        .filter(Boolean)
        .join(' · ');
    case 'ssh_key':
      return [t('vault.type.ssh_key'), p.sshHost].filter(Boolean).join(' · ');
    case 'identity':
      return p.fullName || t('vault.type.identity');
    case 'note':
      return t('vault.type.note');
  }
}

/** Fixed row height for the windowed list (avatar 36 + padding). */
const ROW_HEIGHT = 56;

/** Items view (design 8.4-8.8, 8.17-8.18): sidebar, list column, detail / form. */
export function VaultMain({
  vaultId,
  category,
  search,
}: {
  vaultId: string;
  category: Category;
  search: VaultSearch;
}) {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const vaults = useQuery(vaultsQuery);
  const list = useMemo(() => vaults.data ?? [], [vaults.data]);
  const vault = list.find((v) => v.id === vaultId);
  const { items, isPending } = useVaultItems(vault);
  const healthCount = useHealthCount(list);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(60_000);
  // Dialogs opened from a row's right-click menu (the detail has its own).
  const [history, setHistory] = useState<DecryptedItem | null>(null);
  const [share, setShare] = useState<{ d: DecryptedItem; payload: ItemPayload } | null>(null);

  const tag = search.tag ?? null;
  const tags = useMemo(() => tagCounts(items), [items]);
  const counts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {};
    const tagged = items.filter((d) => hasTag(d, tag));
    for (const cat of CATEGORIES) c[cat] = tagged.filter((d) => inCategory(d, cat)).length;
    return c;
  }, [items, tag]);
  const shown = useMemo(
    () => items.filter((d) => inCategory(d, category) && hasTag(d, tag) && matches(d, q)),
    [items, category, tag, q],
  );
  const selected = items.find((d) => d.item.id === search.item) ?? null;
  // Selection for moving several items; it belongs to one vault and category.
  const listKey = `${vaultId}/${category}`;
  const [pick, setPick] = useState<{ key: string; ids: string[] }>({ key: listKey, ids: [] });
  const pickedIds = pick.key === listKey ? pick.ids : [];
  const togglePick = (id: string) =>
    setPick({
      key: listKey,
      ids: pickedIds.includes(id) ? pickedIds.filter((x) => x !== id) : [...pickedIds, id],
    });
  // The header box takes the rows a filter or search shows, those that can be moved.
  const pickable = shown.filter((d) => vault?.canEdit && category !== 'trash' && d.summary);
  const pickedShown = pickable.filter((d) => pickedIds.includes(d.item.id)).length;
  const [moving, setMoving] = useState<DecryptedItem[] | null>(null);
  // The whole payload is decrypted only for the opened item, once per revision.
  const selectedPayload = useMemo(() => (selected ? payloadOf(selected) : null), [selected]);

  const go = (s: VaultSearch) =>
    void navigate({
      to: '/vault/$vaultId/$category',
      params: { vaultId, category },
      search: { tag: search.tag, ...s },
    });

  const itemMenu = useItemMenu({
    onOpen: (d) => go({ item: d.item.id }),
    onMove: (d) => setMoving([d]),
    onHistory: setHistory,
    onShare: (d) => {
      const payload = payloadOf(d);
      if (payload) setShare({ d, payload });
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') return;
      const typing = (e.target as HTMLElement).closest('input,textarea,[contenteditable]');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (
        e.key.toLowerCase() === 'n' &&
        !typing &&
        !e.ctrlKey &&
        !e.metaKey &&
        vault?.canEdit &&
        !search.edit &&
        !search.new
      ) {
        e.preventDefault();
        go({ new: 'pick' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (vaults.isPending) {
    return (
      <Workspace crumbs={[{ label: t('vault.title') }]}>
        <Spinner className="m-auto" />
      </Workspace>
    );
  }
  if (!vault) return <NoVault vaults={list} />;

  const sidebar = (
    <VaultSidebar
      vaults={list}
      active={vault.id}
      category={category}
      counts={counts}
      tags={tags}
      tag={tag}
      healthCount={healthCount}
    />
  );
  const tools = (
    <>
      {vault.kind === 'space' ? (
        <Button size="sm" variant="gh" asChild>
          <Link to="/vault/$vaultId/access" params={{ vaultId: vault.id }}>
            <Icon name="users" size={16} />
            {t('vault.access.title')}
            {vault.staleMemberCount > 0 && vault.canManage ? (
              <Badge tone="warn">{vault.staleMemberCount}</Badge>
            ) : null}
          </Link>
        </Button>
      ) : null}
      {vault.myRole === 'manage' ? (
        <Button size="sm" variant="gh" asChild>
          <Link to="/vault/log" search={{ vaultId: vault.id }}>
            <Icon name="activity" size={16} />
            {t('vault.log.short')}
          </Link>
        </Button>
      ) : null}
      {vault.canEdit && category !== 'trash' ? (
        <Button size="sm" variant="pri" onClick={() => go({ new: 'pick' })}>
          <Icon name="plus" size={16} />
          {t('vault.newItem.button')}
        </Button>
      ) : null}
    </>
  );

  let panel;
  // Phone (H10): the list is the screen until an item or the editor opens; back returns to it.
  let listOnly = false;
  if (search.new === 'pick') {
    panel = (
      <TypePicker
        vault={vault}
        onPick={(type) => go({ new: type })}
        onImport={() => void navigate({ to: '/vault/import' })}
      />
    );
  } else if (search.new) {
    panel = (
      <ItemForm
        key={`new-${search.new}`}
        vaults={list}
        vault={vault}
        item={null}
        initial={{ ...newPayload(search.new), tags: tag ? [tag] : [] }}
        tagSuggestions={tags.map(([name]) => name)}
        onDone={(id) => go(id ? { item: id } : {})}
      />
    );
  } else if (selected && selectedPayload && (search.edit || search.move)) {
    panel = (
      <ItemForm
        key={`edit-${selected.item.id}-${selected.item.revision}`}
        vaults={list}
        vault={vault}
        item={selected.item}
        initial={selectedPayload}
        tagSuggestions={tags.map(([name]) => name)}
        onDone={(id) => {
          void qc.invalidateQueries({ queryKey: ['vault'] });
          go(id ? { item: id } : { item: selected.item.id });
        }}
      />
    );
  } else if (selected) {
    panel = (
      <ItemDetail
        key={selected.item.id}
        d={selected}
        onEdit={() => go({ item: selected.item.id, edit: true })}
        onMove={() => setMoving([selected])}
        onTag={(name) => go({ item: selected.item.id, tag: name })}
      />
    );
  } else if (!items.length && !isPending && category !== 'trash') {
    panel = <EmptyVault vault={vault} onNew={() => go({ new: 'pick' })} />;
  } else {
    panel = <EmptyState className="m-auto" icon="vault" title={t('vault.pickItem')} />;
    listOnly = true;
  }

  return (
    <Workspace
      sidebar={sidebar}
      crumbs={[
        { label: vaultName(vault, t) },
        { label: t(`vault.category.${category}`) },
        ...(tag ? [{ label: `#${tag}` }] : []),
      ]}
      tools={tools}
      bodyClassName="flex-row gap-0 p-0"
    >
      <ResizablePane
        id="vault-list"
        side="left"
        defaultWidth={340}
        className={listOnly ? 'max-md:w-full' : 'max-md:hidden'}
      >
        <section
          aria-label={t('vault.list')}
          className={cn(
            'flex w-full min-w-0 flex-col border-r border-line',
            listOnly ? 'max-md:w-full max-md:border-r-0' : 'max-md:hidden',
          )}
        >
          <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
            <Input
              ref={searchRef}
              icon="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('vault.searchPlaceholder')}
              aria-label={t('vault.searchPlaceholder')}
              trailing={<span className="text-xs text-fg3">/</span>}
            />
            <div className="flex items-center justify-between px-1 text-xs">
              <span className="flex min-w-0 items-center gap-1.5 font-semibold text-fg">
                {pickable.length ? (
                  <SelectAllCheckbox
                    state={
                      pickedShown === 0 ? 'none' : pickedShown === pickable.length ? 'all' : 'some'
                    }
                    onChange={(all) =>
                      setPick({ key: listKey, ids: all ? pickable.map((d) => d.item.id) : [] })
                    }
                    label={t('ui.selectAll')}
                  />
                ) : null}
                <span className="truncate">{t(`vault.category.${category}`)}</span>
                {tag ? (
                  <button
                    type="button"
                    aria-label={t('vault.clearTag')}
                    title={t('vault.clearTag')}
                    onClick={() => go({ tag: undefined, item: search.item })}
                    className="inline-flex items-center gap-0.5 rounded-full bg-bg2 px-1.5 font-medium text-fg2 hover:text-fg"
                  >
                    #{tag}
                    <Icon name="x" size={11} />
                  </button>
                ) : null}
                <span className="shrink-0 font-medium text-fg3">
                  {t('vault.itemCount', { count: shown.length })}
                </span>
              </span>
              {pickedIds.length ? (
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-fg">
                    {t('vault.move.selected', { count: pickedIds.length })}
                  </span>
                  <button
                    type="button"
                    className="font-semibold text-fg hover:underline"
                    onClick={() => setMoving(items.filter((d) => pickedIds.includes(d.item.id)))}
                  >
                    {t('vault.move.moveSelected')}
                  </button>
                  <button
                    type="button"
                    className="text-fg3 hover:text-fg"
                    onClick={() => setPick({ key: listKey, ids: [] })}
                  >
                    {t('vault.move.clearSelection')}
                  </button>
                </span>
              ) : category === 'trash' && vault.myRole === 'manage' && shown.length ? (
                <EmptyTrash vault={vault} />
              ) : (
                <span className="text-fg3">{t('vault.sortByName')}</span>
              )}
            </div>
          </div>
          {isPending ? <Spinner className="m-auto" /> : null}
          {!isPending && !shown.length ? (
            <p className="m-auto p-6 text-center text-sm text-fg3">
              {q ? t('vault.noMatch') : t('vault.emptyCategory')}
            </p>
          ) : null}
          {shown.length ? (
            <VirtualList
              className="px-2 py-1"
              items={shown}
              rowHeight={ROW_HEIGHT}
              getKey={(d) => d.item.id}
              activeIndex={shown.findIndex((d) => d.item.id === search.item)}
              renderRow={(d) => (
                <ItemRow
                  d={d}
                  active={d.item.id === search.item}
                  now={now}
                  onSelect={() => go({ item: d.item.id })}
                  menu={(hasPassword) => itemMenu(d, hasPassword)}
                  selectable={vault.canEdit && category !== 'trash' && Boolean(d.summary)}
                  picked={pickedIds.includes(d.item.id)}
                  picking={pickedIds.length > 0}
                  onPick={() => togglePick(d.item.id)}
                  subtitle={d.summary ? subtitle(d.summary, t) : ''}
                  trashLine={
                    d.item.deletedAt
                      ? t('vault.trash.deletedBy', {
                          name: d.item.deletedBy?.name ?? '—',
                          date: formatDate(d.item.deletedAt, locale),
                        })
                      : null
                  }
                />
              )}
            />
          ) : null}
          {category === 'trash' ? (
            <p className="border-t border-line px-4 py-3 text-xs text-fg3">
              {t('vault.trash.hint')}
            </p>
          ) : null}
        </section>
      </ResizablePane>
      <div className={cn('flex min-w-0 flex-1 flex-col', listOnly && 'max-md:hidden')}>{panel}</div>
      {history ? (
        <HistoryDialog open onOpenChange={(v) => !v && setHistory(null)} d={history} />
      ) : null}
      {share ? (
        <ShareDialog
          open
          onOpenChange={(v) => !v && setShare(null)}
          d={share.d}
          payload={share.payload}
        />
      ) : null}
      {moving ? (
        <MoveDialog
          open
          onOpenChange={(open) => !open && setMoving(null)}
          from={vault}
          items={moving}
          vaults={list}
          onMoved={() => {
            setPick({ key: listKey, ids: [] });
            if (selected && moving.some((d) => d.item.id === selected.item.id)) go({});
          }}
        />
      ) : null}
    </Workspace>
  );
}

function ItemRow({
  d,
  active,
  onSelect,
  menu,
  selectable,
  picked,
  picking,
  onPick,
  subtitle,
  now,
  trashLine,
}: {
  d: DecryptedItem;
  active: boolean;
  onSelect: () => void;
  /** Right-click menu entries; whether the login has a password is known once it opens. */
  menu: (hasPassword: boolean) => ActionEntry[];
  /** Can be picked for moving several items at once. */
  selectable: boolean;
  picked: boolean;
  /** Something is picked: every row shows its box, not only on hover. */
  picking: boolean;
  onPick: () => void;
  subtitle: string;
  now: number;
  trashLine: string | null;
}) {
  const { t } = useI18n();
  const p = d.summary;
  const days = p ? expiryBadge(p, new Date(now)) : null;
  const access = { vaultId: d.vault.id, itemId: d.item.id };
  const purgeIn = d.item.deletedAt
    ? Math.ceil((Date.parse(d.item.deletedAt) + 30 * 86_400_000 - now) / 86_400_000)
    : null;
  const [hasPassword, setHasPassword] = useState(false);
  return (
    <ActionContextMenu
      entries={menu(hasPassword)}
      onOpenChange={(open) => {
        // Only a flag is kept: the password itself is decrypted again when it is copied.
        if (open && d.item.type === 'login' && !d.item.deletedAt) {
          const full = payloadOf(d);
          setHasPassword(full?.type === 'login' && full.password !== '');
        }
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          'group flex h-full cursor-pointer items-center gap-3 rounded-lg px-2.5 hover:bg-bg2',
          active && 'bg-capsule hover:bg-capsule',
        )}
      >
        {selectable ? (
          <span
            className={cn(
              'items-center',
              picking ? 'flex' : 'hidden group-focus-within:flex group-hover:flex',
            )}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <Checkbox
              checked={picked}
              onCheckedChange={onPick}
              aria-label={t('vault.move.select', { name: p?.name ?? '' })}
            />
          </span>
        ) : null}
        <ItemAvatar name={p?.name ?? null} type={d.item.type} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold">
            {p ? p.name : t('vault.detail.tampered')}
          </span>
          <span className="truncate text-xs text-fg3">{trashLine ?? subtitle}</span>
        </span>
        {p?.env ? <Tag tone={p.env}>{t(`vault.env.${p.env}`)}</Tag> : null}
        {purgeIn !== null ? (
          <Badge tone={purgeIn < 7 ? 'danger' : 'default'}>
            {t('vault.daysShort', { days: Math.max(0, purgeIn) })}
          </Badge>
        ) : days !== null ? (
          <Badge tone={days < 0 ? 'danger' : 'warn'}>
            {days < 0 ? t('vault.detail.expiredShort') : t('vault.daysShort', { days })}
          </Badge>
        ) : null}
        {/* Quick copy on hover (design 8.6): username, password and the current TOTP code. */}
        {(p?.type === 'login' || p?.hasTotp) && !d.item.deletedAt ? (
          <span className="hidden items-center group-hover:flex group-focus-within:flex">
            {p.type === 'login' && p.username ? (
              <CopyButton
                value={p.username}
                labelKey="vault.field.username"
                access={access}
                field="username"
                size="xs"
              />
            ) : null}
            {d.item.type === 'login' ? (
              <CopyButton
                value={() => {
                  // The password is decrypted only now, for this one copy.
                  const full = payloadOf(d);
                  return full?.type === 'login' ? full.password : '';
                }}
                labelKey="vault.field.password"
                access={access}
                field="password"
                size="xs"
              />
            ) : null}
            {p.hasTotp ? (
              <CopyButton
                value={() => {
                  // Decrypted for this one copy; the next code when this one is about to expire.
                  const full = payloadOf(d);
                  const cfg = full ? parseTotp(totpSourceOf(full)) : null;
                  return cfg ? totpForCopy(cfg, Date.now()) : '';
                }}
                labelKey="vault.field.totp"
                access={access}
                field="totp"
                size="xs"
              />
            ) : null}
          </span>
        ) : null}
      </div>
    </ActionContextMenu>
  );
}

function EmptyTrash({ vault }: { vault: Vault }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="font-semibold text-danger hover:underline"
      onClick={() => {
        if (!window.confirm(t('vault.trash.emptyConfirm'))) return;
        setBusy(true);
        void api.call('vaultEmptyTrash', { params: { vaultId: vault.id } }).finally(() => {
          setBusy(false);
          invalidateVault(qc, vault.id);
        });
      }}
    >
      {t('vault.trash.empty')}
    </button>
  );
}

/** Design 8.17: right after setup only the personal vault exists, and it is empty. */
function EmptyVault({ vault, onNew }: { vault: Vault; onNew: () => void }) {
  const { t } = useI18n();
  return (
    <div className="m-auto flex max-w-[560px] flex-col items-center gap-6 px-6 py-10 text-center">
      <EmptyState icon="vault" title={t('vault.empty.title')} description={t('vault.empty.body')}>
        {vault.canEdit ? (
          <>
            <Button variant="pri" size="sm" onClick={onNew}>
              <Icon name="plus" size={16} />
              {t('vault.newItem.button')}
            </Button>
            <Button variant="out" size="sm" asChild>
              <Link to="/vault/import">{t('vault.import.fromBitwarden')}</Link>
            </Button>
          </>
        ) : null}
      </EmptyState>
      <div className="grid w-full gap-3 text-left sm:grid-cols-2">
        <Link
          to="/vault/settings"
          className="flex items-start gap-3 rounded-xl p-4 shadow-line hover:bg-bg2"
        >
          <Icon name="finger" size={18} />
          <span className="flex flex-col">
            <span className="text-sm font-semibold">{t('vault.empty.passkeyTitle')}</span>
            <span className="text-xs text-fg2">{t('vault.empty.passkeyBody')}</span>
          </span>
        </Link>
        <div className="flex items-start gap-3 rounded-xl p-4 shadow-line">
          <Icon name="users" size={18} />
          <span className="flex flex-col">
            <span className="text-sm font-semibold">{t('vault.empty.spaceTitle')}</span>
            <span className="text-xs text-fg2">{t('vault.empty.spaceBody')}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Unknown vault id, or keys exist but this org has no personal vault yet. */
function NoVault({ vaults }: { vaults: Vault[] }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const hasPersonal = vaults.some((v) => v.kind === 'personal');
  return (
    <Workspace sidebar={<VaultSidebar vaults={vaults} />} crumbs={[{ label: t('vault.title') }]}>
      <EmptyState
        className="m-auto"
        icon="vault"
        title={hasPersonal ? t('vault.notFound') : t('vault.noPersonal')}
      >
        {!hasPersonal ? (
          <Button
            variant="pri"
            size="sm"
            onClick={() =>
              void createPersonalVault()
                .then((v) => {
                  invalidateVault(qc);
                  void navigate({
                    to: '/vault/$vaultId/$category',
                    params: { vaultId: v.id, category: 'all' },
                  });
                })
                .catch((e: unknown) => setError(errorMessage(e, t)))
            }
          >
            {t('vault.createPersonal')}
          </Button>
        ) : null}
      </EmptyState>
      {error ? (
        <p role="alert" className="text-center text-sm text-danger">
          {error}
        </p>
      ) : null}
    </Workspace>
  );
}
