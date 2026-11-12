import {
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron';
import { badgeBitmap, badgeLabel, withDot } from '../common/badge';
import { STARTUP_SETTINGS_URL } from '../common/store';
import { TRAY_SCALES, trayVariant } from '../common/tray-icon';
import type { DesktopApp } from './app';
import { asset } from './paths';

/** Tray icon: unread dot (Windows) or count (macOS), sync state and the quick menu. */
export class TrayController {
  private tray: Tray | null = null;
  private overlays = new Map<string, NativeImage>();

  constructor(private readonly d: DesktopApp) {}

  create(): void {
    this.tray = new Tray(this.icon(false));
    // The taskbar went light or dark: the matching mark.
    nativeTheme.on('updated', () => this.refresh());
    // Windows: a click opens the window, the menu is on right click. macOS: click shows the menu.
    this.tray.on('click', () => {
      if (process.platform === 'darwin') return;
      if (this.d.main?.isVisible() && this.d.main.isFocused()) this.d.main.hide();
      else this.d.showMain();
    });
    this.refresh();
  }

  /** Taskbar overlay with the unread count (Windows). */
  overlayFor(count: number): NativeImage | null {
    const label = badgeLabel(count);
    if (!label) return null;
    let image = this.overlays.get(label);
    if (!image) {
      image = nativeImage.createFromBitmap(badgeBitmap(label, 32), {
        width: 32,
        height: 32,
        scaleFactor: 2,
      });
      this.overlays.set(label, image);
    }
    return image;
  }

  private icon(unread: boolean): NativeImage {
    const variant = trayVariant(
      process.platform,
      nativeTheme.shouldUseDarkColorsForSystemIntegratedUI,
    );
    if (variant === 'trayTemplate') {
      const template = nativeImage.createFromPath(asset('trayTemplate.png'));
      template.setTemplateImage(true);
      return template;
    }
    // The org's mark when it has one (32 px drawn at 16 pt), else Crewhall's in every size.
    const brand = this.d.brandIcon;
    const base = brand
      ? brand.resize({ width: 32, height: 32, quality: 'best' })
      : nativeImage.createFromPath(asset(`${variant}.png`));
    if (!unread) return base;
    // The unread dot on each size the mark comes in: read the pixels, not the point size.
    const out = nativeImage.createEmpty();
    for (const scaleFactor of brand ? [2] : TRAY_SCALES) {
      const bitmap = base.toBitmap({ scaleFactor });
      const px = Math.round(Math.sqrt(bitmap.length / 4));
      out.addRepresentation({
        buffer: withDot(bitmap, px),
        width: px,
        height: px,
        scaleFactor,
      });
    }
    return out;
  }

  refresh(): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;
    const d = this.d;
    const t = d.t;
    const unread = d.badge;

    tray.setImage(this.icon(unread > 0));
    if (process.platform === 'darwin') tray.setTitle(badgeLabel(unread));

    const statuses = d.syncStatuses;
    const syncing = statuses.some((s) => s.state === 'syncing');
    const problem = statuses.some((s) => s.state === 'error' || s.state === 'confirm');
    const org = d.settings.get().brand?.orgName;
    const inMeeting = d.meetings.count > 0;
    tray.setToolTip(
      [org ? `${d.appName} · ${org}` : d.appName]
        .concat(inMeeting ? [t('desktop.meeting.inMeeting')] : [])
        .concat([t('desktop.tray.unread', { count: unread })])
        .concat(
          syncing ? [t('desktop.tray.syncing')] : problem ? [t('desktop.tray.syncProblem')] : [],
        )
        .join('\n'),
    );

    const connected = !!d.origin;
    const items: MenuItemConstructorOptions[] = [
      ...(inMeeting
        ? ([
            { label: t('desktop.meeting.backToMeeting'), click: () => d.meetings.focusLatest() },
            { type: 'separator' },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { label: t('desktop.tray.open'), click: () => d.showMain(), enabled: connected },
      { label: t('desktop.tray.home'), click: () => d.openMain('/'), enabled: connected },
      { type: 'separator' },
      { label: t('desktop.tray.unread', { count: unread }), enabled: false },
    ];
    if (statuses.length > 0) {
      items.push({
        label: syncing
          ? t('desktop.tray.syncing')
          : problem
            ? t('desktop.tray.syncProblem')
            : t('desktop.tray.syncNow'),
        enabled: !syncing,
        click: () => (problem ? d.openSettings('sync') : d.sync.syncNow()),
      });
    }
    items.push(
      { type: 'separator' },
      { label: t('desktop.tray.settings'), click: () => d.openSettings() },
      // The Store build's startup task is Windows' to switch: the item opens its page.
      d.dist.loginItem === 'system'
        ? {
            label: t('desktop.tray.autostartStore'),
            click: () => void shell.openExternal(STARTUP_SETTINGS_URL),
          }
        : {
            label: t('desktop.tray.autostart'),
            type: 'checkbox',
            checked: d.autostart,
            click: (item) => d.setAutostart(item.checked),
          },
    );
    if (d.updater.state.state === 'downloaded') {
      items.push({ label: t('desktop.tray.installUpdate'), click: () => d.updater.install() });
    }
    items.push({ type: 'separator' }, { label: t('desktop.tray.quit'), click: () => d.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }
}
