// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/random-port/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT_OPTIONS, randomPort, randomPorts } from './logic';

describe('random-port', () => {
  it('stays within the range', () => {
    for (let i = 0; i < 200; i++) {
      const p = randomPort(DEFAULT_PORT_OPTIONS);
      expect(p).toBeGreaterThanOrEqual(1024);
      expect(p).toBeLessThanOrEqual(65535);
    }
  });

  it('is deterministic with an injected RNG', () => {
    expect(randomPort({ min: 0, max: 9 }, () => 0.5)).toBe(5);
    expect(randomPort({ min: 1024, max: 65535 }, () => 0)).toBe(1024);
    expect(randomPort({ min: 1024, max: 65535 }, () => 0.999999)).toBe(65535);
  });

  it('returns unique ports and caps at the range size', () => {
    const ports = randomPorts(100, { min: 1, max: 5 });
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.length).toBe(5);
  });

  it('throws when min is greater than max', () => {
    expect(() => randomPort({ min: 10, max: 5 })).toThrow();
  });

  it('always returns the single value when min equals max', () => {
    for (let i = 0; i < 20; i++) {
      expect(randomPort({ min: 42, max: 42 })).toBe(42);
    }
    expect(randomPorts(5, { min: 42, max: 42 })).toEqual([42]);
  });

  it('returns an empty array when count is 0', () => {
    expect(randomPorts(0, DEFAULT_PORT_OPTIONS)).toEqual([]);
  });

  it('randomPorts stays within range and unique for a count under the span', () => {
    const opts = { min: 100, max: 200 };
    const ports = randomPorts(20, opts);
    expect(ports.length).toBe(20);
    expect(new Set(ports).size).toBe(20);
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(100);
      expect(p).toBeLessThanOrEqual(200);
    }
  });

  it('returns every port in the range when count equals the span', () => {
    const ports = randomPorts(5, { min: 1, max: 5 });
    expect(ports.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});
