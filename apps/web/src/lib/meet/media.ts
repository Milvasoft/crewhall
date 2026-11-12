/**
 * Camera, microphone and screen capture need a secure context (https or localhost). Opened over
 * plain http on the LAN, `navigator.mediaDevices` is missing; the meeting screens then let people
 * listen and say why they cannot speak instead of failing with a TypeError.
 */
export function mediaAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * Dev over https (VITE_DEV_HTTPS): the page may not open ws:// to LiveKit (mixed content), so
 * signalling goes through the dev server's `/livekit` proxy (vite.config.ts). Production serves
 * LiveKit on wss:// and the URL is used as it is.
 */
export function liveKitUrl(url: string): string {
  if (import.meta.env.DEV && window.location.protocol === 'https:' && url.startsWith('ws://')) {
    return `wss://${window.location.host}/livekit`;
  }
  return url;
}
