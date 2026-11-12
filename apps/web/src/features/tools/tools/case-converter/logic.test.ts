// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/case-converter/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { CASE_MODES, convertCase, splitWords } from './logic';

describe('case-converter', () => {
  it('splits camelCase, snake and separators into words', () => {
    expect(splitWords('helloWorld')).toEqual(['hello', 'World']);
    expect(splitWords('hello_world-foo bar')).toEqual(['hello', 'world', 'foo', 'bar']);
    expect(splitWords('HTTPServer')).toEqual(['HTTP', 'Server']);
  });

  it('converts to common cases', () => {
    const s = 'hello world example';
    expect(convertCase(s, 'camel')).toBe('helloWorldExample');
    expect(convertCase(s, 'pascal')).toBe('HelloWorldExample');
    expect(convertCase(s, 'snake')).toBe('hello_world_example');
    expect(convertCase(s, 'kebab')).toBe('hello-world-example');
    expect(convertCase(s, 'constant')).toBe('HELLO_WORLD_EXAMPLE');
  });

  it('round-trips through camel and back to words', () => {
    expect(convertCase('user_id_value', 'camel')).toBe('userIdValue');
    expect(convertCase('userIdValue', 'snake')).toBe('user_id_value');
  });

  it('handles empty input', () => {
    expect(convertCase('', 'camel')).toBe('');
  });

  it('handles whitespace-only and separator-only input', () => {
    expect(convertCase('   ', 'camel')).toBe('');
    expect(convertCase('___---', 'snake')).toBe('');
  });

  it('splits on digit boundaries', () => {
    expect(splitWords('abc123def')).toEqual(['abc', '123', 'def']);
    expect(splitWords('version2Update')).toEqual(['version', '2', 'Update']);
  });

  it('drops non-ASCII letters as separators (ASCII-only word splitting)', () => {
    // Accented/unicode letters aren't in [a-zA-Z0-9], so they act as
    // separators and are stripped rather than preserved.
    expect(splitWords('café bar')).toEqual(['caf', 'bar']);
  });

  it('converts to title, sentence, lower, upper, dot and path case', () => {
    const s = 'hello world example';
    expect(convertCase(s, 'title')).toBe('Hello World Example');
    expect(convertCase(s, 'sentence')).toBe('Hello world example');
    expect(convertCase('Hello World', 'lower')).toBe('hello world');
    expect(convertCase('hello world', 'upper')).toBe('HELLO WORLD');
    expect(convertCase(s, 'dot')).toBe('hello.world.example');
    expect(convertCase(s, 'path')).toBe('hello/world/example');
  });

  it('is idempotent for snake and kebab case', () => {
    const snake = convertCase('Hello World', 'snake');
    expect(convertCase(snake, 'snake')).toBe(snake);
    const kebab = convertCase('Hello World', 'kebab');
    expect(convertCase(kebab, 'kebab')).toBe(kebab);
  });

  it('keeps every CASE_MODES example consistent with convertCase output', () => {
    for (const { mode, example } of CASE_MODES) {
      expect(convertCase('hello world', mode)).toBe(example);
    }
  });
});
