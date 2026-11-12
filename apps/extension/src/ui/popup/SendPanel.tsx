import { Icon, type IconName } from '@crewhall/ui';
import { useState } from 'react';
import { openSend, readTab, screenshotDraft } from '../../background/menus';
import { errorText, t } from '../../shared/i18n';
import { Notice } from '../shell';

function Action({ icon, label, hint, onClick }: { icon: IconName; label: string; hint: string; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full cursor-pointer items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-2 text-left text-fg hover:bg-bg2"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg2 text-fg2">
          <Icon name={icon} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{label}</span>
          <span className="block truncate text-xs text-fg3">{hint}</span>
        </span>
      </button>
    </li>
  );
}

export function SendPanel({ activeTab }: { activeTab: chrome.tabs.Tab | null }) {
  const [error, setError] = useState<string | null>(null);
  const url = activeTab?.url ?? '';
  const title = activeTab?.title ?? '';
  if (!url.startsWith('http') || activeTab?.id === undefined) {
    return <p className="p-4 text-xs text-fg3">{t('send.notAPage')}</p>;
  }
  const tabId = activeTab.id;
  const run = (work: () => Promise<void>) => () => {
    setError(null);
    work().then(
      () => window.close(),
      (e: unknown) => setError(errorText(e)),
    );
  };

  return (
    <div className="p-2">
      {error ? <Notice tone="error">{error}</Notice> : null}
      <ul className="m-0 list-none p-0">
        <Action
          icon="note"
          label={t('send.clipPage')}
          hint={t('send.clipPageHint')}
          onClick={run(async () => {
            const content = await readTab(tabId);
            await openSend({ kind: 'page', pageUrl: url, title: content.title || title, html: content.html }, 'page');
          })}
        />
        <Action
          icon="cam"
          label={t('send.screenshot')}
          hint={t('send.screenshotHint')}
          onClick={run(async () => {
            await openSend(await screenshotDraft(activeTab.windowId, title, url), 'drive');
          })}
        />
        <Action
          icon="link"
          label={t('send.quick')}
          hint={t('send.quickHint')}
          onClick={run(() => openSend({ kind: 'page', pageUrl: url, title }, 'quick'))}
        />
        <Action
          icon="chat"
          label={t('send.chat')}
          hint={t('send.chatHint')}
          onClick={run(() => openSend({ kind: 'page', pageUrl: url, title }, 'chat'))}
        />
        <Action
          icon="board"
          label={t('send.board')}
          hint={t('send.boardHint')}
          onClick={run(() => openSend({ kind: 'page', pageUrl: url, title }, 'board'))}
        />
        <Action
          icon="download"
          label={t('send.saveFile')}
          hint={t('send.saveFileHint')}
          onClick={run(() => openSend({ kind: 'link', pageUrl: url, title, srcUrl: url }, 'drive'))}
        />
      </ul>
    </div>
  );
}
