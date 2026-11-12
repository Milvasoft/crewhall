import {
  type Contact,
  type ContactCompany,
  type ContactKind,
  type CreateContact,
  type CreateContactCompany,
} from '@crewhall/shared';
import {
  Button,
  DatePicker,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  toast,
} from '@crewhall/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, idempotencyKey } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { calendarAccountsQuery } from '@/lib/calendar/queries';
import { companiesQuery, contactsKeys } from '@/lib/contacts/queries';
import { useMe } from '@/lib/session';

export const KINDS: ContactKind[] = ['customer', 'supplier', 'partner', 'other'];
type EmailType = Contact['emails'][number]['type'];
type PhoneType = Contact['phones'][number]['type'];
const NO_COMPANY = 'none';
const NO_ACCOUNT = 'none';

function useFail() {
  const { t } = useI18n();
  return (e: unknown) => toast(t(errorKey(e)));
}

/** Free tags: Enter or comma adds, Backspace on an empty field removes the last one. */
export function TagInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const add = () => {
    const v = q.trim().slice(0, 40);
    if (v && !value.some((x) => x.toLocaleLowerCase('tr') === v.toLocaleLowerCase('tr'))) {
      onChange([...value, v].slice(0, 30));
    }
    setQ('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg bg-bg2 px-2.5 py-2">
      {value.map((tag) => (
        <span
          key={tag}
          className="flex h-7 items-center gap-1 rounded-full bg-surface px-2.5 text-[13px] font-semibold shadow-line"
        >
          {tag}
          <button
            type="button"
            aria-label={t('contacts.form.removeTag', { name: tag })}
            onClick={() => onChange(value.filter((x) => x !== tag))}
            className="text-fg3 hover:text-fg"
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        aria-label={t('contacts.form.tags')}
        placeholder={t('contacts.form.tagsPlaceholder')}
        className="h-7 min-w-[120px] flex-1 bg-transparent text-sm outline-none placeholder:text-fg3"
      />
    </div>
  );
}

function KindSelect({
  value,
  onChange,
}: {
  value: ContactKind;
  onChange: (v: ContactKind) => void;
}) {
  const { t } = useI18n();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ContactKind)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {KINDS.map((k) => (
          <SelectItem key={k} value={k}>
            {t(`contacts.kind.${k}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** New or edit external contact. */
export function ContactDialog({
  contact,
  companyId,
  onClose,
}: {
  contact?: Contact;
  companyId?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const companies = useInfiniteQuery(companiesQuery({}));
  const me = useMe();
  const [firstName, setFirstName] = useState(contact?.firstName ?? '');
  const [lastName, setLastName] = useState(contact?.lastName ?? '');
  const [kind, setKind] = useState<ContactKind>(contact?.kind ?? 'customer');
  const [company, setCompany] = useState(contact?.company?.id ?? companyId ?? NO_COMPANY);
  const [jobTitle, setJobTitle] = useState(contact?.jobTitle ?? '');
  const [emails, setEmails] = useState(
    contact?.emails.length ? contact.emails : [{ type: 'work' as EmailType, value: '' }],
  );
  const [phones, setPhones] = useState(
    contact?.phones.length ? contact.phones : [{ type: 'mobile' as PhoneType, value: '' }],
  );
  const [address, setAddress] = useState(contact?.address ?? '');
  const [website, setWebsite] = useState(contact?.website ?? '');
  const [birthday, setBirthday] = useState<string | null>(contact?.birthday ?? null);
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [tags, setTags] = useState(contact?.tags ?? []);
  const [isPrivate, setPrivate] = useState(contact?.visibility === 'private');
  const [account, setAccount] = useState(NO_ACCOUNT);
  // Address books a new contact can also go to (the calendar module may be off: then none).
  const accounts = useQuery({ ...calendarAccountsQuery(), enabled: !contact, retry: false });
  const syncing = (accounts.data?.items ?? []).filter((a) => a.contacts?.status === 'active');

  const body = (): CreateContact => ({
    kind,
    firstName: firstName.trim() || null,
    lastName: lastName.trim() || null,
    companyId: company === NO_COMPANY ? null : company,
    jobTitle: jobTitle.trim() || null,
    emails: emails.map((e) => ({ ...e, value: e.value.trim() })).filter((e) => e.value),
    phones: phones.map((p) => ({ ...p, value: p.value.trim() })).filter((p) => p.value),
    address: address.trim() || null,
    website: website.trim() || null,
    birthday,
    notes: notes.trim() || null,
    tags,
    visibility: isPrivate ? 'private' : 'org',
  });
  const save = useMutation({
    mutationFn: () =>
      contact
        ? api.call('updateContact', {
            params: { contactId: contact.id },
            body: { ...body(), displayName: undefined },
          })
        : api.call('createContact', {
            body: { ...body(), ...(account === NO_ACCOUNT ? {} : { accountId: account }) },
            idempotencyKey: idempotencyKey(),
          }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
      onClose();
    },
    onError: fail,
  });
  const valid = Boolean(firstName.trim() || lastName.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };
  const all = companies.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={560}>
        <DialogHeader
          title={contact ? t('contacts.form.editTitle') : t('contacts.form.newTitle')}
        />
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('contacts.form.firstName')}>
              <Input
                autoFocus
                value={firstName}
                maxLength={80}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label={t('contacts.form.lastName')}>
              <Input
                value={lastName}
                maxLength={80}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
            <Field label={t('contacts.form.company')}>
              <Select value={company} onValueChange={setCompany}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_COMPANY}>{t('contacts.form.noCompany')}</SelectItem>
                  {all.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('contacts.form.jobTitle')}>
              <Input
                value={jobTitle}
                maxLength={120}
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </Field>
            <Field label={t('contacts.form.kind')}>
              <KindSelect value={kind} onChange={setKind} />
            </Field>
            <Field label={t('contacts.form.birthday')}>
              <DatePicker value={birthday} onChange={setBirthday} />
            </Field>
          </div>
          <Field label={t('contacts.fields.email')}>
            <div className="flex flex-col gap-2">
              {emails.map((e, i) => (
                <div key={i} className="flex gap-2">
                  <Select
                    value={e.type}
                    onValueChange={(v) =>
                      setEmails(
                        emails.map((x, j) => (j === i ? { ...x, type: v as EmailType } : x)),
                      )
                    }
                  >
                    <SelectTrigger className="w-28" aria-label={t('contacts.form.type')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['work', 'home', 'other'] as const).map((x) => (
                        <SelectItem key={x} value={x}>
                          {t(`contacts.type.${x}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="email"
                    value={e.value}
                    maxLength={254}
                    aria-label={t('contacts.fields.email')}
                    onChange={(ev) =>
                      setEmails(
                        emails.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)),
                      )
                    }
                  />
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('contacts.form.removeRow')}
                    onClick={() => setEmails(emails.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={14} />
                  </IconButton>
                </div>
              ))}
              {emails.length < 10 ? (
                <Button
                  size="xs"
                  variant="gh"
                  className="self-start"
                  onClick={() => setEmails([...emails, { type: 'work', value: '' }])}
                >
                  <Icon name="plus" size={13} />
                  {t('contacts.form.addEmail')}
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label={t('contacts.fields.phone')}>
            <div className="flex flex-col gap-2">
              {phones.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <Select
                    value={p.type}
                    onValueChange={(v) =>
                      setPhones(
                        phones.map((x, j) => (j === i ? { ...x, type: v as PhoneType } : x)),
                      )
                    }
                  >
                    <SelectTrigger className="w-28" aria-label={t('contacts.form.type')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['mobile', 'work', 'home', 'fax', 'other'] as const).map((x) => (
                        <SelectItem key={x} value={x}>
                          {t(`contacts.type.${x}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="tel"
                    value={p.value}
                    maxLength={40}
                    aria-label={t('contacts.fields.phone')}
                    onChange={(ev) =>
                      setPhones(
                        phones.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)),
                      )
                    }
                  />
                  <IconButton
                    size="sm"
                    tone="plain"
                    aria-label={t('contacts.form.removeRow')}
                    onClick={() => setPhones(phones.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={14} />
                  </IconButton>
                </div>
              ))}
              {phones.length < 10 ? (
                <Button
                  size="xs"
                  variant="gh"
                  className="self-start"
                  onClick={() => setPhones([...phones, { type: 'mobile', value: '' }])}
                >
                  <Icon name="plus" size={13} />
                  {t('contacts.form.addPhone')}
                </Button>
              ) : null}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('contacts.form.address')}>
              <Input value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
            </Field>
            <Field label={t('contacts.form.website')}>
              <Input value={website} maxLength={300} onChange={(e) => setWebsite(e.target.value)} />
            </Field>
          </div>
          <Field label={t('contacts.form.tags')}>
            <TagInput value={tags} onChange={setTags} />
          </Field>
          <Field label={t('contacts.form.notes')}>
            <Textarea
              rows={3}
              maxLength={5000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          {syncing.length ? (
            <Field label={t('contacts.external.saveTo')} hint={t('contacts.external.saveToHint')}>
              <Select value={account} onValueChange={setAccount}>
                <SelectTrigger aria-label={t('contacts.external.saveTo')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ACCOUNT}>{t('contacts.external.saveToNone')}</SelectItem>
                  {syncing.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {account === NO_ACCOUNT &&
          !contact?.external &&
          (!contact || contact.createdBy?.id === me?.user.id) ? (
            <label className="flex items-center gap-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold">{t('contacts.form.private')}</span>
                <span className="text-xs text-fg3">{t('contacts.form.privateHint')}</span>
              </span>
              <Switch checked={isPrivate} onCheckedChange={setPrivate} />
            </label>
          ) : null}
          <DialogFooter>
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={save.isPending} disabled={!valid}>
              {contact ? t('common.actions.save') : t('contacts.form.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** New or edit company. */
export function CompanyDialog({
  company,
  onClose,
}: {
  company?: ContactCompany;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const fail = useFail();
  const [name, setName] = useState(company?.name ?? '');
  const [kind, setKind] = useState<ContactKind>(company?.kind ?? 'customer');
  const [domain, setDomain] = useState(company?.domain ?? '');
  const [website, setWebsite] = useState(company?.website ?? '');
  const [email, setEmail] = useState(company?.email ?? '');
  const [phone, setPhone] = useState(company?.phone ?? '');
  const [address, setAddress] = useState(company?.address ?? '');
  const [notes, setNotes] = useState(company?.notes ?? '');
  const [tags, setTags] = useState(company?.tags ?? []);
  const body = (): CreateContactCompany => ({
    name: name.trim(),
    kind,
    domain: domain.trim() || null,
    website: website.trim() || null,
    email: email.trim() || null,
    phone: phone.trim() || null,
    address: address.trim() || null,
    notes: notes.trim() || null,
    tags,
  });
  const save = useMutation({
    mutationFn: () =>
      company
        ? api.call('updateContactCompany', { params: { companyId: company.id }, body: body() })
        : api.call('createContactCompany', { body: body(), idempotencyKey: idempotencyKey() }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
      onClose();
    },
    onError: fail,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={520}>
        <DialogHeader
          title={company ? t('contacts.company.editTitle') : t('contacts.company.newTitle')}
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('contacts.company.name')}>
              <Input
                autoFocus
                value={name}
                maxLength={160}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={t('contacts.form.kind')}>
              <KindSelect value={kind} onChange={setKind} />
            </Field>
            <Field label={t('contacts.company.domain')}>
              <Input value={domain} maxLength={160} onChange={(e) => setDomain(e.target.value)} />
            </Field>
            <Field label={t('contacts.form.website')}>
              <Input value={website} maxLength={300} onChange={(e) => setWebsite(e.target.value)} />
            </Field>
            <Field label={t('contacts.fields.email')}>
              <Input
                type="email"
                value={email}
                maxLength={254}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label={t('contacts.fields.phone')}>
              <Input
                type="tel"
                value={phone}
                maxLength={40}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
          </div>
          <Field label={t('contacts.form.address')}>
            <Input value={address} maxLength={500} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label={t('contacts.form.tags')}>
            <TagInput value={tags} onChange={setTags} />
          </Field>
          <Field label={t('contacts.form.notes')}>
            <Textarea
              rows={3}
              maxLength={5000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={save.isPending} disabled={!name.trim()}>
              {company ? t('common.actions.save') : t('contacts.form.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
