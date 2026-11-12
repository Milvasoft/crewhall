import { canCreateSpaceVault, type Vault } from '@crewhall/shared';
import {
  Button,
  cn,
  Count,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Kbd,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SpaceDot,
  Tooltip,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n, type I18nValue } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { createSpaceVault, invalidateVault } from '@/lib/vault/api';
import { useMinutesLeft } from '@/lib/vault/autolock';
import { CATEGORIES, CATEGORY_ICON, type Category } from '@/lib/vault/items';
import { lock } from '@/lib/vault/session';
import { errorMessage } from './errors';
import { VaultSearchResults } from './VaultSearch';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

export function vaultName(v: Pick<Vault, 'kind' | 'name'>, t: I18nValue['t']): string {
  return v.kind === 'personal' ? t('vault.personal') : (v.name ?? '');
}

/**
 * Vault sidebar (design 8.4): vault and category filters work together; the bottom has the
 * health report and the lock button.
 */
export function VaultSidebar({
  vaults,
  active,
  category,
  counts,
  tags,
  tag,
  healthCount,
}: {
  vaults: Vault[];
  active?: string;
  category?: Category;
  counts?: Partial<Record<Category, number>>;
  /** Tags of the active vault with item counts; the chosen one filters the list. */
  tags?: [string, number][];
  tag?: string | null;
  healthCount?: number;
}) {
  const tagSearch: Record<string, string> = tag ? { tag } : {};
  const { t } = useI18n();
  const minutes = useMinutesLeft();
  const [creating, setCreating] = useState(false);
  const spaces = useSpaces();
  const canCreate = spaces.items.some((s) => s.kind === 'shared' && canCreateSpaceVault(s.myRole));
  const [term, setTerm] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const searching = term.trim().length > 0;
  const q = term.trim().toLocaleLowerCase('tr-TR');
  const shown = searching
    ? vaults.filter((v) => vaultName(v, t).toLocaleLowerCase('tr-TR').includes(q))
    : vaults;

  // Ctrl K on vault pages searches the vaults; pressed again in the box, it opens the app-wide
  // palette as everywhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
      if (document.activeElement === searchRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <ModuleSidebar label={t('vault.sidebar')} className="gap-px overflow-hidden px-2.5 py-3">
      <div className="mb-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
        <span className="flex size-9 items-center justify-center rounded-md bg-bg2">
          <Icon name="vault" size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{t('vault.title')}</span>
          <span className="truncate text-xs text-fg3">
            {minutes !== null ? t('vault.openFor', { minutes }) : t('vault.locked')}
          </span>
        </div>
        <Tooltip content={t('vault.lockNow')}>
          <IconButton
            aria-label={t('vault.lockNow')}
            tone="plain"
            size="sm"
            onClick={() => lock('manual')}
          >
            <Icon name="lock" size={16} />
          </IconButton>
        </Tooltip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        <Input
          ref={searchRef}
          icon="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && term) {
              e.stopPropagation();
              setTerm('');
            }
          }}
          placeholder={t('vault.searchAll.placeholder')}
          aria-label={t('vault.searchAll.placeholder')}
          trailing={<Kbd>Ctrl K</Kbd>}
          containerClassName="mx-0.5 mb-2 h-9"
        />
        <div className="mt-1 mb-1 flex items-center justify-between px-2.5">
          <span className="eyebrow">{t('vault.vaults')}</span>
          {canCreate ? (
            <Tooltip content={t('vault.newVault.title')}>
              <IconButton
                aria-label={t('vault.newVault.title')}
                tone="plain"
                size="xs"
                onClick={() => setCreating(true)}
              >
                <Icon name="plus" size={14} />
              </IconButton>
            </Tooltip>
          ) : null}
        </div>
        {shown.map((v) => (
          <SideLink
            key={v.id}
            to="/vault/$vaultId/$category"
            params={{ vaultId: v.id, category: category ?? 'all' }}
            active={v.id === active}
            icon={
              v.space ? (
                <SpaceDot color={v.space.color} className="mx-1" />
              ) : (
                <Icon name="user" size={16} />
              )
            }
            label={vaultName(v, t)}
            count={v.itemCount}
            warn={v.staleMemberCount > 0 && v.canManage}
          />
        ))}
        {searching ? (
          <>
            <span className="eyebrow mt-4 mb-1 px-2.5">{t('vault.searchAll.items')}</span>
            <VaultSearchResults vaults={vaults} term={term} onPick={() => setTerm('')} />
          </>
        ) : active ? (
          <>
            <span className="eyebrow mt-4 mb-1 px-2.5">{t('vault.categories')}</span>
            {CATEGORIES.map((c) => (
              <SideLink
                key={c}
                to="/vault/$vaultId/$category"
                params={{ vaultId: active, category: c }}
                search={tagSearch}
                active={c === category}
                icon={<Icon name={CATEGORY_ICON[c]} size={16} />}
                label={t(`vault.category.${c}`)}
                count={counts?.[c] || undefined}
              />
            ))}
            {tags?.length ? (
              <>
                <span className="eyebrow mt-4 mb-1 px-2.5">{t('vault.tags')}</span>
                {tags.map(([name, count]) => (
                  <SideLink
                    key={name}
                    to="/vault/$vaultId/$category"
                    params={{ vaultId: active, category: category ?? 'all' }}
                    search={name === tag ? {} : { tag: name }}
                    active={name === tag}
                    icon={<Icon name="hash" size={16} />}
                    label={name}
                    count={count}
                  />
                ))}
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="mt-auto flex shrink-0 flex-col gap-px border-t border-line pt-2">
        <SideLink
          to="/vault/settings"
          icon={<Icon name="settings" size={16} />}
          label={t('vault.settings.title')}
        />
        <SideLink
          to="/vault/health"
          icon={<Icon name="shield" size={16} />}
          label={t('vault.health.title')}
          count={healthCount ? <Count tone="accent">{healthCount}</Count> : undefined}
        />
        <button
          type="button"
          onClick={() => lock('manual')}
          className="flex h-[var(--nv-h)] items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg"
        >
          <Icon name="lock" size={16} />
          <span className="flex-1 text-left">{t('vault.lockNow')}</span>
          <Kbd>Ctrl L</Kbd>
        </button>
      </div>
      <NewVaultDialog open={creating} onOpenChange={setCreating} />
    </ModuleSidebar>
  );
}

function SideLink({
  to,
  params,
  search,
  active,
  icon,
  label,
  count,
  warn,
}: {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  active?: boolean;
  icon: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  warn?: boolean;
}) {
  return (
    <Link
      to={to}
      params={params}
      search={search}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium whitespace-nowrap text-fg2 hover:bg-bg2 hover:text-fg',
        active && 'bg-capsule font-semibold text-fg hover:bg-capsule',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {warn ? <Icon name="alert" size={14} className="text-warning" /> : null}
      {count !== undefined ? (
        <span className="text-xs font-medium text-fg3 tn">{count}</span>
      ) : null}
    </Link>
  );
}

/** Space vault (design 8.17): the key is made on this device and sealed to its creator. */
export function NewVaultDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const spaces = useSpaces();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const options = spaces.items.filter((s) => s.kind === 'shared' && canCreateSpaceVault(s.myRole));
  const [spaceId, setSpaceId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const space = options.find((s) => s.id === spaceId);

  const submit = async () => {
    if (!space) return;
    setBusy(true);
    setError(null);
    try {
      const v = await createSpaceVault(space.id, name.trim() || space.name);
      invalidateVault(qc);
      onOpenChange(false);
      setSpaceId('');
      setName('');
      void navigate({
        to: '/vault/$vaultId/$category',
        params: { vaultId: v.id, category: 'all' },
      });
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={440}>
        <DialogHeader
          icon="vault"
          title={t('vault.newVault.title')}
          description={t('vault.newVault.body')}
        />
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t('vault.newVault.space')}>
            <Select value={spaceId} onValueChange={setSpaceId}>
              <SelectTrigger>
                <SelectValue placeholder={t('vault.newVault.pickSpace')} />
              </SelectTrigger>
              <SelectContent>
                {options.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('vault.newVault.name')}>
            <Input
              value={name}
              placeholder={space?.name ?? ''}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="gh" onClick={() => onOpenChange(false)}>
              {t('vault.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={busy} disabled={!space}>
              {t('vault.newVault.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
