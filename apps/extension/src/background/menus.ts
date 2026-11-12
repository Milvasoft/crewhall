import { putDraft, type Draft } from '../shared/storage';
import { readPageContent } from '../shared/page-functions';
import { t } from '../shared/i18n';

/** Right-click actions; each opens the send window with what was clicked. */

export async function openSend(draft: Draft, tab?: string) {
  const id = await putDraft(draft);
  const query = new URLSearchParams({ d: id, ...(tab ? { to: tab } : {}) });
  await chrome.windows.create({
    url: chrome.runtime.getURL(`send.html?${query.toString()}`),
    type: 'popup',
    width: 480,
    height: 660,
  });
}

const MENUS: { id: string; contexts: chrome.contextMenus.CreateProperties['contexts']; key: string }[] = [
  { id: 'image.drive', contexts: ['image'], key: 'menu.imageDrive' },
  { id: 'image.chat', contexts: ['image'], key: 'menu.imageChat' },
  { id: 'link.drive', contexts: ['link'], key: 'menu.linkDrive' },
  { id: 'link.quick', contexts: ['link'], key: 'menu.linkQuick' },
  { id: 'link.chat', contexts: ['link'], key: 'menu.linkChat' },
  { id: 'selection.page', contexts: ['selection'], key: 'menu.selectionPage' },
  { id: 'selection.chat', contexts: ['selection'], key: 'menu.selectionChat' },
  { id: 'selection.board', contexts: ['selection'], key: 'menu.selectionBoard' },
  { id: 'selection.calendar', contexts: ['selection'], key: 'menu.selectionCalendar' },
  { id: 'page.page', contexts: ['page'], key: 'menu.pagePage' },
  { id: 'page.quick', contexts: ['page'], key: 'menu.pageQuick' },
  { id: 'page.screenshot', contexts: ['page'], key: 'menu.pageScreenshot' },
];

export function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'root',
      title: 'Crewhall',
      contexts: ['image', 'link', 'selection', 'page'],
    });
    for (const m of MENUS) {
      chrome.contextMenus.create({ id: m.id, parentId: 'root', title: t(m.key), contexts: m.contexts });
    }
  });
}

export async function readTab(tabId: number, frameId?: number) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, ...(frameId ? { frameIds: [frameId] } : {}) },
    func: readPageContent,
    args: [400_000],
  });
  if (!r?.result) throw new Error('page not readable');
  return r.result;
}

export async function screenshotDraft(windowId: number, title: string, pageUrl: string) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  return { kind: 'screenshot', pageUrl, title, dataUrl } satisfies Draft;
}

export async function onMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  const id = String(info.menuItemId);
  const [kind, target] = id.split('.') as [string, string];
  const pageUrl = tab?.url ?? info.pageUrl ?? '';
  const title = tab?.title ?? '';

  if (kind === 'image') {
    await openSend({ kind: 'image', pageUrl, title, srcUrl: info.srcUrl }, target);
  } else if (kind === 'link') {
    await openSend(
      { kind: 'link', pageUrl, title: info.selectionText ?? title, srcUrl: info.linkUrl },
      target,
    );
  } else if (kind === 'selection') {
    let html: string | undefined;
    if (tab?.id !== undefined) {
      html = await readTab(tab.id, info.frameId)
        .then((c) => (c.selection ? c.html : undefined))
        .catch(() => undefined);
    }
    await openSend({ kind: 'selection', pageUrl, title, text: info.selectionText, html }, target);
  } else if (id === 'page.screenshot' && tab) {
    await openSend(await screenshotDraft(tab.windowId, title, pageUrl), 'drive');
  } else if (kind === 'page' && tab?.id !== undefined) {
    const html =
      target === 'page' ? await readTab(tab.id).then((c) => c.html).catch(() => undefined) : undefined;
    await openSend({ kind: 'page', pageUrl, title, html }, target);
  }
}
