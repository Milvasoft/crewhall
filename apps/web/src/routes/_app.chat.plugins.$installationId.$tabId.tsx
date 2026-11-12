import { localize } from '@crewhall/plugin-sdk';
import { EmptyState, Icon } from '@crewhall/ui';
import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { PluginFrame } from '@/components/plugins/PluginFrame';
import { PluginSettingsButton } from '@/components/plugins/PluginSettings';
import { pluginIcon, usePluginSurfaces } from '@/components/plugins/surfaces';
import { DesktopTitleBarRow } from '@/lib/desktop-titlebar';
import { useI18n } from '@/lib/i18n/I18nContext';

export const Route = createFileRoute('/_app/chat/plugins/$installationId/$tabId')({
  component: ChatPluginTab,
});

/** A plugin tab placed in the chat sidebar, e.g. WhatsApp (docs/contracts/eklentiler.md). */
function ChatPluginTab() {
  const { installationId, tabId } = Route.useParams();
  // A notification's deep link (`?chat=42#…`) goes on to the plugin's own page.
  const deepLink = useRouterState({
    select: (s) => ({ search: s.location.searchStr, hash: s.location.hash }),
    structuralSharing: true,
  });
  const { t, locale } = useI18n();
  const surface = usePluginSurfaces().find((s) => s.installationId === installationId);
  const tab = surface?.tabs.find((x) => x.id === tabId && x.placement === 'chat');
  return surface && tab ? (
    <>
      {/* Desktop app: the window's title row, like the other chat panes' bars (no strip). */}
      <DesktopTitleBarRow>
        <Icon name={pluginIcon(tab.icon)} size={16} className="text-fg2" />
        <span className="truncate">{localize(tab.title, locale)}</span>
        <span className="ml-auto">
          <PluginSettingsButton installationId={installationId} />
        </span>
      </DesktopTitleBarRow>
      <PluginFrame
        key={`${installationId}:${tabId}`}
        surface={surface}
        entry={tab}
        placement="chat"
        deepLink={deepLink}
        className="min-h-0 flex-1"
      />
    </>
  ) : (
    <EmptyState icon="plug" title={t('plugins.frame.notFound')} />
  );
}
