// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/wifi-qr/logic.ts. See THIRD_PARTY.md.
/**
 * Build the `WIFI:` payload string encoded by Wi-Fi network QR codes. Pure and
 * local. Special characters are escaped per the de-facto spec.
 */

export type WifiEncryption = 'WPA' | 'WEP' | 'nopass';

export interface WifiConfig {
  ssid: string;
  password: string;
  encryption: WifiEncryption;
  hidden: boolean;
}

/** Escape `\ ; , : "` which are meaningful in the WIFI payload grammar. */
export function escapeWifi(value: string): string {
  return value.replace(/([\\;,:"])/g, '\\$1');
}

export function wifiPayload({ ssid, password, encryption, hidden }: WifiConfig): string {
  const parts = [`T:${encryption}`, `S:${escapeWifi(ssid)}`];
  if (encryption !== 'nopass') parts.push(`P:${escapeWifi(password)}`);
  if (hidden) parts.push('H:true');
  return `WIFI:${parts.join(';')};;`;
}
