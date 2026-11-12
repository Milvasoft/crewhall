// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-table/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { ASCII_TABLE, filterAscii } from './logic';

describe('ascii-table', () => {
  it('has 128 rows', () => {
    expect(ASCII_TABLE).toHaveLength(128);
  });

  it('describes control codes and printable chars', () => {
    const nul = ASCII_TABLE[0]!;
    expect(nul.name).toBe('NUL');
    expect(nul.printable).toBe(false);

    const A = ASCII_TABLE[65]!;
    expect(A.glyph).toBe('A');
    expect(A.hex).toBe('41');
    expect(A.binary).toBe('01000001');
    expect(A.printable).toBe(true);
  });

  it('filters by decimal, hex and name', () => {
    expect(filterAscii('65')[0]!.glyph).toBe('A');
    expect(filterAscii('0x41')[0]!.glyph).toBe('A');
    // "escape" matches both DLE ("Data Link Escape") and ESC by description.
    expect(filterAscii('escape').some((r) => r.dec === 27)).toBe(true);
    // An exact-name query resolves to the single control code.
    expect(filterAscii('esc').some((r) => r.name === 'ESC')).toBe(true);
  });

  it('returns the full table for an empty query', () => {
    expect(filterAscii('')).toHaveLength(128);
  });

  it('treats a whitespace-only query as empty', () => {
    expect(filterAscii('   ')).toHaveLength(128);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterAscii('zzz notfound')).toEqual([]);
  });

  it('matches a bare digit both as a decimal code and as the printable glyph itself', () => {
    // "6" matches dec===6 exactly, and also the glyph/name of the printable
    // character '6' (dec 54) since name matching is substring-based.
    const codes = filterAscii('6').map((r) => r.dec);
    expect(codes).toContain(6);
    expect(codes).toContain(54);
    expect(codes).not.toContain(65);
  });

  it('marks the boundary codes correctly (space, DEL, tilde)', () => {
    const space = ASCII_TABLE[32]!;
    expect(space.printable).toBe(false);
    expect(space.name).toBe('SP');

    const tilde = ASCII_TABLE[126]!;
    expect(tilde.printable).toBe(true);
    expect(tilde.glyph).toBe('~');

    const del = ASCII_TABLE[127]!;
    expect(del.printable).toBe(false);
    expect(del.name).toBe('DEL');
    expect(del.glyph).toBe('DEL');
  });

  it('pads hex, octal and binary for low codes', () => {
    const nul = ASCII_TABLE[0]!;
    expect(nul.hex).toBe('00');
    expect(nul.oct).toBe('000');
    expect(nul.binary).toBe('00000000');
  });
});
