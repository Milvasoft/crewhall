import { wrapVaultKey } from '@crewhall/crypto';
import {
  type Vault,
  type VaultCandidate,
  type VaultMember,
  type VaultRole,
} from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Progress,
  Segmented,
  Spinner,
  Table,
  Td,
  Th,
  Tooltip,
  Tr,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/identity/parts';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  acceptSettingsAsTheyAre,
  invalidateVault,
  membersQuery,
  refreshSettings,
  vaultKeys,
  vaultsQuery,
} from '@/lib/vault/api';
import { useVaultItems } from '@/lib/vault/items';
import {
  KeysToConfirmError,
  rotateVault,
  RotationBlockedError,
  type BlockedRevision,
  type KeyToConfirm,
} from '@/lib/vault/rotation';
import { requireUnlocked, useVaultSession, vaultKeyFor } from '@/lib/vault/session';
import { pin, shortFingerprint, trustOf, type Trust } from '@/lib/vault/tofu';
import { errorMessage } from './errors';
import { useHealthCount } from './VaultMain';
import { vaultName, VaultSidebar } from './VaultSidebar';

const ROLES: VaultRole[] = ['read', 'edit', 'manage'];

/** Space vault access (design 8.10): who holds the key, with what permission. */
export function AccessPage({ vaultId }: { vaultId: string }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { unlocked } = useVaultSession();
  const vaults = useQuery(vaultsQuery);
  const list = vaults.data ?? [];
  const vault = list.find((v) => v.id === vaultId);
  const members = useQuery({ ...membersQuery(vaultId), enabled: Boolean(vault) });
  const healthCount = useHealthCount(list);
  const [granting, setGranting] = useState(false);
  const [removing, setRemoving] = useState<VaultMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settingsState = unlocked?.settingsState;

  if (!vault) {
    return (
      <Workspace
        sidebar={<VaultSidebar vaults={list} healthCount={healthCount} />}
        crumbs={[{ label: t('vault.title') }]}
      >
        {vaults.isPending ? (
          <Spinner className="m-auto" />
        ) : (
          <EmptyState className="m-auto" icon="vault" title={t('vault.notFound')} />
        )}
      </Workspace>
    );
  }
  // Not me: the device that rotates knows the new key, so another manager has to remove me.
  const stale = (members.data ?? []).filter(
    (m) => m.spaceRole === null && m.user.id !== unlocked?.userId,
  );

  const setRole = async (m: VaultMember, role: VaultRole) => {
    setError(null);
    try {
      await api.call('vaultUpdateMember', {
        params: { vaultId, userId: m.user.id },
        body: { role },
      });
      void qc.invalidateQueries({ queryKey: vaultKeys.members(vaultId) });
      invalidateVault(qc);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  };

  return (
    <Workspace
      sidebar={<VaultSidebar vaults={list} active={vault.id} healthCount={healthCount} />}
      crumbs={[{ label: vaultName(vault, t) }, { label: t('vault.access.title') }]}
      tools={
        vault.canManage ? (
          <Button size="sm" variant="pri" onClick={() => setGranting(true)}>
            <Icon name="userPlus" size={16} />
            {t('vault.access.grant')}
          </Button>
        ) : null
      }
    >
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-lg bg-bg2">
          <Icon name="vault" size={20} />
        </span>
        <div className="flex flex-col">
          <h1 className="text-h font-semibold">
            {t('vault.access.vaultTitle', { name: vaultName(vault, t) })}
          </h1>
          <span className="text-sm text-fg2">
            {t('vault.access.summary', {
              items: vault.itemCount,
              people: vault.memberCount,
              date: formatDateLong(vault.createdAt, locale),
            })}
          </span>
        </div>
      </div>
      <nav className="flex gap-1 border-b border-line text-sm">
        <Link
          to="/vault/$vaultId/$category"
          params={{ vaultId, category: 'all' }}
          className="px-3 py-2 text-fg2 hover:text-fg"
        >
          {t('vault.access.tabItems')}
        </Link>
        <span aria-current="page" className="border-b-2 border-accent px-3 py-2 font-semibold">
          {t('vault.access.tabAccess', { count: vault.memberCount })}
        </span>
        {vault.myRole === 'manage' ? (
          <Link to="/vault/log" search={{ vaultId }} className="px-3 py-2 text-fg2 hover:text-fg">
            {t('vault.log.short')}
          </Link>
        ) : null}
      </nav>

      {settingsState && settingsState !== 'ok' ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-4"
        >
          <Icon name="alert" size={18} className="mt-0.5 text-warning" />
          <span className="flex-1 text-sm text-fg2">
            {t(
              settingsState === 'rolled_back'
                ? 'vault.access.settingsRolledBack'
                : 'vault.access.settingsUnreadable',
            )}
          </span>
          <Button
            size="sm"
            variant="out"
            onClick={() =>
              void acceptSettingsAsTheyAre().catch((e: unknown) => setError(errorMessage(e, t)))
            }
          >
            {t('vault.access.settingsAccept')}
          </Button>
        </div>
      ) : null}

      {stale.length && vault.canManage ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] p-4"
        >
          <Icon name="alert" size={18} className="mt-0.5 text-warning" />
          <div className="flex flex-1 flex-col gap-1 text-sm">
            <span className="font-semibold">
              {t('vault.access.staleTitle', { count: stale.length })}
            </span>
            <span className="text-fg2">
              {t('vault.access.staleBody', { names: stale.map((m) => m.user.name).join(', ') })}
            </span>
          </div>
          <Button size="sm" variant="out" onClick={() => setRemoving(stale)}>
            {t('vault.access.removeAndRotate')}
          </Button>
        </div>
      ) : null}

      {members.isPending ? <Spinner className="mx-auto" /> : null}
      {members.data ? (
        <Table>
          <thead>
            <tr>
              <Th>{t('vault.access.person')}</Th>
              <Th>{t('vault.access.spaceRole')}</Th>
              <Th>{t('vault.access.permission')}</Th>
              <Th className="w-12" />
            </tr>
          </thead>
          <tbody>
            {members.data.map((m) => {
              const me = m.user.id === unlocked?.userId;
              const trust = me ? 'pinned' : trustOf(m.user.id, m.publicKey, m.fingerprint);
              return (
                <Tr key={m.user.id}>
                  <Td>
                    <span className="flex items-center gap-3">
                      <Avatar name={m.user.name} src={m.user.imageUrl} size="md" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-semibold">
                          {m.user.name}
                          {me ? (
                            <span className="font-normal text-fg3"> · {t('vault.access.you')}</span>
                          ) : null}
                        </span>
                        <FingerprintLine fp={m.fingerprint} trust={trust} />
                      </span>
                    </span>
                  </Td>
                  <Td>
                    {m.spaceRole ? (
                      <span className="text-sm">{t(`common.roles.space.${m.spaceRole}`)}</span>
                    ) : (
                      <Badge tone="warn">{t('vault.access.noSpace')}</Badge>
                    )}
                  </Td>
                  <Td>
                    {vault.canManage ? (
                      <Segmented
                        size="sm"
                        aria-label={t('vault.access.permission')}
                        value={m.role}
                        onValueChange={(r) => void setRole(m, r)}
                        options={ROLES.map((r) => ({ value: r, label: t(`vault.role.${r}`) }))}
                      />
                    ) : (
                      <span className="text-sm">{t(`vault.role.${m.role}`)}</span>
                    )}
                  </Td>
                  <Td>
                    {vault.canManage && !me ? (
                      <Tooltip content={t('vault.access.remove')}>
                        <IconButton
                          aria-label={`${t('vault.access.remove')}: ${m.user.name}`}
                          tone="plain"
                          size="sm"
                          onClick={() => setRemoving([m])}
                        >
                          <Icon name="x" size={16} />
                        </IconButton>
                      </Tooltip>
                    ) : null}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        {ROLES.map((r) => (
          <div key={r} className="flex flex-col gap-1 rounded-xl p-4 shadow-line">
            <span className="text-sm font-semibold">{t(`vault.role.${r}`)}</span>
            <span className="text-xs text-fg2">{t(`vault.roleHint.${r}`)}</span>
          </div>
        ))}
      </div>
      <p className="flex items-start gap-2 text-sm text-fg2">
        <Icon name="refresh" size={15} className="mt-0.5 shrink-0" />
        {t('vault.access.rotationNote', { count: vault.itemCount })}
      </p>
      {vault.canManage ? (
        <p className="flex items-start gap-2 text-sm text-fg2">
          <Icon name="info" size={15} className="mt-0.5 shrink-0" />
          {t('vault.access.selfRemoveNote')}
        </p>
      ) : null}
      <p className="flex items-start gap-2 text-sm text-fg2">
        <Icon name="info" size={15} className="mt-0.5 shrink-0" />
        {t('vault.access.twoManagers')}
      </p>

      {vault.canManage ? (
        <GrantDialog open={granting} onOpenChange={setGranting} vault={vault} />
      ) : null}
      {removing ? (
        <RemoveDialog
          vault={vault}
          members={removing}
          listed={members.data ?? []}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </Workspace>
  );
}

function FingerprintLine({ fp, trust }: { fp: string | null; trust: Trust | null }) {
  const { t } = useI18n();
  if (!fp) return <span className="text-xs text-fg3">{t('vault.access.noKeys')}</span>;
  return (
    <span
      className={cn(
        'flex items-center gap-1 font-mono text-xs',
        trust === 'changed' || trust === 'invalid'
          ? 'text-danger'
          : trust === 'unverified'
            ? 'text-warning'
            : 'text-fg3',
      )}
    >
      X25519 · {shortFingerprint(fp)}
      {trust === 'changed' ? (
        <Tooltip content={t('vault.tofu.changed')}>
          <Icon name="alert" size={12} />
        </Tooltip>
      ) : trust === 'invalid' ? (
        <Tooltip content={t('vault.tofu.invalid')}>
          <Icon name="alert" size={12} />
        </Tooltip>
      ) : trust === 'unverified' ? (
        <Tooltip content={t('vault.tofu.unverified')}>
          <Icon name="alert" size={12} />
        </Tooltip>
      ) : trust === 'pinned' ? (
        <Tooltip content={t('vault.tofu.pinned')}>
          <Icon name="check" size={12} className="text-success" />
        </Tooltip>
      ) : null}
    </span>
  );
}

/** Seals the vault key to the chosen person's public key on this device (design 8.10). */
function GrantDialog({
  open,
  onOpenChange,
  vault,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  vault: Vault;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<VaultCandidate | null>(null);
  const [role, setRole] = useState<VaultRole>('read');
  const [acceptChanged, setAcceptChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = useQuery({
    queryKey: vaultKeys.candidates(vault.id, q),
    queryFn: async () =>
      (await api.call('vaultCandidates', { params: { vaultId: vault.id }, query: { q } })).items,
    enabled: open,
  });
  const trust =
    picked?.publicKey && picked.fingerprint
      ? trustOf(picked.user.id, picked.publicKey, picked.fingerprint)
      : null;

  const close = () => {
    onOpenChange(false);
    setPicked(null);
    setQ('');
    setRole('read');
    setAcceptChanged(false);
    setError(null);
  };

  const grant = async () => {
    if (!picked?.publicKey) return;
    setBusy(true);
    setError(null);
    try {
      requireUnlocked();
      // Another device may have pinned this person since this unlock: then the dialog asks.
      await refreshSettings();
      const now = trustOf(picked.user.id, picked.publicKey, picked.fingerprint ?? '');
      if ((now === 'changed' || now === 'unverified') && !acceptChanged) return;
      const key = vaultKeyFor(vault);
      const wrappedKey = wrapVaultKey(key, picked.publicKey, {
        vaultId: vault.id,
        keyVersion: vault.keyVersion,
        userId: picked.user.id,
      });
      await api.call('vaultGrant', {
        params: { vaultId: vault.id },
        body: { userId: picked.user.id, role, keyVersion: vault.keyVersion, wrappedKey },
      });
      await pin(picked.user.id, picked.publicKey).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: vaultKeys.members(vault.id) });
      invalidateVault(qc);
      close();
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent width={520}>
        <DialogHeader
          icon="userPlus"
          title={t('vault.access.grant')}
          description={t('vault.access.grantBody', { vault: vaultName(vault, t) })}
        />
        <Input
          icon="search"
          autoFocus
          value={q}
          placeholder={t('vault.access.searchPeople')}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="flex max-h-[220px] flex-col overflow-y-auto">
          {candidates.isPending ? <Spinner className="mx-auto my-3" /> : null}
          {candidates.data?.map((c) => {
            const disabled = !c.publicKey;
            return (
              <li key={c.user.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setPicked(c);
                    setAcceptChanged(false);
                  }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-bg2 disabled:cursor-not-allowed disabled:opacity-50',
                    picked?.user.id === c.user.id && 'bg-capsule',
                  )}
                >
                  <Avatar name={c.user.name} src={c.user.imageUrl} size="md" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">{c.user.name}</span>
                    <span className="truncate text-xs text-fg3">
                      {disabled
                        ? t('vault.access.notSetUp')
                        : c.spaceRole
                          ? t(`common.roles.space.${c.spaceRole}`)
                          : t('vault.access.notInSpace')}
                    </span>
                  </span>
                  {picked?.user.id === c.user.id ? (
                    <Icon name="checkC" size={16} className="text-success" />
                  ) : null}
                </button>
              </li>
            );
          })}
          {candidates.data && !candidates.data.length ? (
            <li className="py-3 text-center text-sm text-fg3">{t('vault.access.noCandidates')}</li>
          ) : null}
        </ul>
        {picked ? (
          <div className="flex flex-col gap-3 rounded-xl bg-bg2/60 p-4 shadow-line">
            {!picked.spaceRole ? (
              <p className="flex items-start gap-2 text-sm text-fg2">
                <Icon name="info" size={15} className="mt-0.5 shrink-0" />
                {t('vault.access.willJoinSpace', {
                  name: picked.user.name,
                  space: vault.space?.name ?? '',
                })}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">{t('vault.access.permission')}</span>
              <Segmented
                size="sm"
                aria-label={t('vault.access.permission')}
                value={role}
                onValueChange={setRole}
                options={ROLES.map((r) => ({ value: r, label: t(`vault.role.${r}`) }))}
              />
            </div>
            <ol className="flex flex-col gap-1.5 text-sm text-fg2">
              <li>
                1. {t('vault.access.step1', { name: picked.user.name })}{' '}
                <b className="font-mono text-fg">
                  {picked.fingerprint ? shortFingerprint(picked.fingerprint, 4) : ''}
                </b>
              </li>
              <li>2. {t('vault.access.step2', { vault: vaultName(vault, t) })}</li>
              <li>3. {t('vault.access.step3')}</li>
            </ol>
            {trust === 'changed' || trust === 'unverified' ? (
              <label
                role="alert"
                className="flex items-start gap-2 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-sm"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={acceptChanged}
                  onChange={(e) => setAcceptChanged(e.target.checked)}
                />
                <span>{t(`vault.tofu.${trust}Confirm`, { name: picked.user.name })}</span>
              </label>
            ) : trust === 'invalid' ? (
              <p role="alert" className="text-sm text-danger">
                {t('vault.tofu.invalid')}
              </p>
            ) : (
              <p className="text-xs text-fg3">
                {t('vault.access.compareHint', { name: picked.user.name })}
              </p>
            )}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={close}>
            {t('vault.cancel')}
          </Button>
          <Button
            variant="pri"
            loading={busy}
            disabled={
              !picked?.publicKey ||
              trust === 'invalid' ||
              ((trust === 'changed' || trust === 'unverified') && !acceptChanged)
            }
            onClick={() => void grant()}
          >
            {t('vault.access.grant')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Removing access rotates the vault key (doc 17 §7) and then lists the items the removed person
 * could have seen, suggesting new passwords.
 */
function RemoveDialog({
  vault,
  members,
  listed,
  onClose,
}: {
  vault: Vault;
  members: VaultMember[];
  /** Everyone on the page the person decided from. */
  listed: VaultMember[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { items } = useVaultItems(vault);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toConfirm, setToConfirm] = useState<KeyToConfirm[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [blocked, setBlocked] = useState<BlockedRevision[]>([]);
  const [deleting, setDeleting] = useState<BlockedRevision | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const itemName = (itemId: string) =>
    items.find((d) => d.item.id === itemId)?.summary?.name ?? t('vault.rotate.unnamedItem');
  const deleteRevision = async (b: BlockedRevision) => {
    setDeletePending(true);
    setError(null);
    try {
      await api.call('vaultDeleteItemRevision', {
        params: { itemId: b.itemId, revision: String(b.revision) },
      });
      setBlocked((list) => list.filter((x) => x !== b));
      invalidateVault(qc, vault.id);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setDeletePending(false);
      setDeleting(null);
    }
  };
  const names = members.map((m) => m.user.name).join(', ');
  const exposed = items.filter(
    (d) =>
      d.summary &&
      !d.item.deletedAt &&
      (d.item.type === 'login' || d.item.type === 'api_key' || d.item.type === 'ssh_key'),
  );

  const run = async () => {
    setError(null);
    setProgress({ done: 0, total: vault.itemCount });
    try {
      await rotateVault(
        vault.id,
        members.map((m) => m.user.id),
        {
          seen: listed,
          accepted: confirmed
            ? Object.fromEntries(toConfirm.map((p) => [p.userId, p.fingerprint]))
            : {},
          onProgress: (done, total) => setProgress({ done, total }),
        },
      );
      setFinished(true);
      invalidateVault(qc, vault.id);
      void qc.invalidateQueries({ queryKey: vaultKeys.members(vault.id) });
    } catch (e) {
      setProgress(null);
      if (e instanceof KeysToConfirmError) {
        setToConfirm(e.people);
        setConfirmed(false);
      } else if (e instanceof RotationBlockedError) {
        setBlocked(e.blocked);
      } else if (e instanceof Error && e.message === 'fingerprint_mismatch') {
        setError(t('vault.tofu.invalid'));
      } else {
        setError(errorMessage(e, t));
      }
    }
  };

  return (
    <Dialog open onOpenChange={(v) => (!v && !progress ? onClose() : undefined)}>
      <DialogContent width={520}>
        <DialogHeader
          icon="refresh"
          title={finished ? t('vault.rotate.doneTitle') : t('vault.rotate.title', { names })}
          description={
            finished
              ? t('vault.rotate.doneBody', { names })
              : t('vault.rotate.body', { count: vault.itemCount })
          }
        />
        {progress && !finished ? (
          <div className="flex flex-col gap-2">
            <Progress
              value={progress.total ? (progress.done / progress.total) * 100 : 100}
              label={t('vault.rotate.progress')}
            />
            <span className="text-xs text-fg3 tn">
              {t('vault.rotate.progressText', { done: progress.done, total: progress.total })}
            </span>
          </div>
        ) : null}
        {toConfirm.length && !finished ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-sm"
          >
            <span className="font-semibold">{t('vault.rotate.confirmKeysTitle')}</span>
            <ul className="flex flex-col gap-1">
              {toConfirm.map((p) => (
                <li key={p.userId} className="flex flex-col">
                  <span>
                    {p.name} · {t(`vault.rotate.why.${p.why}`)}
                  </span>
                  <span className="font-mono text-xs text-fg3">
                    X25519 · {shortFingerprint(p.fingerprint)}
                  </span>
                </li>
              ))}
            </ul>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{t('vault.rotate.confirmKeys')}</span>
            </label>
          </div>
        ) : null}
        {blocked.length && !finished ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-sm"
          >
            <span className="font-semibold">{t('vault.rotate.blockedTitle')}</span>
            <span className="text-fg2">{t('vault.rotate.blockedBody')}</span>
            <ul className="flex flex-col gap-1">
              {blocked.map((b) => (
                <li key={`${b.itemId}:${b.revision}`} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">
                    {itemName(b.itemId)} ·{' '}
                    {t(b.current ? 'vault.rotate.blockedCurrent' : 'vault.rotate.blockedRevision', {
                      revision: b.revision,
                    })}
                  </span>
                  {b.current ? null : (
                    <Button size="sm" variant="out" onClick={() => setDeleting(b)}>
                      {t('vault.rotate.deleteRevision')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <ConfirmDialog
          open={Boolean(deleting)}
          onOpenChange={(o) => (!o ? setDeleting(null) : undefined)}
          title={t('vault.rotate.deleteRevisionTitle', {
            name: deleting ? itemName(deleting.itemId) : '',
            revision: deleting?.revision ?? 0,
          })}
          body={t('vault.rotate.deleteRevisionBody')}
          confirm={t('vault.rotate.deleteRevisionConfirm')}
          pending={deletePending}
          onConfirm={() => deleting && void deleteRevision(deleting)}
        />
        {finished && exposed.length ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">
              {t('vault.rotate.suggest', { count: exposed.length })}
            </span>
            <ul className="flex max-h-[200px] flex-col overflow-y-auto rounded-lg shadow-line">
              {exposed.map((d) => (
                <li
                  key={d.item.id}
                  className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-sm last:border-0"
                >
                  <span className="truncate">{d.summary!.name}</span>
                  <Link
                    to="/vault/$vaultId/$category"
                    params={{ vaultId: vault.id, category: 'all' }}
                    search={{ item: d.item.id, edit: true }}
                    className="shrink-0 text-xs font-semibold text-fg2 hover:text-fg"
                    onClick={onClose}
                  >
                    {t('vault.rotate.change')}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {finished ? (
            <Button variant="pri" onClick={onClose}>
              {t('vault.done')}
            </Button>
          ) : (
            <>
              <Button variant="gh" onClick={onClose} disabled={Boolean(progress)}>
                {t('vault.cancel')}
              </Button>
              <Button
                variant="dngf"
                loading={Boolean(progress)}
                disabled={(toConfirm.length > 0 && !confirmed) || blocked.length > 0}
                onClick={() => void run()}
              >
                {t('vault.rotate.confirm')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
