import { type Contact, type ContactKind } from '@crewhall/shared';
import { Avatar, Button, EmptyState, Icon, IconButton, Skeleton, Tag, toast } from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  companiesQuery,
  companyQuery,
  contactQuery,
  contactVersionsQuery,
  contactsKeys,
  contactsQuery,
} from '@/lib/contacts/queries';
import { ActionContextMenu } from '@/components/common/ActionMenu';
import { CompanyDialog, ContactDialog } from './ContactDialogs';
import { useExternalEntries } from './ContactMenus';
import { ResizablePane } from '@/components/shell/ResizablePane';

/** External contacts (roadmap 15): customers, suppliers and partners with tags. */
export function ContactsList({
  q,
  kind,
  tag,
  companyId,
  selected,
  onSelect,
  onDeleted,
}: {
  q: string;
  kind?: ContactKind;
  tag?: string;
  companyId?: string;
  selected: string | null;
  onSelect: (id: string) => void;
  /** A contact removed from its right-click menu. */
  onDeleted?: (id: string) => void;
}) {
  const { t } = useI18n();
  const list = useInfiniteQuery(contactsQuery({ q: q || undefined, kind, tag, companyId }));
  const menu = useExternalEntries(onSelect, onDeleted);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isLoading) return <Skeleton className="h-40" />;
  if (!items.length) {
    return (
      <EmptyState
        icon="id"
        title={t('contacts.list.emptyTitle')}
        description={t('contacts.list.empty')}
      />
    );
  }
  return (
    <div className="flex flex-col" data-testid="contacts-list">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((c) => (
          <li key={c.id}>
            <ActionContextMenu entries={menu.contactEntries(c)}>
              <button
                type="button"
                aria-pressed={selected === c.id}
                onClick={() => onSelect(c.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-bg2 aria-pressed:bg-capsule"
              >
                <Avatar name={c.displayName} src={null} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">
                    {c.displayName}
                    {c.visibility === 'private' ? (
                      <Icon name="lock" size={11} className="ml-1 inline text-fg3" />
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-fg2">
                    {[c.jobTitle, c.company?.name, c.emails[0]?.value].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="hidden gap-1 sm:flex">
                  {c.tags.slice(0, 3).map((x) => (
                    <Tag key={x}>{x}</Tag>
                  ))}
                </span>
                <span className="w-24 text-right text-xs text-fg3">
                  {t(`contacts.kind.${c.kind}`)}
                </span>
              </button>
            </ActionContextMenu>
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
        <Button
          variant="gh"
          size="sm"
          className="mt-3 self-center"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {t('contacts.more')}
        </Button>
      ) : null}
      {menu.dialogs}
    </div>
  );
}

function PanelShell({
  title,
  onClose,
  onEdit,
  onDelete,
  children,
}: {
  title: string;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <ResizablePane id="contacts-detail" side="right" defaultWidth={340}>
      <aside
        aria-label={title}
        className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg px-5 py-4"
        data-testid="contact-panel"
      >
        <div className="flex items-start gap-1">
          <h2 className="min-w-0 flex-1 text-lg leading-snug font-bold break-words">{title}</h2>
          {onEdit ? (
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('contacts.actions.edit')}
              onClick={onEdit}
            >
              <Icon name="edit" size={16} />
            </IconButton>
          ) : null}
          {onDelete ? (
            <IconButton
              size="sm"
              tone="plain"
              aria-label={t('common.actions.delete')}
              onClick={onDelete}
            >
              <Icon name="trash" size={16} />
            </IconButton>
          ) : null}
          <IconButton
            size="sm"
            tone="plain"
            aria-label={t('common.actions.close')}
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </IconButton>
        </div>
        {children}
      </aside>
    </ResizablePane>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg3">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}

function ContactDetails({ c }: { c: Contact }) {
  const { t } = useI18n();
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      {c.jobTitle ? <Detail label={t('contacts.form.jobTitle')}>{c.jobTitle}</Detail> : null}
      {c.company ? <Detail label={t('contacts.form.company')}>{c.company.name}</Detail> : null}
      <Detail label={t('contacts.form.kind')}>{t(`contacts.kind.${c.kind}`)}</Detail>
      {c.emails.map((e) => (
        <Detail key={e.value} label={t(`contacts.type.${e.type}`)}>
          <a href={`mailto:${e.value}`} className="hover:underline">
            {e.value}
          </a>
        </Detail>
      ))}
      {c.phones.map((p) => (
        <Detail key={p.value} label={t(`contacts.type.${p.type}`)}>
          <a href={`tel:${p.value.replace(/\s/g, '')}`} className="hover:underline">
            {p.value}
          </a>
        </Detail>
      ))}
      {c.address ? <Detail label={t('contacts.form.address')}>{c.address}</Detail> : null}
      {c.website ? <Detail label={t('contacts.form.website')}>{c.website}</Detail> : null}
      {c.birthday ? <Detail label={t('contacts.form.birthday')}>{c.birthday}</Detail> : null}
    </dl>
  );
}

export function ContactPanel({ contactId, onClose }: { contactId: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery(contactQuery(contactId));
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.call('deleteContact', { params: { contactId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const c = q.data;
  if (!c) {
    return (
      <PanelShell title="" onClose={onClose}>
        <Skeleton className="h-40" />
      </PanelShell>
    );
  }
  return (
    <PanelShell
      title={c.displayName}
      onClose={onClose}
      onEdit={c.permissions.edit ? () => setEditing(true) : undefined}
      onDelete={c.permissions.delete ? () => remove.mutate() : undefined}
    >
      <ContactDetails c={c} />
      {c.tags.length ? (
        <div className="flex flex-wrap gap-1">
          {c.tags.map((x) => (
            <Tag key={x}>{x}</Tag>
          ))}
        </div>
      ) : null}
      {c.notes ? <p className="text-sm whitespace-pre-wrap">{c.notes}</p> : null}
      <p className="text-xs text-fg3">
        {c.external
          ? t('contacts.external.synced', {
              name: t(`calendar.accounts.provider.${c.external.provider}`),
              email: c.external.email,
            })
          : c.visibility === 'private'
            ? t('contacts.list.privateNote')
            : t('contacts.list.addedBy', { name: c.createdBy?.name ?? '—' })}
      </p>
      {c.external ? <ContactVersions contactId={c.id} provider={c.external.provider} /> : null}
      {editing ? <ContactDialog contact={c} onClose={() => setEditing(false)} /> : null}
    </PanelShell>
  );
}

/** Mirrored contacts: versions lost to "the last writer wins". Nothing until there is one. */
function ContactVersions({
  contactId,
  provider,
}: {
  contactId: string;
  provider: NonNullable<Contact['external']>['provider'];
}) {
  const { t, locale } = useI18n();
  const q = useQuery(contactVersionsQuery(contactId));
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const at = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <details className="flex flex-col gap-2" data-testid="contact-versions">
      <summary className="eyebrow cursor-pointer">
        {t('contacts.external.versions', { count: items.length })}
      </summary>
      <p className="mt-1 text-xs text-fg3">{t('contacts.external.versionsHint')}</p>
      <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0">
        {items.map((v) => (
          <li key={v.id} className="flex flex-col gap-0.5 rounded-lg bg-bg2 p-3 text-sm">
            <span className="text-xs text-fg3">
              {t(
                v.overwritten === 'crewhall'
                  ? 'contacts.external.versionCrewhall'
                  : `calendar.accounts.provider.${provider}`,
              )}{' '}
              · {at.format(new Date(v.replacedAt))}
            </span>
            <span className="font-semibold break-words">{v.displayName}</span>
            {[v.jobTitle, v.company].filter(Boolean).length ? (
              <span className="text-xs text-fg2">
                {[v.jobTitle, v.company].filter(Boolean).join(' · ')}
              </span>
            ) : null}
            {[...v.emails, ...v.phones].map((x) => (
              <span key={x.value} className="text-xs break-words text-fg2">
                {x.value}
              </span>
            ))}
            {v.address ? <span className="text-xs text-fg2">{v.address}</span> : null}
            {v.notes ? (
              <span className="text-xs whitespace-pre-wrap text-fg2">{v.notes}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function CompaniesList({
  q,
  kind,
  tag,
  selected,
  onSelect,
  onDeleted,
}: {
  q: string;
  kind?: ContactKind;
  tag?: string;
  selected: string | null;
  onSelect: (id: string) => void;
  /** A company removed from its right-click menu. */
  onDeleted?: (id: string) => void;
}) {
  const { t } = useI18n();
  const list = useInfiniteQuery(companiesQuery({ q: q || undefined, kind, tag }));
  const menu = useExternalEntries(onSelect, onDeleted);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isLoading) return <Skeleton className="h-40" />;
  if (!items.length) {
    return (
      <EmptyState
        icon="globe"
        title={t('contacts.company.emptyTitle')}
        description={t('contacts.company.empty')}
      />
    );
  }
  return (
    <>
      <ul
        className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-2 p-0"
        data-testid="companies-list"
      >
        {items.map((c) => (
          <li key={c.id}>
            <ActionContextMenu entries={menu.companyEntries(c)}>
              <button
                type="button"
                aria-pressed={selected === c.id}
                onClick={() => onSelect(c.id)}
                className="flex w-full flex-col gap-1 rounded-xl bg-bg2 p-3 text-left hover:bg-capsule aria-pressed:shadow-line2"
              >
                <span className="truncate text-sm font-semibold">{c.name}</span>
                <span className="truncate text-xs text-fg2">
                  {t(`contacts.kind.${c.kind}`)} ·{' '}
                  {t('contacts.company.people', { count: c.contactCount })}
                </span>
              </button>
            </ActionContextMenu>
          </li>
        ))}
      </ul>
      {menu.dialogs}
    </>
  );
}

export function CompanyPanel({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery(companyQuery(companyId));
  const people = useInfiniteQuery(contactsQuery({ companyId }));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.call('deleteContactCompany', { params: { companyId } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  const c = q.data;
  if (!c) {
    return (
      <PanelShell title="" onClose={onClose}>
        <Skeleton className="h-40" />
      </PanelShell>
    );
  }
  const list = people.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <PanelShell
      title={c.name}
      onClose={onClose}
      onEdit={c.permissions.edit ? () => setEditing(true) : undefined}
      onDelete={c.permissions.delete ? () => remove.mutate() : undefined}
    >
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
        <Detail label={t('contacts.form.kind')}>{t(`contacts.kind.${c.kind}`)}</Detail>
        {c.domain ? <Detail label={t('contacts.company.domain')}>{c.domain}</Detail> : null}
        {c.website ? <Detail label={t('contacts.form.website')}>{c.website}</Detail> : null}
        {c.email ? <Detail label={t('contacts.fields.email')}>{c.email}</Detail> : null}
        {c.phone ? <Detail label={t('contacts.fields.phone')}>{c.phone}</Detail> : null}
        {c.address ? <Detail label={t('contacts.form.address')}>{c.address}</Detail> : null}
      </dl>
      {c.tags.length ? (
        <div className="flex flex-wrap gap-1">
          {c.tags.map((x) => (
            <Tag key={x}>{x}</Tag>
          ))}
        </div>
      ) : null}
      {c.notes ? <p className="text-sm whitespace-pre-wrap">{c.notes}</p> : null}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center">
          <span className="eyebrow flex-1">
            {t('contacts.company.people', { count: list.length })}
          </span>
          <Button size="xs" variant="gh" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            {t('contacts.actions.newContact')}
          </Button>
        </div>
        {list.map((p) => (
          <span key={p.id} className="flex items-center gap-2 text-sm">
            <Avatar name={p.displayName} src={null} size="sm" />
            <span className="min-w-0 flex-1 truncate font-semibold">{p.displayName}</span>
            <span className="truncate text-xs text-fg3">{p.jobTitle}</span>
          </span>
        ))}
      </div>
      {editing ? <CompanyDialog company={c} onClose={() => setEditing(false)} /> : null}
      {adding ? <ContactDialog companyId={c.id} onClose={() => setAdding(false)} /> : null}
    </PanelShell>
  );
}
