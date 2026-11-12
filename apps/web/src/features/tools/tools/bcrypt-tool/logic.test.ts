// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/bcrypt-tool/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { detectCost, hashPassword, verifyPassword } from './logic';

describe('bcrypt-tool', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('correct horse', 6);
    expect(hash.startsWith('$2')).toBe(true);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  it('verifies against a known hash', async () => {
    // bcrypt hash of "password" at cost 10.
    const hash = '$2a$10$V6fjV.e7wcxmTa4IhE8acuUn0p1UkKFxgZLwCSHrdaIsH8EPlWiOC';
    expect(await verifyPassword('password', hash)).toBe(true);
    expect(await verifyPassword('Password', hash)).toBe(false);
  });

  it('detects the cost factor', () => {
    expect(detectCost('$2b$12$abcdefghijklmnopqrstuv')).toBe(12);
    expect(detectCost('not-a-hash')).toBeNull();
  });

  it('detects the cost factor across variant prefixes and whitespace', () => {
    expect(detectCost('$2a$04$abcdefghijklmnopqrstuv')).toBe(4);
    expect(detectCost('$2y$31$abcdefghijklmnopqrstuv')).toBe(31);
    expect(detectCost('$2$04$abcdefghijklmnopqrstuv')).toBe(4);
    expect(detectCost('  $2b$10$abcdefghijklmnopqrstuv  ')).toBe(10);
  });

  it('hashes and verifies at the minimum cost factor', async () => {
    const hash = await hashPassword('min-cost', 4);
    expect(detectCost(hash)).toBe(4);
    expect(await verifyPassword('min-cost', hash)).toBe(true);
  });

  it('hashes and verifies an empty password', async () => {
    const hash = await hashPassword('', 4);
    expect(await verifyPassword('', hash)).toBe(true);
    expect(await verifyPassword('not-empty', hash)).toBe(false);
  });

  it('returns false instead of throwing for a malformed hash', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });
});
