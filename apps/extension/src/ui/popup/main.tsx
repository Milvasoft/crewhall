import { Segmented } from '@crewhall/ui';
import { useEffect, useState } from 'react';
import { t } from '../../shared/i18n';
import { getSettings, type Settings } from '../../shared/storage';
import { Brand, IconAction, mount, NeedsConnection, openOptions, useConnection } from '../shell';
import { SendPanel } from './SendPanel';
import { VaultPanel } from './VaultPanel';

function Popup() {
  const connection = useConnection();
  const [tab, setTab] = useState<'vault' | 'send'>('vault');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [activeTab, setActiveTab] = useState<chrome.tabs.Tab | null>(null);

  useEffect(() => {
    void getSettings().then((s) => {
      setSettings(s);
      if (!s.vault) setTab('send');
    });
    void chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([current]) => setActiveTab(current ?? null));
  }, []);

  if (connection === undefined || !settings) return <div className="h-40 w-[380px]" />;

  const openSidePanel = () => {
    if (activeTab?.windowId !== undefined) {
      void chrome.sidePanel.open({ windowId: activeTab.windowId });
      window.close();
    }
  };

  return (
    <div className="flex max-h-[580px] min-h-[300px] w-[380px] flex-col">
      <Brand
        aside={
          connection ? (
            <>
              <IconAction icon="sparkle" label={t('popup.assistant')} onClick={openSidePanel} />
              <IconAction
                icon="ext"
                label={t('popup.open')}
                onClick={() => void chrome.tabs.create({ url: connection.origin })}
              />
              <IconAction icon="settings" label={t('popup.settings')} onClick={openOptions} />
            </>
          ) : null
        }
      />
      {connection ? (
        <>
          <div className="px-3 pt-3">
            <Segmented
              value={tab}
              onValueChange={(v) => setTab(v as 'vault' | 'send')}
              options={[
                { value: 'vault', label: t('popup.vault') },
                { value: 'send', label: t('popup.send') },
              ]}
            />
          </div>
          {tab === 'vault' ? (
            <VaultPanel enabled={settings.vault} activeTab={activeTab} />
          ) : (
            <SendPanel activeTab={activeTab} />
          )}
        </>
      ) : (
        <NeedsConnection />
      )}
    </div>
  );
}

mount(<Popup />);
