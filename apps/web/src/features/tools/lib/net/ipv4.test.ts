// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/net/ipv4.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { ipToLong, longToIp, maskToPrefix, parseCidr, prefixToMask } from './ipv4';

describe('ipv4 helpers', () => {
  it('round-trips dotted quad and integer', () => {
    expect(ipToLong('192.168.1.1')).toBe(3232235777);
    expect(longToIp(3232235777)).toBe('192.168.1.1');
    expect(longToIp(ipToLong('255.255.255.255'))).toBe('255.255.255.255');
    expect(ipToLong('0.0.0.0')).toBe(0);
  });

  it('rejects malformed addresses', () => {
    expect(() => ipToLong('1.2.3')).toThrow();
    expect(() => ipToLong('256.0.0.1')).toThrow();
    expect(() => ipToLong('a.b.c.d')).toThrow();
  });

  it('converts prefix and mask both ways', () => {
    expect(prefixToMask(24)).toBe(ipToLong('255.255.255.0'));
    expect(prefixToMask(0)).toBe(0);
    expect(maskToPrefix(ipToLong('255.255.255.0'))).toBe(24);
    expect(maskToPrefix(ipToLong('255.255.0.0'))).toBe(16);
  });

  it('rejects non-contiguous masks', () => {
    expect(() => maskToPrefix(ipToLong('255.0.255.0'))).toThrow();
  });

  it('parses CIDR, plain and mask forms', () => {
    expect(parseCidr('10.0.0.1/8')).toEqual({ ip: '10.0.0.1', prefix: 8 });
    expect(parseCidr('10.0.0.1')).toEqual({ ip: '10.0.0.1', prefix: 32 });
    expect(parseCidr('10.0.0.1 255.255.255.0')).toEqual({
      ip: '10.0.0.1',
      prefix: 24,
    });
  });
});
