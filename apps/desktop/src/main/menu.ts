import {
  Menu,
  clipboard,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { windowOpenDecision } from '../common/window-policy';
import type { DesktopApp } from './app';

/**
 * The application menu. macOS needs it for the Edit shortcuts (copy, paste…); on Windows the
 * window has no menu bar and Chromium handles the shortcuts itself.
 */
export function buildAppMenu(d: DesktopApp): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const t = d.t;
  const template: MenuItemConstructorOptions[] = [
    {
      label: d.appName,
      submenu: [
        { label: t('desktop.menu.about'), click: () => d.openSettings('about') },
        { type: 'separator' },
        { label: t('desktop.menu.settings'), accelerator: 'Cmd+,', click: () => d.openSettings() },
        { type: 'separator' },
        { label: t('desktop.menu.hide'), role: 'hide' },
        { label: t('desktop.menu.hideOthers'), role: 'hideOthers' },
        { label: t('desktop.menu.unhide'), role: 'unhide' },
        { type: 'separator' },
        { label: t('desktop.menu.quit'), accelerator: 'Cmd+Q', click: () => d.quit() },
      ],
    },
    {
      label: t('desktop.menu.edit'),
      submenu: [
        { label: t('desktop.menu.undo'), role: 'undo' },
        { label: t('desktop.menu.redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('desktop.menu.cut'), role: 'cut' },
        { label: t('desktop.menu.copy'), role: 'copy' },
        { label: t('desktop.menu.paste'), role: 'paste' },
        { label: t('desktop.menu.selectAll'), role: 'selectAll' },
      ],
    },
    {
      label: t('desktop.menu.view'),
      submenu: [
        { label: t('desktop.menu.home'), accelerator: 'Cmd+Shift+H', click: () => d.openMain('/') },
        { label: t('desktop.menu.reload'), role: 'reload' },
        { type: 'separator' },
        { label: t('desktop.menu.resetZoom'), role: 'resetZoom' },
        { label: t('desktop.menu.zoomIn'), role: 'zoomIn' },
        { label: t('desktop.menu.zoomOut'), role: 'zoomOut' },
        { type: 'separator' },
        { label: t('desktop.menu.fullscreen'), role: 'togglefullscreen' },
      ],
    },
    {
      label: t('desktop.menu.window'),
      submenu: [
        { label: t('desktop.menu.minimize'), role: 'minimize' },
        { label: t('desktop.menu.close'), role: 'close' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Right-click menu of the web page: spelling, clipboard and links. */
export function attachContextMenu(d: DesktopApp, contents: WebContents): void {
  contents.on('context-menu', (_event, params) => {
    const t = d.t;
    const items: MenuItemConstructorOptions[] = [];
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      items.push({
        label: t('desktop.menu.addToDictionary'),
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      });
      items.push({ type: 'separator' });
    }
    if (params.linkURL && /^(https?|mailto):/i.test(params.linkURL)) {
      const origin = d.origin;
      const decision = origin ? windowOpenDecision(params.linkURL, origin) : null;
      if (decision?.kind === 'navigate') {
        items.push({
          label: t('desktop.menu.openInNewWindow'),
          click: () => d.extras.open(decision.path),
        });
      }
      items.push(
        {
          label: t('desktop.menu.openInBrowser'),
          click: () => void shell.openExternal(params.linkURL),
        },
        { label: t('desktop.menu.copyLink'), click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    const f = params.editFlags;
    if (params.isEditable) {
      items.push(
        { label: t('desktop.menu.cut'), role: 'cut', enabled: f.canCut },
        { label: t('desktop.menu.copy'), role: 'copy', enabled: f.canCopy },
        { label: t('desktop.menu.paste'), role: 'paste', enabled: f.canPaste },
        { label: t('desktop.menu.selectAll'), role: 'selectAll', enabled: f.canSelectAll },
      );
    } else if (params.selectionText) {
      items.push({ label: t('desktop.menu.copy'), role: 'copy' });
    }
    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length > 0) Menu.buildFromTemplate(items).popup();
  });
}
