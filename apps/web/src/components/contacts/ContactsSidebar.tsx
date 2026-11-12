import { cn, Count, Icon, type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n/I18nContext';
import { contactTagsQuery, facetsQuery } from '@/lib/contacts/queries';
import { ModuleSidebar } from '@/components/shell/ModuleSidebar';

export type ContactsView = 'directory' | 'chart' | 'contacts' | 'companies';

const PATH: Record<ContactsView, string> = {
  directory: '/contacts',
  chart: '/contacts/org-chart',
  contacts: '/contacts/people',
  companies: '/contacts/companies',
};

/** Rehber sidebar: directory, org chart, external contacts and companies, with filters. */
export function ContactsSidebar({
  view,
  department,
  tag,
}: {
  view: ContactsView;
  department?: string;
  tag?: string;
}) {
  const { t } = useI18n();
  const facets = useQuery({ ...facetsQuery(), enabled: view === 'directory' });
  const tags = useQuery({
    ...contactTagsQuery(),
    enabled: view === 'contacts' || view === 'companies',
  });
  return (
    <ModuleSidebar label={t('contacts.title')} className="gap-px overflow-hidden px-2.5 py-3">
      <div className="flex items-center gap-2.5 px-2 pb-3">
        <span className="flex size-9 items-center justify-center rounded-md bg-bg2">
          <Icon name="users" size={18} />
        </span>
        <span className="text-sm font-bold">{t('contacts.title')}</span>
      </div>
      <Nav
        to={PATH.directory}
        icon="users"
        label={t('contacts.nav.directory')}
        active={view === 'directory'}
      />
      <Nav
        to={PATH.chart}
        icon="layers"
        label={t('contacts.nav.chart')}
        active={view === 'chart'}
      />
      <Nav
        to={PATH.contacts}
        icon="id"
        label={t('contacts.nav.contacts')}
        active={view === 'contacts'}
      />
      <Nav
        to={PATH.companies}
        icon="globe"
        label={t('contacts.nav.companies')}
        active={view === 'companies'}
      />
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {view === 'directory' && facets.data?.departments.length ? (
          <>
            <span className="eyebrow mb-1 px-2.5">{t('contacts.sidebar.departments')}</span>
            {facets.data.departments.map((d) => (
              <Link
                key={d.value}
                to="/contacts"
                search={department === d.value ? {} : { department: d.value }}
                className={cn(
                  'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
                  department === d.value && 'bg-capsule font-semibold text-fg',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{d.value}</span>
                <Count>{d.count}</Count>
              </Link>
            ))}
          </>
        ) : null}
        {(view === 'contacts' || view === 'companies') && tags.data?.items.length ? (
          <>
            <span className="eyebrow mb-1 px-2.5">{t('contacts.sidebar.tags')}</span>
            {tags.data.items.map((x) => (
              <Link
                key={x.tag}
                to={view === 'contacts' ? '/contacts/people' : '/contacts/companies'}
                search={tag === x.tag ? {} : { tag: x.tag }}
                className={cn(
                  'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
                  tag === x.tag && 'bg-capsule font-semibold text-fg',
                )}
              >
                <Icon name="tag" size={14} />
                <span className="min-w-0 flex-1 truncate">{x.tag}</span>
                <Count>{x.count}</Count>
              </Link>
            ))}
          </>
        ) : null}
      </div>
    </ModuleSidebar>
  );
}

function Nav({
  to,
  icon,
  label,
  active,
}: {
  to: string;
  icon: IconName;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'flex h-[var(--nv-h)] shrink-0 items-center gap-2.5 rounded-sm px-2.5 text-[13.5px] leading-[18px] font-medium text-fg2 hover:bg-bg2 hover:text-fg',
        active && 'bg-capsule font-semibold text-fg',
      )}
    >
      <Icon name={icon} size={16} />
      {label}
    </Link>
  );
}
