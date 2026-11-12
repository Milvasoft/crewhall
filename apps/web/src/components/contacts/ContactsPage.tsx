import { CONTACTS_RAW_PATHS, type ContactKind } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Segmented,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { Workspace } from '@/components/shell/Workspace';
import { config } from '@/config';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { cardDavInfoQuery, contactsKeys } from '@/lib/contacts/queries';
import { CompanyDialog, ContactDialog, KINDS } from './ContactDialogs';
import { ContactsSidebar, type ContactsView } from './ContactsSidebar';
import { DirectoryList, PersonPanel } from './DirectoryView';
import { CompaniesList, CompanyPanel, ContactPanel, ContactsList } from './ExternalView';
import { OrgChartView } from './OrgChartView';

const ALL = 'all';

/** Rehber (roadmap 15): directory, org chart, external contacts and companies. */
export function ContactsPage({
  view,
  department,
  tag,
}: {
  view: ContactsView;
  department?: string;
  tag?: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<ContactKind | typeof ALL>(ALL);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'contact' | 'company' | 'carddav' | null>(null);
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const importVcf = useMutation({
    mutationFn: async (f: File) =>
      api.call('importContactsVcard', { body: { vcf: await f.text(), visibility: 'org' } }),
    onSuccess: async (r) => {
      toast(t('contacts.import.done', { count: r.created, done: r.updated, failed: r.skipped }));
      await qc.invalidateQueries({ queryKey: contactsKeys.all });
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  const title = t(`contacts.nav.${view}`);
  const k = kind === ALL ? undefined : kind;
  const external = view === 'contacts' || view === 'companies';
  const download = (path: string) => {
    window.location.href = new URL(path, config.apiUrl).toString();
  };

  // A row removed from its right-click menu closes its panel.
  const deselect = (id: string) => setSelected((s) => (s === id ? null : s));
  const panel = !selected ? null : view === 'contacts' ? (
    <ContactPanel key={selected} contactId={selected} onClose={() => setSelected(null)} />
  ) : view === 'companies' ? (
    <CompanyPanel key={selected} companyId={selected} onClose={() => setSelected(null)} />
  ) : (
    <PersonPanel
      key={selected}
      userId={selected}
      onClose={() => setSelected(null)}
      onSelect={setSelected}
    />
  );

  return (
    <Workspace
      sidebar={<ContactsSidebar view={view} department={department} tag={tag} />}
      crumbs={[{ label: t('contacts.title') }, { label: title }]}
      panel={panel}
      tools={
        <>
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="out">
                <Icon name="dots" size={16} />
                {t('contacts.actions.more')}
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              {external ? (
                <MenuItem icon="upload" onSelect={() => file.current?.click()}>
                  {t('contacts.actions.import')}
                </MenuItem>
              ) : null}
              <MenuItem
                icon="download"
                onSelect={() =>
                  download(
                    external
                      ? CONTACTS_RAW_PATHS.exportContacts
                      : CONTACTS_RAW_PATHS.exportDirectory,
                  )
                }
              >
                {external
                  ? t('contacts.actions.exportContacts')
                  : t('contacts.actions.exportDirectory')}
              </MenuItem>
              <MenuItem icon="link" onSelect={() => setDialog('carddav')}>
                {t('contacts.actions.carddav')}
              </MenuItem>
            </MenuContent>
          </Menu>
          {external ? (
            <Button
              size="sm"
              variant="pri"
              onClick={() => setDialog(view === 'contacts' ? 'contact' : 'company')}
            >
              <Icon name="plus" size={16} />
              {view === 'contacts'
                ? t('contacts.actions.newContact')
                : t('contacts.actions.newCompany')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-h1 font-bold">{title}</h1>
        {department || tag ? (
          <Link
            to={
              view === 'directory'
                ? '/contacts'
                : view === 'contacts'
                  ? '/contacts/people'
                  : '/contacts/companies'
            }
            className="flex items-center gap-1 rounded-full bg-bg2 px-3 py-1 text-xs font-semibold"
          >
            {department ?? tag}
            <Icon name="x" size={12} />
          </Link>
        ) : null}
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t(view === 'chart' ? 'contacts.searchChart' : 'contacts.search')}
          aria-label={t('contacts.search')}
          className="ml-auto w-full sm:w-[280px]"
        />
      </div>
      {external ? (
        <Segmented
          size="sm"
          className="self-start"
          aria-label={t('contacts.form.kind')}
          value={kind}
          onValueChange={(v) => setKind(v)}
          options={[
            { value: ALL, label: t('contacts.kind.all') },
            ...KINDS.map((x) => ({ value: x, label: t(`contacts.kind.${x}`) })),
          ]}
        />
      ) : null}
      {view === 'directory' ? (
        <DirectoryList q={q} department={department} selected={selected} onSelect={setSelected} />
      ) : view === 'chart' ? (
        <OrgChartView q={q} selected={selected} onSelect={setSelected} />
      ) : view === 'contacts' ? (
        <ContactsList
          q={q}
          kind={k}
          tag={tag}
          selected={selected}
          onSelect={setSelected}
          onDeleted={deselect}
        />
      ) : (
        <CompaniesList
          q={q}
          kind={k}
          tag={tag}
          selected={selected}
          onSelect={setSelected}
          onDeleted={deselect}
        />
      )}
      <input
        ref={file}
        type="file"
        accept=".vcf,text/vcard"
        className="hidden"
        aria-label={t('contacts.actions.import')}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importVcf.mutate(f);
          e.target.value = '';
        }}
      />
      {dialog === 'contact' ? <ContactDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'company' ? <CompanyDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'carddav' ? <CardDavDialog onClose={() => setDialog(null)} /> : null}
    </Workspace>
  );
}

function CardDavDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const info = useQuery(cardDavInfoQuery());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={480}>
        <DialogHeader
          title={t('contacts.carddav.title')}
          description={t('contacts.carddav.hint')}
        />
        {info.data ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input readOnly value={info.data.url} aria-label={t('contacts.carddav.url')} />
              <Button
                size="sm"
                variant="out"
                onClick={() => {
                  void navigator.clipboard?.writeText(info.data.url);
                  toast(t('contacts.carddav.copied'));
                }}
              >
                {t('contacts.carddav.copy')}
              </Button>
            </div>
            <span className="text-xs text-fg3">
              {t('contacts.carddav.user', { user: info.data.username })}
            </span>
            {info.data.tokensAvailable ? (
              <Link
                to="/account/mcp"
                className="text-xs font-semibold text-accent-text hover:underline"
              >
                {t('contacts.carddav.createToken')}
              </Link>
            ) : (
              <span className="text-xs text-fg3">{t('contacts.carddav.tokensOff')}</span>
            )}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="gh" onClick={onClose}>
            {t('common.actions.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
