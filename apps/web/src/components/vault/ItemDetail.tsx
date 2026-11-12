import {
  decryptItem,
  totpSourceOf,
  type AttachmentRef,
  type ItemPayload,
  type ItemType,
} from '@crewhall/crypto';
import { TRASH_RETENTION_DAYS, type Vault, type VaultItemRevision } from '@crewhall/shared';
import {
  Avatar,
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  Tag,
  Tooltip,
} from '@crewhall/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { formatBytes, formatDate, formatDateLong, formatTime } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { useNow } from '@/lib/useNow';
import { invalidateVault, revisionsQuery, saveItem } from '@/lib/vault/api';
import { attachmentBlobUrl, downloadAttachment } from '@/lib/vault/attachments';
import { canView, openViewer } from '@/lib/viewer';
import {
  expiryBadge,
  initialsOf,
  payloadOf,
  safeHref,
  TYPE_ICON,
  type DecryptedItem,
} from '@/lib/vault/items';
import { vaultKeyFor } from '@/lib/vault/session';
import { BreachBadge } from './breach';
import { errorMessage } from './errors';
import {
  FieldGroup,
  FieldRow,
  SecretRow,
  SectionTitle,
  TextRow,
  TotpRow,
  type AccessRef,
} from './fields';
import { ShareDialog } from './ShareDialog';
import { StrengthBadge } from './strength';
import { vaultName } from './VaultSidebar';

export function ItemAvatar({
  name,
  type,
  size = 'md',
}: {
  name: string | null;
  type: ItemType;
  size?: 'sm' | 'md' | 'lg';
}) {
  const s =
    size === 'lg'
      ? 'size-11 rounded-lg text-[15px]'
      : size === 'sm'
        ? 'size-7 rounded-md text-[11px]'
        : 'size-9 rounded-md text-[12.5px]';
  if (type === 'login' && name) {
    return (
      <span className={cn('flex shrink-0 items-center justify-center bg-bg2 font-bold text-fg', s)}>
        {initialsOf(name)}
      </span>
    );
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center bg-bg2 text-fg', s)}>
      <Icon name={TYPE_ICON[type]} size={size === 'lg' ? 20 : size === 'sm' ? 14 : 17} />
    </span>
  );
}

