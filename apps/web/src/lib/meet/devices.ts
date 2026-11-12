import { useCallback, useEffect, useState } from 'react';
import { type useI18n } from '@/lib/i18n/I18nContext';

/**
 * The devices of one kind for the meeting's device menus. Unlike LiveKit's list it shows what the
 * browser (or the desktop app) reports even without permission: devices then have no labels, so
 * they get numbered names ("Kamera 1") and the menu offers "İzin ver". The list follows plugging
 * and unplugging (devicechange).
 */
export function useMediaDevices(kind: MediaDeviceKind) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(() => listDevices(kind).then(setDevices), [kind]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      void listDevices(kind).then((list) => {
        if (alive) setDevices(list);
      });
    load();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    md?.addEventListener?.('devicechange', load);
    return () => {
      alive = false;
      md?.removeEventListener?.('devicechange', load);
    };
  }, [kind]);

  /** Asks for the camera or microphone once (labels come with it), then lists again. */
  const allow = useCallback(async () => {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) return false;
    try {
      const stream = await md.getUserMedia(
        kind === 'videoinput' ? { video: true } : { audio: true },
      );
      stream.getTracks().forEach((tr) => tr.stop());
      return true;
    } catch {
      return false;
    } finally {
      await refresh();
    }
  }, [kind, refresh]);

  // Without permission browsers hide labels (and sometimes list one blank entry per kind).
  const needsPermission = devices.length === 0 || devices.every((d) => !d.label);
  return { devices, needsPermission, allow, refresh };
}

async function listDevices(kind: MediaDeviceKind): Promise<MediaDeviceInfo[]> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!md?.enumerateDevices) return [];
  try {
    return (await md.enumerateDevices()).filter((d) => d.kind === kind);
  } catch {
    return [];
  }
}

/** "Kamera 2" when the device has no label yet (no permission). */
export function deviceLabel(
  d: MediaDeviceInfo,
  index: number,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (d.label) return d.label;
  const key =
    d.kind === 'videoinput'
      ? 'meet.devices.camera'
      : d.kind === 'audiooutput'
        ? 'meet.devices.speaker'
        : 'meet.devices.microphone';
  return t(key, { n: index + 1 });
}
