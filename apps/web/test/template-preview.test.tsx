import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PagePreview, previewLines } from '@/components/templates/PagePreview';

/** B4: gallery previews show callouts and headings, never raw markdown markers. */

const RFC = `:::info[RFC]
Yazar: «yazar» · Durum: Taslak
:::

## Bağlam

Neden **bu** değişikliğe ihtiyaç var?

| Seçenek | Artı | Eksi |
| --- | --- | --- |
|  |  |  |

- Birinci risk

:::danger[SEV 2]
Etki: «etki»
:::`;

describe('template page preview (B4)', () => {
  it('turns directives, headings, tables and lists into preview lines', () => {
    expect(previewLines(RFC)).toEqual([
      { kind: 'callout', tone: 'info', title: 'RFC', text: 'Yazar: «yazar» · Durum: Taslak' },
      { kind: 'heading', text: 'Bağlam' },
      { kind: 'text', text: 'Neden bu değişikliğe ihtiyaç var?' },
      { kind: 'text', text: 'Seçenek · Artı · Eksi' },
      { kind: 'item', text: 'Birinci risk' },
      { kind: 'callout', tone: 'danger', title: 'SEV 2', text: 'Etki: «etki»' },
    ]);
  });

  it('renders callouts as boxes without the ::: markers', () => {
    const { container } = render(<PagePreview markdown={RFC} />);
    expect(container.textContent).not.toMatch(/:::|\[RFC\]|##|\*\*|\|/);
    const callouts = container.querySelectorAll('[data-preview="callout"]');
    expect([...callouts].map((c) => c.textContent)).toEqual([
      'RFCYazar: «yazar» · Durum: Taslak',
      'SEV 2Etki: «etki»',
    ]);
    expect(callouts[1]).toHaveClass('border-danger');
    expect(container.querySelector('[data-preview="heading"]')).toHaveTextContent('Bağlam');
  });

  it('skips blank list slots', () => {
    expect(previewLines('## Kararlar\n\n- \n\n## Aksiyonlar\n\n- [ ] \n- [ ] Rapor')).toEqual([
      { kind: 'heading', text: 'Kararlar' },
      { kind: 'heading', text: 'Aksiyonlar' },
      { kind: 'item', text: 'Rapor' },
    ]);
  });

  it('keeps at most seven lines', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Paragraf ${i}`).join('\n\n');
    expect(previewLines(many)).toHaveLength(7);
  });
});
