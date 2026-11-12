import { SNIPPET_MARK_END as E, SNIPPET_MARK_START as S } from '@crewhall/shared';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContentSnippet, plainSnippet } from '@/features/drive/pages/SearchPage';

/** Content matches in Drive search and Ctrl K (roadmap 10). */
describe('content search excerpts', () => {
  const text = `Ofis kira ${S}sözleşmeleri${E} 2026 … yeni ${S}sözleşme${E}`;

  it('marks the matched words without HTML from the server', () => {
    const { container } = render(<ContentSnippet text={`${text} <b>x</b>`} />);
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['sözleşmeleri', 'sözleşme']);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
  });

  it('drops the markers for plain rows', () => {
    expect(plainSnippet(text)).toBe('Ofis kira sözleşmeleri 2026 … yeni sözleşme');
  });
});
