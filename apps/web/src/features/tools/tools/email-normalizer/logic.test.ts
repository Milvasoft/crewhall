// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/email-normalizer/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './logic';

describe('email-normalizer', () => {
  it('normalizes gmail (dots + tags)', () => {
    expect(normalizeEmail('John.Doe+news@gmail.com').normalized).toBe('johndoe@gmail.com');
    expect(normalizeEmail('a.b.c@googlemail.com').normalized).toBe('abc@gmail.com');
  });

  it('keeps dots for non-gmail but strips tags', () => {
    expect(normalizeEmail('a.b+promo@outlook.com').normalized).toBe('a.b@outlook.com');
  });

  it('reports whether it changed', () => {
    expect(normalizeEmail('plain@example.com').changed).toBe(false);
    expect(normalizeEmail('Plain@example.com').changed).toBe(true);
  });

  it('rejects invalid addresses', () => {
    expect(() => normalizeEmail('not-an-email')).toThrow();
    expect(() => normalizeEmail('@example.com')).toThrow();
  });

  it('rejects empty and whitespace-only input', () => {
    expect(() => normalizeEmail('')).toThrow();
    expect(() => normalizeEmail('   ')).toThrow();
  });

  it('rejects an address with nothing after the @', () => {
    expect(() => normalizeEmail('user@')).toThrow();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ').normalized).toBe('user@example.com');
  });

  it('is idempotent: normalizing an already-normalized address reports no change', () => {
    const once = normalizeEmail('John.Doe+news@gmail.com');
    const twice = normalizeEmail(once.normalized);
    expect(twice.normalized).toBe(once.normalized);
    expect(twice.changed).toBe(false);
  });

  it('preserves unicode characters in the local part', () => {
    expect(normalizeEmail('José.García+promo@gmail.com').normalized).toBe('joségarcía@gmail.com');
    expect(normalizeEmail('Ünïçödé@example.com').normalized).toBe('ünïçödé@example.com');
  });
});
