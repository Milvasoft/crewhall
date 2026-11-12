import { queryKeys } from '@crewhall/api-client';
import { type DriveNode, type Share, type ShareRole } from '@crewhall/shared';
import {
  Avatar,
  Button,
  cn,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  SuggestionPanel,
  Switch,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Notice } from '@/components/auth/AuthLayout';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { isFederatedAddress, myFederationAddressQuery } from '@/lib/federation/queries';
import { formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { membersQuery, spaceMembersQuery } from '@/lib/queries';
import { useMe } from '@/lib/session';
import { useNodeActions } from './actions';
import { invalidateDrive, nodeQuery, sharesQuery } from './api';
import { NodeIconBox } from './NodeViews';

const EXPIRY = ['none', '1', '7', '30', '90'] as const;
type Expiry = (typeof EXPIRY)[number];

function expiresAt(v: Expiry): string | null {
  return v === 'none' ? null : new Date(Date.now() + Number(v) * 86_400_000).toISOString();
}

/**
 * The people who reach a node through its space, by role. Sharing only widens access (doc 17),
 * so these always can; what must stay hidden from them belongs in another space.
 */
function SpaceAccess({
  spaceId,
  name,
  memberCount,
}: {
  spaceId: string;
  name: string;
  memberCount: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const members = useQuery({ ...spaceMembersQuery(spaceId), enabled: open, retry: false });
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-bg2"
        onClick={() => setOpen(!open)}
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-bg2">
          <Icon name="users" size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-cap font-semibold">{t('drive.share.spaceMembers', { name })}</span>
          <span className="text-xs text-fg2">
            {t('drive.share.spaceMembersHint', { count: memberCount })}
          </span>
        </span>
        <span className="text-xs text-fg2">{t('drive.share.byRole')}</span>
        <Icon name="chevD" size={14} className={open ? 'rotate-180' : undefined} />
      </button>
      {open ? (
        <div className="ml-11 flex max-h-48 flex-col gap-1 overflow-y-auto pb-2">
          {members.isLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : members.isError ? (
            <span className="text-xs text-fg3">{t('drive.share.membersHidden')}</span>
          ) : (
            (members.data?.items ?? []).map((m) => (
              <div key={m.user.id} className="flex items-center gap-2 py-1">
                <Avatar name={m.user.name} src={m.user.imageUrl} size="sm" />
                <span className="min-w-0 flex-1 truncate text-cap">{m.user.name}</span>
                <span className="text-xs text-fg2">{t(`common.roles.space.${m.role}`)}</span>
              </div>
            ))
          )}
          <span className="mt-1 text-xs text-fg3">{t('drive.share.widenOnly')}</span>
        </div>
      ) : null}
    </>
  );
}

/**
 * Paylaş (3.11): space members reach the node by role (inherited, not editable here);
 * people outside get node shares, optionally time-limited; the public link has its own
 * expiry, password and download switch. The link address is only shown when created.
 */
export function ShareDialogBody({ node, onClose }: { node: DriveNode; onClose: () => void }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const me = useMe();
  const actions = useNodeActions();
  const detail = useQuery(nodeQuery(node.id));
  const shares = useQuery(sharesQuery(node.id));
  const [freshUrl, setFreshUrl] = useState<string | null>(null);
  const canPeople = actions.can(node, 'space.share_user');
  const canLink = actions.can(node, 'space.share_link');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.shares(node.id) });
    invalidateDrive(qc);
  };
  const fail = (e: unknown) => toast(t(errorKey(e)));

  const items = shares.data?.items ?? [];
  const people = items.filter((s) => s.kind === 'user');
  const link = items.find((s) => s.kind === 'link' && !s.inheritedFrom);
  const inheritedLink = items.find((s) => s.kind === 'link' && s.inheritedFrom);

  const createLink = useMutation({
    mutationFn: () =>
      api.call('createShare', {
        params: { nodeId: node.id },
        body: { kind: 'link', role: 'viewer', allowDownload: true, expiresAt: expiresAt('7') },
      }),
    onSuccess: (s) => {
      setFreshUrl(s.url ?? null);
      refresh();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: (p: { id: string; body: Parameters<typeof api.call<'updateShare'>>[1]['body'] }) =>
      api.call('updateShare', { params: { shareId: p.id }, body: p.body }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.call('deleteShare', { params: { shareId: id } }),
    onSuccess: () => {
      setFreshUrl(null);
      refresh();
    },
    onError: fail,
  });
  const regenerate = useMutation({
    mutationFn: (id: string) => api.call('regenerateShareLink', { params: { shareId: id } }),
    onSuccess: (s) => {
      setFreshUrl(s.url ?? null);
      refresh();
    },
    onError: fail,
  });

  const location = detail.data
    ? [detail.data.space.name, ...detail.data.path.map((p) => p.name)].join(' › ')
    : '';

  return (
    <DialogContent width={560}>
      <DialogHeader title={t('drive.share.title', { name: node.name })} description={location} />
      <div className="flex items-center gap-3 rounded-lg bg-bg2 px-3 py-2.5">
        <NodeIconBox node={node} />
        <span className="min-w-0 flex-1 truncate text-cap font-semibold">{node.name}</span>
      </div>

      {canPeople ? <AddPerson node={node} existing={people} onAdded={refresh} /> : null}

      <section className="flex flex-col gap-1">
        <span className="eyebrow mb-1">{t('drive.share.withAccess')}</span>
        {node.myRole ? (
          <span className="mb-1 text-xs text-fg2">
            {t('drive.share.yourAccess', { role: t(`common.roles.space.${node.myRole}`) })}
          </span>
        ) : null}
        {shares.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <>
            {shares.data ? (
              <SpaceAccess
                spaceId={shares.data.space.id}
                name={shares.data.space.name}
                memberCount={shares.data.space.memberCount}
              />
            ) : null}
            {people.map((s) => (
              <PersonRow
                key={s.id}
                share={s}
                editable={canPeople && !s.inheritedFrom && s.grantee?.id !== me?.user.id}
                onRole={(role) => update.mutate({ id: s.id, body: { role } })}
                onRemove={() => remove.mutate(s.id)}
              />
            ))}
          </>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-xl p-3.5 shadow-line">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-full bg-bg2">
            <Icon name="globe" size={16} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-cap font-semibold">{t('drive.share.publicLink')}</span>
            <span className="text-xs text-fg2">
              {link
                ? t('drive.share.publicOn', { count: link.openCount })
                : t('drive.share.publicOff')}
            </span>
          </span>
          <Switch
            checked={Boolean(link)}
            disabled={!canLink || createLink.isPending || remove.isPending}
            aria-label={t('drive.share.publicLink')}
            onCheckedChange={(v) => (v ? createLink.mutate() : link && remove.mutate(link.id))}
          />
        </div>
        {!canLink ? <span className="text-xs text-fg3">{t('drive.share.noLinkRight')}</span> : null}
        {inheritedLink && !link ? (
          <>
            <Notice tone="info">
              {t('drive.share.inheritedLink', { name: inheritedLink.inheritedFrom?.name ?? '' })}
            </Notice>
            {inheritedLink.url ? <LinkAddress url={inheritedLink.url} lost={false} /> : null}
          </>
        ) : null}
        {link ? (
          <>
            <LinkAddress
              url={freshUrl ?? link.url ?? null}
              lost={!freshUrl && link.urlLost === true}
              regenerating={regenerate.isPending}
              onRegenerate={canLink ? () => regenerate.mutate(link.id) : undefined}
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5 text-xs text-fg2">
                {t('drive.share.expiry')}
                <Select
                  value=""
                  onValueChange={(v) =>
                    update.mutate({ id: link.id, body: { expiresAt: expiresAt(v as Expiry) } })
                  }
                >
                  <SelectTrigger size="sm">
                    <SelectValue
                      placeholder={
                        link.expiresAt
                          ? t('drive.share.until', { date: formatDateLong(link.expiresAt, locale) })
                          : t('drive.share.expiries.none')
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY.map((e) => (
                      <SelectItem key={e} value={e}>
                        {t(`drive.share.expiries.${e === 'none' ? 'none' : 'days'}`, {
                          count: Number(e),
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <PasswordField
                hasPassword={link.hasPassword}
                onSave={(password) => update.mutate({ id: link.id, body: { password } })}
              />
            </div>
            <label className="flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-cap font-semibold">{t('drive.share.allowDownload')}</span>
                <span className="text-xs text-fg2">{t('drive.share.allowDownloadHint')}</span>
              </span>
              <Switch
                checked={link.allowDownload}
                onCheckedChange={(allowDownload) =>
                  update.mutate({ id: link.id, body: { allowDownload } })
                }
              />
            </label>
          </>
        ) : null}
      </section>

      {canLink ? <RemoteShare node={node} onSent={refresh} /> : null}

      <DialogFooter>
        <Button variant="inv" onClick={onClose}>
          {t('drive.share.done')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * The public address with Copy (H16: kept, so it can be copied any time). Links made before
 * addresses were kept can't show theirs; a new address replaces the old one.
 */
function LinkAddress({
  url,
  lost,
  regenerating = false,
  onRegenerate,
}: {
  url: string | null;
  lost: boolean;
  regenerating?: boolean;
  onRegenerate?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 rounded-lg bg-bg2 px-3 py-2">
      <span
        className={
          url ? 'min-w-0 flex-1 truncate font-mono text-xs' : 'min-w-0 flex-1 text-xs text-fg2'
        }
      >
        {url ?? (lost ? t('drive.share.urlLost') : t('drive.share.urlNoRight'))}
      </span>
      {url ? (
        <Button
          size="xs"
          variant="inv"
          onClick={() => {
            void navigator.clipboard?.writeText(url);
            toast(t('drive.linkCopied'));
          }}
        >
          {t('drive.share.copy')}
        </Button>
      ) : null}
      {onRegenerate && (lost || url) ? (
        <Button size="xs" loading={regenerating} onClick={onRegenerate}>
          {t('drive.share.regenerate')}
        </Button>
      ) : null}
    </div>
  );
}

function PasswordField({
  hasPassword,
  onSave,
}: {
  hasPassword: boolean;
  onSave: (p: string | null) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState('');
  return (
    <label className="flex flex-col gap-1.5 text-xs text-fg2">
      {t('drive.share.password')}
      <span className="flex items-center gap-1.5">
        <Input
          type="password"
          autoComplete="new-password"
          containerClassName="h-9 flex-1 rounded-md"
          value={value}
          placeholder={hasPassword ? '••••••••' : t('drive.share.passwordNone')}
          onChange={(e) => setValue(e.target.value)}
        />
        {value.length >= 4 ? (
          <Button
            size="xs"
            onClick={() => {
              onSave(value);
              setValue('');
            }}
          >
            {t('common.actions.save')}
          </Button>
        ) : hasPassword ? (
          <Button size="xs" variant="gh" onClick={() => onSave(null)}>
            {t('drive.share.removePassword')}
          </Button>
        ) : null}
      </span>
    </label>
  );
}

function PersonRow({
  share,
  editable,
  onRole,
  onRemove,
}: {
  share: Share;
  editable: boolean;
  onRole: (r: ShareRole) => void;
  onRemove: () => void;
}) {
  const { t, locale } = useI18n();
  const g = share.grantee;
  if (!g) return null;
  return (
    <div className="flex items-center gap-3 py-2">
      <Avatar name={g.name} src={g.imageUrl} size="md" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-cap font-semibold">{g.name}</span>
        <span className="truncate text-xs text-fg2">
          {share.inheritedFrom
            ? t('drive.share.inherited', { name: share.inheritedFrom.name })
            : [
                t('drive.share.addedBy', { name: share.createdBy?.name.split(' ')[0] ?? '' }),
                share.expiresAt
                  ? t('drive.share.until', { date: formatDateLong(share.expiresAt, locale) })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </span>
      {editable ? (
        <>
          <Select value={share.role} onValueChange={(v) => onRole(v as ShareRole)}>
            <SelectTrigger size="sm" className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">{t('drive.share.roles.viewer')}</SelectItem>
              <SelectItem value="editor">{t('drive.share.roles.editor')}</SelectItem>
            </SelectContent>
          </Select>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('drive.share.remove', { name: g.name })}
            onClick={onRemove}
          >
            <Icon name="x" size={14} />
          </IconButton>
        </>
      ) : (
        <span className="text-xs text-fg2">{t(`drive.share.roles.${share.role}`)}</span>
      )}
    </div>
  );
}

function AddPerson({
  node,
  existing,
  onAdded,
}: {
  node: DriveNode;
  existing: Share[];
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [role, setRole] = useState<ShareRole>('viewer');
  const [expiry, setExpiry] = useState<Expiry>('none');
  const members = useQuery({
    ...membersQuery({ q: q.trim() || undefined }),
    enabled: q.trim().length > 1,
  });
  const taken = new Set(existing.map((s) => s.grantee?.id));
  const add = useMutation({
    mutationFn: (userId: string) =>
      api.call('createShare', {
        params: { nodeId: node.id },
        body: { kind: 'user', userId, role, expiresAt: expiresAt(expiry) },
      }),
    onSuccess: () => {
      setQ('');
      onAdded();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const options = (members.data?.items ?? []).filter((m) => m.status === 'active').slice(0, 6);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SuggestionPanel
          open={q.trim().length > 1 && options.length > 0 && dismissed !== q}
          onDismiss={() => setDismissed(q)}
          anchor={
            <div className="min-w-0 flex-1">
              <Input
                containerClassName="h-10 rounded-md"
                icon="userPlus"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('drive.share.addPerson')}
                aria-label={t('drive.share.addPerson')}
              />
            </div>
          }
        >
          <ul className="m-0 flex list-none flex-col gap-px p-0">
            {options.map((m) => (
              <li key={m.user.id}>
                <button
                  type="button"
                  disabled={taken.has(m.user.id) || add.isPending}
                  onClick={() => add.mutate(m.user.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left hover:bg-bg2 disabled:opacity-50',
                  )}
                >
                  <Avatar name={m.user.name} src={m.user.imageUrl} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-cap font-semibold">{m.user.name}</span>
                    <span className="truncate text-[11px] text-fg2">{m.user.email}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </SuggestionPanel>
        <Select value={role} onValueChange={(v) => setRole(v as ShareRole)}>
          <SelectTrigger size="sm" className="w-[150px]" aria-label={t('drive.share.role')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="viewer">{t('drive.share.roles.viewer')}</SelectItem>
            <SelectItem value="editor">{t('drive.share.roles.editor')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={expiry} onValueChange={(v) => setExpiry(v as Expiry)}>
          <SelectTrigger size="sm" className="w-[120px]" aria-label={t('drive.share.expiry')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY.map((e) => (
              <SelectItem key={e} value={e}>
                {t(`drive.share.expiries.${e === 'none' ? 'none' : 'days'}`, { count: Number(e) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

const REMOTE_DAYS = [7, 30, 90] as const;

/**
 * Roadmap 26: a link share sent to someone on a peered installation, as a direct chat message
 * there. Shown only while federation is on.
 */
function RemoteShare({ node, onSent }: { node: DriveNode; onSent: () => void }) {
  const { t } = useI18n();
  const fed = useQuery(myFederationAddressQuery);
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [days, setDays] = useState<(typeof REMOTE_DAYS)[number]>(30);
  const send = useMutation({
    mutationFn: () =>
      api.call('shareNodeRemote', {
        params: { nodeId: node.id },
        body: {
          address: address.trim().toLowerCase(),
          note: note.trim() || undefined,
          expiresInDays: days,
        },
      }),
    onSuccess: () => {
      toast(t('federation.share.sent', { address: address.trim().toLowerCase() }));
      setAddress('');
      setNote('');
      onSent();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  if (!fed.data?.address) return null;
  const ok = isFederatedAddress(address.trim().toLowerCase());
  return (
    <section className="flex flex-col gap-2 rounded-xl p-3.5 shadow-line">
      <span className="flex items-center gap-2 text-cap font-semibold">
        <Icon name="globe" size={15} />
        {t('federation.share.title')}
      </span>
      <p className="m-0 text-xs text-fg2">{t('federation.share.hint')}</p>
      <div className="flex flex-wrap gap-2">
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="ayse@hub.ornek.com"
          aria-label={t('federation.share.address')}
          className="min-w-[200px] flex-1"
        />
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as typeof days)}>
          <SelectTrigger className="w-[120px]" aria-label={t('federation.share.days')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REMOTE_DAYS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {t('federation.share.daysValue', { count: d })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        placeholder={t('federation.share.note')}
        aria-label={t('federation.share.note')}
      />
      <Button
        variant="out"
        className="self-start"
        loading={send.isPending}
        disabled={!ok}
        onClick={() => send.mutate()}
      >
        <Icon name="send" size={15} />
        {t('federation.share.send')}
      </Button>
    </section>
  );
}
