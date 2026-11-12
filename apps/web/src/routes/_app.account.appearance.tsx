import { type AppLocale } from '@crewhall/i18n';
import { cn, Icon, Segmented, Switch } from '@crewhall/ui';
import { colors, type ColorScheme } from '@crewhall/ui/tokens';
import { type Appearance } from '@crewhall/ui/theme';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@crewhall/api-client';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader, SettingsCard, SettingsRow } from '@/components/admin/Settings';
import { NavOrderCard } from '@/components/shell/NavOrderCard';
import { Workspace } from '@/components/shell/Workspace';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { orgQuery } from '@/lib/queries';
import { useTheme, type FontScale } from '@/lib/theme/ThemeContext';

export const Route = createFileRoute('/_app/account/appearance')({
  component: AppearancePage,
});

/** Appearance (doc 19 · 19.19): every change applies and saves immediately. */
function AppearancePage() {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const org = useQuery(orgQuery);
  const {
    appearance,
    setAppearance,
    density,
    setDensity,
    reducedMotion,
    setReducedMotion,
    fontScale,
    setFontScale,
  } = useTheme();
  const saveLocale = useMutation({
    mutationFn: (l: AppLocale) => api.call('updateMe', { body: { locale: l } }),
    onSuccess: (me) => qc.setQueryData(queryKeys.me, me),
  });

  return (
    <Workspace crumbs={[{ label: t('account.title') }, { label: t('account.nav.appearance') }]}>
      <PageHeader
        title={t('account.appearance.title')}
        subtitle={t('account.appearance.subtitle')}
      />
      <div className="flex max-w-[860px] flex-col gap-5">
        <SettingsCard title={t('prefs.theme')}>
          <div
            role="radiogroup"
            aria-label={t('prefs.theme')}
            className="grid grid-cols-3 gap-3 pt-1 pb-4"
          >
            {(['system', 'light', 'dark'] as const).map((a) => (
              <ThemeCard key={a} value={a} on={appearance === a} onClick={() => setAppearance(a)} />
            ))}
          </div>
        </SettingsCard>
        <SettingsCard title={t('account.appearance.display')}>
          <SettingsRow
            label={t('prefs.density.label')}
            description={t('account.appearance.densityHint')}
          >
            <Segmented
              aria-label={t('prefs.density.label')}
              value={density ?? 'org'}
              onValueChange={(v) => setDensity(v === 'org' ? null : v)}
              options={[
                { value: 'org', label: t('account.appearance.orgDefault') },
                { value: 'comfortable', label: t('prefs.density.comfortable') },
                { value: 'compact', label: t('prefs.density.compact') },
              ]}
            />
          </SettingsRow>
          <SettingsRow
            label={t('account.appearance.reducedMotion')}
            description={t('account.appearance.reducedMotionHint')}
          >
            <Switch
              aria-label={t('account.appearance.reducedMotion')}
              checked={reducedMotion}
              onCheckedChange={setReducedMotion}
            />
          </SettingsRow>
          <SettingsRow label={t('account.appearance.fontSize')}>
            <Segmented
              aria-label={t('account.appearance.fontSize')}
              value={String(fontScale)}
              onValueChange={(v) => setFontScale(Number(v) as FontScale)}
              options={[90, 100, 110, 125].map((n) => ({
                value: String(n),
                label: t('account.appearance.percent', { value: n }),
              }))}
            />
          </SettingsRow>
        </SettingsCard>
        <NavOrderCard />
        <SettingsCard title={t('account.appearance.language')}>
          <SettingsRow
            label={t('prefs.language')}
            description={t('account.profile.orgDefault', {
              language: t(`prefs.languages.${org.data?.settings.defaultLocale ?? 'tr'}`),
            })}
          >
            <Segmented
              aria-label={t('prefs.language')}
              value={locale}
              onValueChange={(l: AppLocale) => {
                setLocale(l);
                saveLocale.mutate(l);
              }}
              options={[
                { value: 'tr', label: t('prefs.languages.tr') },
                { value: 'en', label: t('prefs.languages.en') },
              ]}
            />
          </SettingsRow>
        </SettingsCard>
        <p className="m-0 text-xs text-fg3">{t('account.appearance.deviceNote')}</p>
      </div>
    </Workspace>
  );
}

/** Previews are painted with the real kit tokens of each scheme, whatever is active now. */
function ThemeCard({
  value,
  on,
  onClick,
}: {
  value: Appearance;
  on: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const schemes: ColorScheme[] = value === 'system' ? ['light', 'dark'] : [value];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-2 rounded-xl p-2.5 text-left',
        on ? 'shadow-[inset_0_0_0_2px_var(--fg)]' : 'shadow-line hover:shadow-line2',
      )}
    >
      <div className="flex h-[88px] overflow-hidden rounded-md">
        {schemes.map((s) => (
          <div key={s} className="flex flex-1 gap-1.5 p-2" style={{ background: colors[s].bg }}>
            <div className="flex w-3 flex-col gap-1">
              {[0, 1, 2].map((i) => (
                <i
                  key={i}
                  className="h-2 rounded-[2px]"
                  style={{ background: i === 0 ? colors[s].fg2 : colors[s].bg2 }}
                />
              ))}
            </div>
            <div
              className="flex flex-1 flex-col gap-1.5 rounded-[5px] p-1.5"
              style={{ background: colors[s].surface }}
            >
              <i className="h-1.5 w-2/3 rounded-full" style={{ background: colors[s].fg }} />
              <i className="h-1.5 w-1/2 rounded-full" style={{ background: colors[s].fg3 }} />
              <i
                className="mt-auto h-2.5 w-8 rounded-[3px]"
                style={{ background: colors[s].accent }}
              />
            </div>
          </div>
        ))}
      </div>
      <span className="flex items-center gap-2 text-cap font-semibold">
        <Icon
          name={value === 'system' ? 'monitor' : value === 'light' ? 'sun' : 'moon'}
          size={15}
        />
        {t(`prefs.appearance.${value}`)}
      </span>
    </button>
  );
}
