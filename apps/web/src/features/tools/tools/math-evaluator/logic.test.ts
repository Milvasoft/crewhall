// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/math-evaluator/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { evaluateExpression as ev } from './logic';

describe('math-evaluator', () => {
  it('respects operator precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 % 3')).toBe(1);
  });

  it('handles right-associative power and unary minus', () => {
    expect(ev('2 ^ 3 ^ 2')).toBe(512);
    expect(ev('-2 ^ 2')).toBe(-4);
    expect(ev('2 * -3')).toBe(-6);
  });

  it('evaluates functions and constants', () => {
    expect(ev('sqrt(16)')).toBe(4);
    expect(ev('max(1, 5, 3)')).toBe(5);
    expect(ev('log(8, 2)')).toBeCloseTo(3);
    expect(ev('cos(0)')).toBe(1);
    expect(ev('2 * pi')).toBeCloseTo(Math.PI * 2);
  });

  it('supports scientific notation', () => {
    expect(ev('1.5e3 + 500')).toBe(2000);
  });

  it('throws on malformed input', () => {
    expect(() => ev('1 +')).toThrow();
    expect(() => ev('foo(2)')).toThrow();
    expect(() => ev('2 3')).toThrow();
    expect(() => ev('')).toThrow();
  });

  it('throws on whitespace-only input', () => {
    expect(() => ev('   ')).toThrow();
  });

  it('throws on unbalanced parentheses', () => {
    expect(() => ev('(1 + 2')).toThrow();
    expect(() => ev('1 + 2)')).toThrow();
    expect(() => ev('()')).toThrow();
  });

  it('does not evaluate arbitrary JavaScript for unknown/global-looking names', () => {
    expect(() => ev('process')).toThrow();
    expect(() => ev('[]["filter"]')).toThrow();
    expect(() => ev('eval(1)')).toThrow();
    expect(() => ev('this')).toThrow();
    expect(() => ev('toString()')).toThrow();
    expect(() => ev('hasOwnProperty()')).toThrow();
  });

  it('division and modulo by zero follow IEEE 754 rather than throwing', () => {
    expect(ev('1 / 0')).toBe(Infinity);
    expect(ev('-1 / 0')).toBe(-Infinity);
    expect(Number.isNaN(ev('0 % 0'))).toBe(true);
  });

  it('collapses repeated unary operators', () => {
    expect(ev('--5')).toBe(5);
    expect(ev('-+-5')).toBe(5);
  });

  it('evaluates the e, tau, and phi constants', () => {
    expect(ev('e')).toBeCloseTo(Math.E);
    expect(ev('tau')).toBeCloseTo(Math.PI * 2);
    expect(ev('phi')).toBeCloseTo((1 + Math.sqrt(5)) / 2);
  });

  it('rejects trailing input after a complete expression', () => {
    expect(() => ev('(1)(2)')).toThrow();
    expect(() => ev('1 2')).toThrow();
  });
});
