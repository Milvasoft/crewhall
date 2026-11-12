// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-lookup/logic.ts. See THIRD_PARTY.md.
import { parseOui } from '@/features/tools/lib/net/mac';
import { OUI } from './oui-data';

export interface LookupResult {
  oui: string;
  /** Formatted OUI, e.g. "20:37:06". */
  ouiFormatted: string;
  vendor: string | null;
  /** True when the MAC's second-least-significant bit of octet 1 is set. */
  locallyAdministered: boolean;
  /** True for a multicast/group address (LSB of octet 1 set). */
  multicast: boolean;
}

/** Look up the vendor for a MAC address or OUI from the bundled dataset. */
export function lookupMac(input: string): LookupResult {
  const oui = parseOui(input);
  const firstOctet = parseInt(oui.slice(0, 2), 16);
  return {
    oui,
    ouiFormatted: `${oui.slice(0, 2)}:${oui.slice(2, 4)}:${oui.slice(4, 6)}`,
    vendor: OUI[oui] ?? null,
    locallyAdministered: (firstOctet & 0b10) !== 0,
    multicast: (firstOctet & 0b1) !== 0,
  };
}
