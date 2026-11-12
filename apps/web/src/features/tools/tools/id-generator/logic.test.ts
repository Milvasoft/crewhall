// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/id-generator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { generate, generateMany, ulid, uuidV4, uuidV7 } from './logic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('id-generator', () => {
  it('generates valid v4 UUIDs with correct version/variant', () => {
    const id = uuidV4();
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe('4');
    expect('89ab').toContain(id[19]);
  });

  it('generates v7 UUIDs that sort by time', () => {
    const a = uuidV7(1_000_000_000_000);
    const b = uuidV7(1_000_000_000_001);
    expect(a).toMatch(UUID_RE);
    expect(a[14]).toBe('7');
    expect(a < b).toBe(true); // lexicographic order tracks time
  });

  it('generates 26-char ULIDs that sort by time', () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(1_000_000_000_001);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });

  it('produces unique ids in bulk', () => {
    const ids = generateMany('uuid4', { count: 500 });
    expect(new Set(ids).size).toBe(500);
  });

  it('respects formatting options', () => {
    const [id] = generateMany('uuid4', {
      count: 1,
      hyphens: false,
      uppercase: true,
      braces: true,
    });
    expect(id).toMatch(/^\{[0-9A-F]{32}\}$/);
  });

  it("encodes the given timestamp into the v7 UUID's first 48 bits", () => {
    const now = 1_700_000_000_123;
    const id = uuidV7(now);
    const hex = id.replace(/-/g, '').slice(0, 12);
    expect(parseInt(hex, 16)).toBe(now);
  });

  it('generate() dispatches to the right shape per kind', () => {
    expect(generate('uuid4')).toMatch(UUID_RE);
    expect(generate('uuid7')[14]).toBe('7');
    expect(generate('guid')).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );
    expect(generate('ulid')).toHaveLength(26);
  });

  it('ULID only uses Crockford base32 characters (no I, L, O, U)', () => {
    const id = ulid(1_000_000_000_000);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('clamps count to [0, 10000]', () => {
    expect(generateMany('uuid4', { count: 0 })).toHaveLength(0);
    expect(generateMany('uuid4', { count: -5 })).toHaveLength(0);
    expect(generateMany('uuid4', { count: 20000 })).toHaveLength(10000);
  });

  it('guid kind stays uppercase with hyphens by default', () => {
    const [id] = generateMany('guid', { count: 1 });
    expect(id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  });

  it('uuid4 kind defaults to lowercase', () => {
    const [id] = generateMany('uuid4', { count: 1 });
    expect(id).toMatch(/^[0-9a-f-]+$/);
  });

  it('ULID respects the uppercase:false option', () => {
    const [id] = generateMany('ulid', { count: 1, uppercase: false });
    expect(id).toBe(id!.toLowerCase());
    expect(id).toHaveLength(26);
  });

  it('ULID stays uppercase (Crockford alphabet) when uppercase is unset', () => {
    const [id] = generateMany('ulid', { count: 1 });
    expect(id).toBe(id!.toUpperCase());
  });

  it('produces unique ULIDs and v7 UUIDs in bulk', () => {
    expect(new Set(generateMany('ulid', { count: 200 })).size).toBe(200);
    expect(new Set(generateMany('uuid7', { count: 200 })).size).toBe(200);
  });
});
