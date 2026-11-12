import { MODULE_KEYS, type OrgSettings } from '@crewhall/shared';
import { Icon, IconBox, Switch } from '@crewhall/ui';
import { useId } from 'react';
import { SettingsCard } from '@/components/admin/Settings';
import { useI18n } from '@/lib/i18n/I18nContext';
import { MODULE_ICON, moduleSwitch, withModule } from '@/lib/identity/modules';

/**
 * Yönetim › Genel › Modüller: one switch per optional module. Saved with the page's save bar
 * through `updateOrg` (`settings.modules`); a missing key means on.
 */
export function ModulesCard({
  settings,
  onChange,
  disabled,
}: {
  settings: OrgSettings;
  onChange: (next: OrgSettings) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <SettingsCard
      className="xl:col-span-2"
      title={t('identity.modules.title')}
      aside={<span className="text-xs text-fg2">{t('identity.modules.subtitle')}</span>}
    >
      <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
        {MODULE_KEYS.map((key) => {
          const on = moduleSwitch(settings, key);
          const box = `${id}-${key}`;
          return (
            <div
              key={key}
              className="flex min-h-[60px] items-center gap-3 border-t border-line py-2.5"
            >
              <IconBox icon={MODULE_ICON[key]} size="sm" />
              <label htmlFor={box} className="flex min-w-0 flex-1 flex-col">
                <span className="text-cap font-semibold text-fg">
                  {t(`identity.modules.items.${key}.name`)}
                </span>
                <span className="text-xs text-fg2">{t(`identity.modules.items.${key}.desc`)}</span>
              </label>
              <Switch
                id={box}
                checked={on}
                onCheckedChange={(v) => onChange(withModule(settings, key, v))}
                disabled={disabled}
              />
            </div>
          );
        })}
        <div className="flex min-h-[60px] items-center gap-3 border-t border-line py-2.5 text-fg2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-bg2">
            <Icon name="lock" size={15} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-cap font-semibold">{t('identity.modules.core')}</span>
            <span className="text-xs">{t('identity.modules.coreHint')}</span>
          </span>
        </div>
      </div>
    </SettingsCard>
  );
}
