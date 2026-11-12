// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jsonpath/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { queryJsonPath } from './logic';

const DOC = JSON.stringify({
  store: {
    book: [
      { author: 'Ada', price: 10 },
      { author: 'Grace', price: 20 },
    ],
  },
});

describe('jsonpath', () => {
  it('selects nested array values', () => {
    expect(queryJsonPath(DOC, '$.store.book[*].author').values).toEqual(['Ada', 'Grace']);
  });

  it('supports filters', () => {
    expect(queryJsonPath(DOC, '$.store.book[?(@.price>15)].author').values).toEqual(['Grace']);
  });

  it('returns pointers for matches', () => {
    const r = queryJsonPath(DOC, '$.store.book[0].author');
    expect(r.values).toEqual(['Ada']);
    expect(r.paths[0]).toContain('book');
  });

  it('returns empty for no match', () => {
    expect(queryJsonPath(DOC, '$.nope').values).toEqual([]);
  });

  it('returns empty for a whitespace-only path', () => {
    expect(queryJsonPath(DOC, '   ')).toEqual({ values: [], paths: [] });
  });

  it('returns the whole document for the root path', () => {
    expect(queryJsonPath(DOC, '$').values).toEqual([JSON.parse(DOC)]);
  });

  it('returns empty for an empty JSON object', () => {
    expect(queryJsonPath('{}', '$.*').values).toEqual([]);
  });

  it('finds every match with recursive descent, values and paths aligned', () => {
    const r = queryJsonPath(DOC, '$..author');
    expect(r.values).toEqual(['Ada', 'Grace']);
    expect(r.paths).toHaveLength(r.values.length);
  });

  it('throws for malformed JSON input', () => {
    expect(() => queryJsonPath('{not valid json', '$.a')).toThrow();
  });

  it('throws for a syntactically invalid JSONPath filter expression', () => {
    expect(() => queryJsonPath(DOC, '$..[?(@.price==)]')).toThrow();
  });
});
