// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/mac-address-lookup/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { lookupMac } from './logic';

describe('mac-address-lookup', () => {
  it('resolves a known vendor from a full MAC', () => {
    const r = lookupMac('20:37:06:12:34:56');
    expect(r.vendor).toBe('Cisco Systems, Inc');
    expect(r.ouiFormatted).toBe('20:37:06');
  });

  it('accepts different separators and a bare OUI', () => {
    expect(lookupMac('000C29').vendor).toBe('VMware, Inc.');
    expect(lookupMac('08-00-27-aa-bb-cc').vendor).toBe('VirtualBox (virtual)');
    expect(lookupMac('b827.eb00.0000').vendor).toBe('Raspberry Pi Foundation');
  });

  it('returns null vendor for unknown prefixes', () => {
    expect(lookupMac('123456').vendor).toBeNull();
  });

  it('detects locally-administered and multicast bits', () => {
    // 02:... has the locally-administered bit set.
    expect(lookupMac('020000').locallyAdministered).toBe(true);
    // 01:... has the multicast bit set.
    expect(lookupMac('010000').multicast).toBe(true);
  });

  it('rejects too-short input', () => {
    expect(() => lookupMac('00:11')).toThrow();
  });

  it('rejects empty and non-hex input', () => {
    expect(() => lookupMac('')).toThrow();
    expect(() => lookupMac('GGGGGG')).toThrow();
  });

  it('sets both locally-administered and multicast bits for an odd, bit-1-set first octet', () => {
    // 0x03 = 0b00000011: bit0 (multicast) and bit1 (locally administered) both set.
    const r = lookupMac('030000');
    expect(r.locallyAdministered).toBe(true);
    expect(r.multicast).toBe(true);
  });

  it('clears both bits for a normal globally-administered unicast OUI', () => {
    // 0x20 = 0b00100000: neither bit0 nor bit1 set.
    const r = lookupMac('20:37:06:12:34:56');
    expect(r.locallyAdministered).toBe(false);
    expect(r.multicast).toBe(false);
  });

  it('returns the raw and formatted OUI for a known vendor', () => {
    const r = lookupMac('00:03:93:aa:bb:cc');
    expect(r.oui).toBe('000393');
    expect(r.ouiFormatted).toBe('00:03:93');
    expect(r.vendor).toBe('Apple, Inc.');
  });

  it('only uses the first three octets, ignoring the rest of a longer input', () => {
    const withExtra = lookupMac('20:37:06:99:99:99:99:99');
    expect(withExtra.oui).toBe('203706');
    expect(withExtra.vendor).toBe('Cisco Systems, Inc');
  });
});
