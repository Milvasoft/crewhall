/** Matches electron-builder's appId, and with it the Start Menu shortcut's id. */
const APP_ID = 'com.crewhall.desktop';

/**
 * The id Windows groups taskbar buttons by and keeps per app: toast senders, autostart's value name,
 * usage counts. A development run is electron.exe, with Electron's icon, and must not share these
 * with an installed app on the same computer.
 */
export function appUserModelId(packaged: boolean): string {
  return packaged ? APP_ID : `${APP_ID}.dev`;
}
