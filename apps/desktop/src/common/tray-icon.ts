/** Which Crewhall mark the tray shows (assets/<variant>.png, 16/20/24/32 px). */
export type TrayVariant = 'tray-light' | 'tray-dark' | 'trayTemplate';

/**
 * By the taskbar's own theme, not the apps' one: Windows can pair a dark taskbar with light
 * apps (SystemUsesLightTheme = 0), where the graphite mark disappears. macOS colours a template
 * image itself; Linux panels are mostly dark, so the white mark.
 */
export function trayVariant(platform: string, darkSystemUi: boolean): TrayVariant {
  if (platform === 'darwin') return 'trayTemplate';
  if (platform === 'win32') return darkSystemUi ? 'tray-dark' : 'tray-light';
  return 'tray-dark';
}

/** The scale factors the tray PNGs come in (16, 20, 24 and 32 px). */
export const TRAY_SCALES = [1, 1.25, 1.5, 2] as const;
