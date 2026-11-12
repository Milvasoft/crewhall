import { describe, expect, it } from 'vitest';

// Every source file as text (Vite glob, no fs access needed).
const sources = import.meta.glob<string>('../src/**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('doc 02 · 9.4 component rules', () => {
  it('uses the shared pickers instead of native date and time inputs', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const native = /type=["'](date|time|datetime-local|month|week)["']/;
    const offenders = Object.entries(sources)
      .filter(([, text]) => native.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
