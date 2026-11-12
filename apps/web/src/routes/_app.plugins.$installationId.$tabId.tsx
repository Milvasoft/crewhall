import { localize } from '@crewhall/plugin-sdk';
import { EmptyState } from '@crewhall/ui';
import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { PluginFrame } from '@/components/plugins/PluginFrame';
import { PluginSettingsButton } from '@/components/plugins/PluginSettings';
import { usePluginSurfaces } from '@/components/plugins/surfaces';
import { Workspace } from '@/components/shell/Workspace';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/plugins/$installationId/$tabId')({
  component: PluginTabPage,
});

/** A plugin tab placed in the rail (docs/contracts/eklentiler.md › Giriş noktaları). */
function PluginTabPage() {
  const { installationId, tabId } = Route.useParams();
  // A notification's deep link (`?chat=42#…`) goes on to the plugin's own page.
  const deepLink = useRouterState({
    select: (s) => ({ search: s.location.searchStr, hash: s.location.hash }),
    structuralSharing: true,
  });
  const { t, locale } = useI18n();
  const surface = usePluginSurfaces().find((s) => s.installationId === installationId);
  const tab = surface?.tabs.find((x) => x.id === tabId);
  return (
    <Workspace
      tools={surface ? <PluginSettingsButton installationId={installationId} /> : undefined}
      crumbs={[
        { label: t('plugins.nav') },
        ...(surface && tab ? [{ label: localize(tab.title, locale) }] : []),
      ]}
    >
      {surface && tab ? (
        <PluginFrame
          key={`${installationId}:${tabId}`}
          surface={surface}
          entry={tab}
          placement="rail"
          deepLink={deepLink}
          className="h-[calc(100dvh-120px)] min-h-[480px] rounded-2xl shadow-line"
        />
      ) : (
        <EmptyState icon="plug" title={t('plugins.frame.notFound')} />
      )}
    </Workspace>
  );
}
