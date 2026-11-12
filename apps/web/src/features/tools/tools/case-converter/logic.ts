// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/case-converter/logic.ts. See THIRD_PARTY.md.
export type CaseMode =
  | 'lower'
  | 'upper'
  | 'title'
  | 'sentence'
  | 'camel'
  | 'pascal'
  | 'snake'
  | 'kebab'
  | 'constant'
  | 'dot'
  | 'path';

/**
 * Split text into words, handling camelCase/PascalCase boundaries, digits and
 * any non-alphanumeric separators. This is the basis every case transform
 * builds on, so conversions are consistent across formats.
 */
export function splitWords(input: string): string[] {
  return (
    input
      // insert spaces at camelCase boundaries and around digit runs
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
      .replace(/([0-9])([a-zA-Z])/g, '$1 $2')
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
  );
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

export function convertCase(input: string, mode: CaseMode): string {
  const words = splitWords(input);
  if (words.length === 0) return '';

  switch (mode) {
    case 'lower':
      return words.join(' ').toLowerCase();
    case 'upper':
      return words.join(' ').toUpperCase();
    case 'title':
      return words.map(cap).join(' ');
    case 'sentence': {
      const s = words.join(' ').toLowerCase();
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    case 'camel':
      return words.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w))).join('');
    case 'pascal':
      return words.map(cap).join('');
    case 'snake':
      return words.map((w) => w.toLowerCase()).join('_');
    case 'kebab':
      return words.map((w) => w.toLowerCase()).join('-');
    case 'constant':
      return words.map((w) => w.toUpperCase()).join('_');
    case 'dot':
      return words.map((w) => w.toLowerCase()).join('.');
    case 'path':
      return words.map((w) => w.toLowerCase()).join('/');
  }
}

export const CASE_MODES: { mode: CaseMode; label: string; example: string }[] = [
  { mode: 'camel', label: 'camelCase', example: 'helloWorld' },
  { mode: 'pascal', label: 'PascalCase', example: 'HelloWorld' },
  { mode: 'snake', label: 'snake_case', example: 'hello_world' },
  { mode: 'kebab', label: 'kebab-case', example: 'hello-world' },
  { mode: 'constant', label: 'CONSTANT_CASE', example: 'HELLO_WORLD' },
  { mode: 'title', label: 'Title Case', example: 'Hello World' },
  { mode: 'sentence', label: 'Sentence case', example: 'Hello world' },
  { mode: 'lower', label: 'lower case', example: 'hello world' },
  { mode: 'upper', label: 'UPPER CASE', example: 'HELLO WORLD' },
  { mode: 'dot', label: 'dot.case', example: 'hello.world' },
  { mode: 'path', label: 'path/case', example: 'hello/world' },
];
