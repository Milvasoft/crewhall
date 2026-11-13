import { ipcMain, type WebContents } from 'electron';
import { NOTIFY_SOUND, type NotificationSound } from '../common/ipc';
import type { DesktopApp } from './app';

/**
 * The chat sound of a native notification. Windows' own toast sound depends on the person's
 * notification settings (and goes quiet with do not disturb), and played next to the web's chime
 * it rang twice. So a page that has the app's chime (bridge `onNotificationSound`) plays it when
 * the notification shows and the toast itself stays silent; a page without one (an older web
 * app, the offline page) keeps the system sound.
 */
export class NotifySound {
  /** Pages (webContents ids) that play the chime themselves. */
  private readonly listening = new Set<number>();

  constructor(private readonly d: DesktopApp) {}

  register(): void {
    ipcMain.on(NOTIFY_SOUND.listen, (e, on: unknown) => {
      if (!this.d.isAppPage(e.sender)) return;
      const contents = e.sender;
      if (on === true) {
        if (this.listening.has(contents.id)) return;
        this.listening.add(contents.id);
        const forget = () => this.listening.delete(contents.id);
        contents.once('destroyed', forget);
        // A new document has to say it again.
        contents.once('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) forget();
        });
      } else {
        this.listening.delete(contents.id);
      }
    });
  }

  /** Whether `contents` plays the chime itself (then the toast is silent). */
  listens(contents: WebContents | null | undefined): contents is WebContents {
    return !!contents && !contents.isDestroyed() && this.listening.has(contents.id);
  }

  play(contents: WebContents, sound: NotificationSound): void {
    if (this.listens(contents)) contents.send(NOTIFY_SOUND.play, sound);
  }
}