/** Item detail (design 8.4, 8.5, 8.18). */
export function ItemDetail({
  d,
  onEdit,
  onMove,
  onTag,
}: {
  d: DecryptedItem;
  onEdit: () => void;
  onMove: () => void;
  /** Filters the list by a tag of this item. */
  onTag?: (tag: string) => void;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const [history, setHistory] = useState(false);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(60_000);
  const me = useMe();
  const { item, vault } = d;
  // Decrypted here, for the opened item only (cached per revision).
  const p = useMemo(() => payloadOf(d), [d]);
  const access: AccessRef = { vaultId: vault.id, itemId: item.id };
  const trashed = item.deletedAt !== null;

  if (!p) {
    return (
      <EmptyState
        className="m-auto"
        icon="alert"
        title={t(d.error === 'rollback' ? 'vault.detail.rollback' : 'vault.detail.tampered')}
        description={t('vault.detail.tamperedBody')}
      />
    );
  }

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      invalidateVault(qc, vault.id);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const toggleFavorite = () => act(() => saveItem(vault, item, { ...p, favorite: !p.favorite }));
  const trashDays = me?.trashRetentionDays ?? TRASH_RETENTION_DAYS;
  const badge = expiryBadge(d.summary ?? { expiresAt: null }, new Date(now));
  const purgeAt = item.deletedAt
    ? new Date(Date.parse(item.deletedAt) + trashDays * 86_400_000)
    : null;
  const purgeDays = purgeAt ? Math.max(0, Math.ceil((purgeAt.getTime() - now) / 86_400_000)) : 0;
  // A TOTP kept in a custom field (imports, non-login items) gets the live code too.
  const totp = totpSourceOf(p);

  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 py-6" aria-label={p.name}>
      <header className="flex items-start gap-3">
        <ItemAvatar name={p?.name ?? null} type={item.type} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="flex items-center gap-2 text-h font-semibold break-words">
            {p.name}
            {p.env ? <Tag tone={p.env}>{t(`vault.env.${p.env}`)}</Tag> : null}
          </h2>
          <span className="text-sm text-fg2">
            {t('vault.detail.subtitle', {
              vault: vaultName(vault, t),
              type: t(`vault.type.${item.type}`),
            })}
            {trashed ? ` · ${t('vault.detail.inTrash')}` : ''}
          </span>
          {p.tags.length ? (
            <span className="mt-1 flex flex-wrap gap-1" aria-label={t('vault.tags')}>
              {p.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => onTag?.(tag)}
                  className="rounded-full focus-visible:outline-2"
                >
                  <Tag className="hover:text-fg">#{tag}</Tag>
                </button>
              ))}
            </span>
          ) : null}
        </div>
        {!trashed && vault.canEdit ? (
          <>
            <Tooltip
              content={p.favorite ? t('vault.detail.unfavorite') : t('vault.detail.favorite')}
            >
              <IconButton
                aria-label={t('vault.detail.favorite')}
                aria-pressed={p.favorite}
                tone="plain"
                size="sm"
                disabled={busy}
                onClick={() => void toggleFavorite()}
              >
                <Icon
                  name="star"
                  size={18}
                  className={p.favorite ? 'fill-accent text-accent' : undefined}
                />
              </IconButton>
            </Tooltip>
            <Button size="sm" variant="out" onClick={onEdit}>
              <Icon name="edit" size={15} />
              {t('vault.edit')}
            </Button>
          </>
        ) : null}
        {trashed ? (
          <>
            {vault.canEdit ? (
              <Button
                size="sm"
                variant="out"
                loading={busy}
                onClick={() =>
                  void act(() => api.call('vaultRestoreItem', { params: { itemId: item.id } }))
                }
              >
                <Icon name="undo" size={15} />
                {t('vault.trash.restore')}
              </Button>
            ) : null}
            {vault.myRole === 'manage' ? (
              <Button
                size="sm"
                variant="dng"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('vault.trash.purgeConfirm', { name: p.name }))) {
                    void act(() => api.call('vaultPurgeItem', { params: { itemId: item.id } }));
                  }
                }}
              >
                <Icon name="trash" size={15} />
                {t('vault.trash.purge')}
              </Button>
            ) : null}
          </>
        ) : (
          <Menu>
            <MenuTrigger asChild>
              <IconButton aria-label={t('vault.detail.more')} tone="plain" size="sm">
                <Icon name="dots" size={18} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon="history" onSelect={() => setHistory(true)}>
                {t('vault.history.open')}
              </MenuItem>
              {vault.canEdit ? (
                <>
                  {/* Share links follow the edit rule (canVault 'vault.share_link'). */}
                  <MenuItem icon="link" onSelect={() => setShare(true)}>
                    {t('vault.share.open')}
                  </MenuItem>
                  <MenuItem icon="arrowR" onSelect={onMove}>
                    {t('vault.detail.move')}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon="trash"
                    danger
                    onSelect={() =>
                      void act(() => api.call('vaultTrashItem', { params: { itemId: item.id } }))
                    }
                  >
                    {t('vault.detail.trash')}
                  </MenuItem>
                </>
              ) : null}
            </MenuContent>
          </Menu>
        )}
      </header>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {trashed && purgeAt ? (
        <Banner tone={purgeDays < 7 ? 'danger' : 'warn'} icon="trash">
          {t('vault.trash.banner', {
            date: formatDateLong(purgeAt, locale),
            days: purgeDays,
            who: item.deletedBy?.name ?? '—',
          })}
        </Banner>
      ) : badge !== null ? (
        <Banner tone={badge < 0 ? 'danger' : 'warn'} icon="alert">
          {badge < 0 ? t('vault.detail.expired') : t('vault.detail.expiresIn', { days: badge })}
        </Banner>
      ) : null}
      {p.importWarnings.length ? (
        <Banner tone="warn" icon="info">
          {p.importWarnings
            .map((w) => t(`vault.import.warning.${w as 'attachments_missing'}`))
            .join(' · ')}
        </Banner>
      ) : null}

      <div className="mt-5 flex flex-col gap-4">
        <FieldGroup>
          <TypeFields p={p} access={access} />
        </FieldGroup>

        {p.fields.length ? (
          <>
            <SectionTitle>{t('vault.detail.customFields')}</SectionTitle>
            <FieldGroup>
              {p.fields.map((f) =>
                p.type !== 'login' && f.value && f.value === totp ? (
                  <TotpRow key={f.id} secret={f.value} access={access} label={f.label} />
                ) : f.type === 'hidden' ? (
                  <SecretRow
                    key={f.id}
                    label={f.label}
                    value={f.value}
                    field={`custom:${f.label}`.slice(0, 50)}
                    access={access}
                    copyKey="vault.field.custom"
                    mono={false}
                  />
                ) : f.type === 'boolean' ? (
                  <FieldRow key={f.id} label={f.label}>
                    <Icon
                      name={f.value === 'true' ? 'checkC' : 'x'}
                      size={16}
                      className={f.value === 'true' ? 'text-success' : 'text-fg3'}
                    />
                  </FieldRow>
                ) : (
                  <TextRow
                    key={f.id}
                    label={f.label}
                    value={f.value}
                    copyKey="vault.field.custom"
                    access={access}
                    field={`custom:${f.label}`.slice(0, 50)}
                  />
                ),
              )}
            </FieldGroup>
          </>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          {p.notes ? (
            <div className="flex flex-col gap-2">
              <SectionTitle>{t('vault.field.notes')}</SectionTitle>
              {/* Plain text only: notes are never rendered as HTML or Markdown here. */}
              <p className="rounded-xl bg-bg2/60 p-4 text-sm whitespace-pre-wrap shadow-line">
                {p.notes}
              </p>
            </div>
          ) : null}
          {p.attachments.length ? (
            <div className="flex flex-col gap-2">
              <SectionTitle>
                {t('vault.detail.attachments', { count: p.attachments.length })}
              </SectionTitle>
              {p.attachments.map((a) => (
                <AttachmentChip key={a.id} itemId={item.id} att={a} />
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <footer className="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-6 text-xs text-fg3">
        {item.createdBy ? (
          <span className="flex items-center gap-1.5">
            <Avatar name={item.createdBy.name} src={item.createdBy.imageUrl} size="sm" />
            {t('vault.detail.createdBy', {
              name: item.createdBy.name,
              date: formatDate(item.createdAt, locale),
            })}
            {p.importedFrom ? ` · ${t('vault.detail.imported')}` : ''}
          </span>
        ) : null}
        {item.updatedBy && item.revision > 1 ? (
          <span className="flex items-center gap-1.5">
            <Avatar name={item.updatedBy.name} src={item.updatedBy.imageUrl} size="sm" />
            {t('vault.detail.updatedBy', {
              name: item.updatedBy.name,
              date: formatDate(item.updatedAt, locale),
            })}
          </span>
        ) : null}
        <button
          type="button"
          className="ml-auto flex items-center gap-1.5 hover:text-fg"
          onClick={() => setHistory(true)}
        >
          <Icon name="history" size={13} />
          {t('vault.detail.revisions', { count: item.revision })}
        </button>
      </footer>
      <HistoryDialog open={history} onOpenChange={setHistory} d={d} />
      {share ? <ShareDialog open={share} onOpenChange={setShare} d={d} payload={p} /> : null}
    </article>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'warn' | 'danger';
  icon: 'alert' | 'trash' | 'info';
  children: ReactNode;
}) {
  return (
    <div
      role="note"
      className={cn(
        'mt-4 flex items-start gap-2.5 rounded-lg px-4 py-3 text-sm text-fg',
        tone === 'danger'
          ? 'bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]'
          : 'bg-[color-mix(in_srgb,var(--warning)_12%,transparent)]',
      )}
    >
      <Icon
        name={icon}
        size={16}
        className={cn('mt-0.5 shrink-0', tone === 'danger' ? 'text-danger' : 'text-warning')}
      />
      <span>{children}</span>
    </div>
  );
}

function LinkOut({ url }: { url: string }) {
  const { t } = useI18n();
  const href = safeHref(url);
  if (!href) return null;
  return (
    <Tooltip content={t('vault.detail.openSite')}>
      <IconButton asChild aria-label={t('vault.detail.openSite')} tone="plain" shape="sq" size="sm">
        <a href={href} target="_blank" rel="noopener noreferrer">
          <Icon name="ext" size={16} />
        </a>
      </IconButton>
    </Tooltip>
  );
}

function ExpiryRow({ value }: { value: string | null }) {
  const { t, locale } = useI18n();
  const now = useNow(60_000);
  if (!value) return null;
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round(
    (d.getTime() - new Date(new Date(now).toDateString()).getTime()) / 86_400_000,
  );
  return (
    <FieldRow
      label={t('vault.field.expiresAt')}
      actions={
        days <= 30 ? (
          <Badge tone={days < 0 ? 'danger' : 'warn'}>
            {days < 0 ? t('vault.detail.expiredShort') : t('vault.detail.daysLeft', { days })}
          </Badge>
        ) : null
      }
    >
      {formatDate(d, locale, { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })}
    </FieldRow>
  );
}

function TypeFields({ p, access }: { p: ItemPayload; access: AccessRef }) {
  const { t } = useI18n();
  switch (p.type) {
    case 'login':
      return (
        <>
          <TextRow
            label={t('vault.field.username')}
            value={p.username}
            copyKey="vault.field.username"
            access={access}
            field="username"
          />
          <SecretRow
            label={t('vault.field.password')}
            value={p.password}
            field="password"
            access={access}
            copyKey="vault.field.password"
            below={
              <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <StrengthBadge password={p.password} />
                <BreachBadge password={p.password} />
              </span>
            }
          />
          {p.totp ? <TotpRow secret={p.totp} access={access} /> : null}
          {p.uris.map((u, i) => (
            <TextRow
              key={i}
              label={i === 0 ? t('vault.field.uris') : ''}
              value={u}
              copyKey="vault.field.uris"
              actions={<LinkOut url={u} />}
            />
          ))}
        </>
      );
    case 'api_key':
      return (
        <>
          <TextRow
            label={t('vault.field.username')}
            value={p.username}
            copyKey="vault.field.username"
            access={access}
            field="username"
          />
          <SecretRow
            label={t('vault.field.key')}
            value={p.key}
            field="key"
            access={access}
            copyKey="vault.field.key"
          />
          <TextRow
            label={t('vault.field.url')}
            value={p.url}
            copyKey="vault.field.url"
            actions={<LinkOut url={p.url} />}
          />
          <TextRow label={t('vault.field.scope')} value={p.scope} />
          <ExpiryRow value={p.expiresAt} />
        </>
      );
    case 'card':
      return (
        <>
          <TextRow
            label={t('vault.field.cardholder')}
            value={p.cardholder}
            copyKey="vault.field.cardholder"
          />
          <SecretRow
            label={t('vault.field.number')}
            value={p.number}
            field="number"
            access={access}
            copyKey="vault.field.number"
            extra={p.brand ? <Tag>{p.brand}</Tag> : null}
          />
          <TextRow
            label={t('vault.field.expiry')}
            value={p.expMonth && p.expYear ? `${p.expMonth}/${p.expYear}` : ''}
            copyKey="vault.field.expiry"
          />
          <SecretRow
            label={t('vault.field.code')}
            value={p.code}
            field="code"
            access={access}
            copyKey="vault.field.code"
          />
        </>
      );
    case 'ssh_key':
      return (
        <>
          <TextRow label={t('vault.field.host')} value={p.host} copyKey="vault.field.host" mono />
          <SecretRow
            label={t('vault.field.privateKey')}
            value={p.privateKey}
            field="private_key"
            access={access}
            copyKey="vault.field.privateKey"
          />
          <TextRow
            label={t('vault.field.publicKey')}
            value={p.publicKey}
            copyKey="vault.field.publicKey"
            mono
          />
          <TextRow
            label={t('vault.field.fingerprint')}
            value={p.fingerprint}
            copyKey="vault.field.fingerprint"
            mono
          />
          <SecretRow
            label={t('vault.field.passphrase')}
            value={p.passphrase}
            field="passphrase"
            access={access}
            copyKey="vault.field.passphrase"
          />
        </>
      );
    case 'identity': {
      const name = [p.title, p.firstName, p.middleName, p.lastName].filter(Boolean).join(' ');
      const address = [
        p.address1,
        p.address2,
        p.address3,
        [p.postalCode, p.city].filter(Boolean).join(' '),
        p.state,
        p.country,
      ]
        .filter(Boolean)
        .join('\n');
      return (
        <>
          <TextRow label={t('vault.field.fullName')} value={name} copyKey="vault.field.fullName" />
          <TextRow label={t('vault.field.email')} value={p.email} copyKey="vault.field.email" />
          <TextRow label={t('vault.field.phone')} value={p.phone} copyKey="vault.field.phone" />
          <TextRow
            label={t('vault.field.company')}
            value={p.company}
            copyKey="vault.field.company"
          />
          <SecretRow
            label={t('vault.field.nationalId')}
            value={p.nationalId}
            field="national_id"
            access={access}
            copyKey="vault.field.nationalId"
            mono={false}
          />
          <SecretRow
            label={t('vault.field.passport')}
            value={p.passport}
            field="passport"
            access={access}
            copyKey="vault.field.passport"
            mono={false}
          />
          <SecretRow
            label={t('vault.field.license')}
            value={p.license}
            field="license"
            access={access}
            copyKey="vault.field.license"
            mono={false}
          />
          <TextRow label={t('vault.field.address')} value={address} copyKey="vault.field.address" />
        </>
      );
    }
    case 'note':
      return (
        <FieldRow label={t('vault.type.note')}>
          <span className="text-fg2">{t('vault.detail.noteHint')}</span>
        </FieldRow>
      );
  }
}

function AttachmentChip({ itemId, att }: { itemId: string; att: AttachmentRef }) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => {
        // Pictures, videos and PDFs open in the viewer, decrypted in memory only.
        if (canView(att.mime, att.name)) {
          openViewer(
            [
              {
                key: `vault:${itemId}:${att.id}`,
                name: att.name,
                mime: att.mime ?? null,
                sizeBytes: att.size,
                url: () => attachmentBlobUrl(itemId, att),
                private: true,
              },
            ],
            0,
            e.currentTarget,
          );
          return;
        }
        setBusy(true);
        void downloadAttachment(itemId, att).finally(() => setBusy(false));
      }}
      className="flex items-center gap-3 rounded-xl bg-bg2/60 p-3 text-left shadow-line hover:bg-bg2"
    >
      <span className="flex size-9 items-center justify-center rounded-md bg-bg2">
        {busy ? <Spinner size={16} /> : <Icon name="file" size={17} />}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold">{att.name}</span>
        <span className="flex items-center gap-1 text-xs text-fg3">
          {formatBytes(att.size, locale)} · <Icon name="lock" size={11} />{' '}
          {t('vault.detail.encrypted')}
        </span>
      </span>
      <Icon name="download" size={16} className="ml-auto text-fg2" />
    </button>
  );
}

/** Last 10 revisions (doc 17 §4): decrypt on open; restoring saves it as a new revision. */
export function HistoryDialog({
  open,
  onOpenChange,
  d,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  d: DecryptedItem;
}) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ ...revisionsQuery(d.item.id), enabled: open });
  const current = useMemo(() => payloadOf(d), [d]);
  const [error, setError] = useState<string | null>(null);
  const decrypt = (v: Vault, r: VaultItemRevision): ItemPayload | null => {
    try {
      return decryptItem(
        vaultKeyFor(v),
        {
          vaultId: v.id,
          itemId: d.item.id,
          revision: r.revision,
          keyVersion: r.keyVersion,
          type: r.type as ItemType,
        },
        r,
      );
    } catch {
      return null;
    }
  };
  const restore = async (p: ItemPayload) => {
    setError(null);
    try {
      await saveItem(d.vault, d.item, p);
      invalidateVault(qc, d.vault.id);
      void qc.invalidateQueries({ queryKey: ['vault', 'revisions', d.item.id] });
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e, t));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent width={520}>
        <DialogHeader
          icon="history"
          title={t('vault.history.title')}
          description={t('vault.history.body')}
        />
        {q.isPending ? <Spinner className="mx-auto" /> : null}
        {q.data && !q.data.length ? (
          <p className="text-sm text-fg2">{t('vault.history.empty')}</p>
        ) : null}
        <ul className="flex flex-col divide-y divide-line">
          {q.data?.map((r) => {
            const p = decrypt(d.vault, r);
            return (
              <li key={r.revision} className="flex items-center gap-3 py-2.5">
                <span className="w-10 text-xs font-semibold text-fg3 tn">#{r.revision}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">
                    {p?.name ?? t('vault.detail.tampered')}
                  </span>
                  <span className="text-xs text-fg3">
                    {formatDate(r.createdAt, locale)} {formatTime(r.createdAt, locale)}
                    {r.createdBy ? ` · ${r.createdBy.name}` : ''}
                    {p?.type === 'login' &&
                    current?.type === 'login' &&
                    p.password !== current.password
                      ? ` · ${t('vault.history.passwordDiffers')}`
                      : ''}
                  </span>
                </span>
                {p && d.vault.canEdit && !d.item.deletedAt ? (
                  <Button size="xs" variant="out" onClick={() => void restore(p)}>
                    {t('vault.history.restore')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <p className="text-xs text-fg3">{t('vault.history.hint')}</p>
      </DialogContent>
    </Dialog>
  );
}
