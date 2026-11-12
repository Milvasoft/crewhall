import { type Form } from '@crewhall/shared';
import { cn, Icon, Tag, type IconName } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { STATUS_KEY } from '@/lib/forms/fields';
import { useI18n } from '@/lib/i18n/I18nContext';

export type BuilderTab = 'fields' | 'sharing' | 'preview';

/** Tabs of a form's pages: fields, sharing, preview (builder) and results. */
export function FormTabs({ form, active }: { form: Form; active: BuilderTab | 'results' }) {
  const { t } = useI18n();
  const tabs: { id: BuilderTab | 'results'; label: string; icon: IconName }[] = [
    { id: 'fields', label: t('forms.tabs.fields'), icon: 'edit' },
    { id: 'sharing', label: t('forms.tabs.share'), icon: 'share' },
    { id: 'preview', label: t('forms.tabs.preview'), icon: 'eye' },
    {
      id: 'results',
      label: t('forms.tabs.results', { count: form.responseCount }),
      icon: 'activity',
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tag className={form.status === 'open' ? 'bg-accent text-accent-fg' : undefined}>
          {t(STATUS_KEY[form.status])}
        </Tag>
        {form.settings.access === 'public' ? (
          <span className="flex items-center gap-1 text-xs text-fg2">
            <Icon name="globe" size={13} />
            {t('forms.share.public')}
          </span>
        ) : null}
      </div>
      <nav
        aria-label={t('forms.tabs.label')}
        className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const current = tab.id === active;
          const cls = cn(
            '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-semibold whitespace-nowrap',
            current ? 'border-fg text-fg' : 'border-transparent text-fg2 hover:text-fg',
          );
          return tab.id === 'results' ? (
            <Link
              key={tab.id}
              to="/forms/f/$formId/results"
              params={{ formId: form.id }}
              className={cls}
              aria-current={current ? 'page' : undefined}
            >
              <Icon name={tab.icon} size={15} />
              {tab.label}
            </Link>
          ) : (
            <Link
              key={tab.id}
              to="/forms/f/$formId"
              params={{ formId: form.id }}
              search={{ tab: tab.id }}
              className={cls}
              aria-current={current ? 'page' : undefined}
            >
              <Icon name={tab.icon} size={15} />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
