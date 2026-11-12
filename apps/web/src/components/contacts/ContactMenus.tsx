import { type Contact, type ContactCompany, type UserSummary } from '@crewhall/shared';
import { toast } from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { useOpenDirect } from '@/components/chat/actions';
import { api } from '@/lib/api';
import { useChatEnabled } from '@/lib/chat/enabled';
import { contactsKeys } from '@/lib/contacts/queries';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useMe } from '@/lib/session';
import { CompanyDialog, ContactDialog } from './ContactDialogs';

/** Opens the mail app on an address (Crewhall's composer takes no recipient from a link). */
function mailTo(email: string) {
  window.location.href = `mailto:${email}`;
}

/** "E-postayı kopyala" / "Telefonu kopyala" entries for the values a row has. */
function useCopyEntries() {
  const { t } = useI18n();
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    toast(t('contacts.menu.copied'));
  };
  return (values: { email?: string | null; phone?: string | null; mobile?: string | null }) => {
    const out: ActionEntry[] = [];
    if (values.email) {
      const v = values.email;
      out.push({
        kind: 'item',
        key: 'copyEmail',
        icon: 'copy',
        label: t('contacts.menu.copyEmail'),
        onSelect: () => copy(v),
      });
    }
    if (values.phone) {
      const v = values.phone;
      out.push({
        kind: 'item',
        key: 'copyPhone',
        icon: 'phone',
        label: t('contacts.menu.copyPhone'),
        onSelect: () => copy(v),
      });
    }
    if (values.mobile) {
      const v = values.mobile;
      out.push({
        kind: 'item',
        key: 'copyMobile',
        icon: 'phone',
        label: t('contacts.menu.copyMobile'),
        onSelect: () => copy(v),
      });
    }
    return out;
  };
}

/**
 * Right-click menu of a person in the directory or the org chart: profile, e-mail, a direct
 * chat (when chat is on, not with oneself) and copying their address and phones.
 */
export function usePersonEntries() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const openDirect = useOpenDirect();
  const chatOn = useChatEnabled();
  const me = useMe()?.user.id;
  const copyEntries = useCopyEntries();
  return (p: {
    user: UserSummary;
    phone?: string | null;
    mobile?: string | null;
  }): ActionEntry[] => {
    const entries: ActionEntry[] = [
      {
        kind: 'item',
        key: 'profile',
        icon: 'user',
        label: t('contacts.directory.openProfile'),
        onSelect: () => void navigate({ to: '/people/$userId', params: { userId: p.user.id } }),
      },
      {
        kind: 'item',
        key: 'email',
        icon: 'mail',
        label: t('contacts.menu.sendEmail'),
        onSelect: () => mailTo(p.user.email),
      },
    ];
    if (chatOn && p.user.id !== me) {
      entries.push({
        kind: 'item',
        key: 'chat',
        icon: 'chat',
        label: t('contacts.menu.startChat'),
        onSelect: () => void openDirect(p.user.id),
      });
    }
    const copies = copyEntries({ email: p.user.email, phone: p.phone, mobile: p.mobile });
    return copies.length ? [...entries, { kind: 'sep', key: 'sep-copy' }, ...copies] : entries;
  };
}

/**
 * Right-click menus of external contacts and companies: open, e-mail, copy, and edit / delete
 * where the row allows it (the same as the panel). `onDeleted` closes the panel of a removed row.
 */
export function useExternalEntries(
  onSelect: (id: string) => void,
  onDeleted?: (id: string) => void,
) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const copyEntries = useCopyEntries();
  const [editing, setEditing] = useState<
    { kind: 'contact'; c: Contact } | { kind: 'company'; c: ContactCompany } | null
  >(null);
  const done = async (id: string) => {
    await qc.invalidateQueries({ queryKey: contactsKeys.all });
    onDeleted?.(id);
  };
  const fail = (e: unknown) => toast(t(errorKey(e)));
  const removeContact = useMutation({
    mutationFn: (id: string) => api.call('deleteContact', { params: { contactId: id } }),
    onSuccess: (_r, id) => done(id),
    onError: fail,
  });
  const removeCompany = useMutation({
    mutationFn: (id: string) => api.call('deleteContactCompany', { params: { companyId: id } }),
    onSuccess: (_r, id) => done(id),
    onError: fail,
  });

  const tail = (
    permissions: Contact['permissions'],
    edit: () => void,
    remove: () => void,
  ): ActionEntry[] => {
    const out: ActionEntry[] = [];
    if (permissions.edit) {
      out.push({
        kind: 'item',
        key: 'edit',
        icon: 'edit',
        label: t('contacts.actions.edit'),
        onSelect: edit,
      });
    }
    if (permissions.delete) {
      out.push({
        kind: 'item',
        key: 'delete',
        icon: 'trash',
        label: t('common.actions.delete'),
        danger: true,
        onSelect: remove,
      });
    }
    return out.length ? [{ kind: 'sep', key: 'sep-edit' }, ...out] : out;
  };

  const head = (id: string, email: string | null): ActionEntry[] => {
    const out: ActionEntry[] = [
      {
        kind: 'item',
        key: 'open',
        icon: 'eye',
        label: t('contacts.menu.open'),
        onSelect: () => onSelect(id),
      },
    ];
    if (email) {
      out.push({
        kind: 'item',
        key: 'email',
        icon: 'mail',
        label: t('contacts.menu.sendEmail'),
        onSelect: () => mailTo(email),
      });
    }
    return out;
  };

  const withCopies = (entries: ActionEntry[], copies: ActionEntry[]) =>
    copies.length ? [...entries, { kind: 'sep' as const, key: 'sep-copy' }, ...copies] : entries;

  const contactEntries = (c: Contact): ActionEntry[] => {
    const email = c.emails[0]?.value ?? null;
    return [
      ...withCopies(head(c.id, email), copyEntries({ email, phone: c.phones[0]?.value ?? null })),
      ...tail(
        c.permissions,
        () => setEditing({ kind: 'contact', c }),
        () => removeContact.mutate(c.id),
      ),
    ];
  };

  const companyEntries = (c: ContactCompany): ActionEntry[] => [
    ...withCopies(head(c.id, c.email), copyEntries({ email: c.email, phone: c.phone })),
    ...tail(
      c.permissions,
      () => setEditing({ kind: 'company', c }),
      () => removeCompany.mutate(c.id),
    ),
  ];

  const dialogs =
    editing?.kind === 'contact' ? (
      <ContactDialog contact={editing.c} onClose={() => setEditing(null)} />
    ) : editing?.kind === 'company' ? (
      <CompanyDialog company={editing.c} onClose={() => setEditing(null)} />
    ) : null;

  return { contactEntries, companyEntries, dialogs };
}
