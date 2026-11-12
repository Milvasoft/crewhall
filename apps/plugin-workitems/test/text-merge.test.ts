import { describe, expect, it } from 'vitest';
import { merge } from '../src/merge';
import {
  adfToText,
  dateIn,
  htmlToText,
  normalizeText,
  textToAdf,
  textToHtml,
  wikiToText,
} from '../src/text';
import type { Canon } from '../src/types';

const base: Canon = {
  title: 'a',
  description: '',
  column: 'c1',
  assignee: null,
  priority: null,
  dueDate: null,
  startDate: null,
  labels: [],
  points: null,
};

describe('merge', () => {
  const run = (external: Partial<Canon>, card: Partial<Canon>, over = {}) =>
    merge({
      base,
      external: { ...base, ...external },
      card: { ...base, ...card },
      direction: 'both',
      conflict: 'newest',
      externalIsNewer: true,
      ...over,
    });

  it('sends a change to the side that lacks it', () => {
    const r = run({ title: 'b' }, { column: 'c2' });
    expect(r.toCard).toEqual({ title: 'b' });
    expect(r.toExternal).toEqual({ column: 'c2' });
    expect(r.next).toMatchObject({ title: 'b', column: 'c2' });
    expect(r.conflicts).toEqual([]);
  });

  it('both making the same change is not a conflict', () => {
    const r = run({ title: 'b' }, { title: 'b' });
    expect(r.conflicts).toEqual([]);
    expect(r.toCard).toEqual({});
    expect(r.next.title).toBe('b');
  });

  it('applies the conflict rule', () => {
    expect(run({ title: 'e' }, { title: 'c' }, { conflict: 'external' }).toCard).toEqual({
      title: 'e',
    });
    expect(run({ title: 'e' }, { title: 'c' }, { conflict: 'crewhall' }).toExternal).toEqual({
      title: 'c',
    });
    expect(run({ title: 'e' }, { title: 'c' }, { externalIsNewer: false }).toExternal).toEqual({
      title: 'c',
    });
    expect(run({ title: 'e' }, { title: 'c' }).conflicts).toEqual(['title']);
  });

  it('skips a field one side cannot speak for', () => {
    const r = merge({
      base,
      external: { ...base, points: undefined },
      card: { ...base, points: 5 },
      direction: 'both',
      conflict: 'newest',
      externalIsNewer: true,
    });
    expect(r.toExternal).toEqual({});
    expect(r.next.points).toBe(5);
  });

  it('compares labels as a whole', () => {
    expect(run({ labels: ['x', 'y'] }, {}).toCard).toEqual({ labels: ['x', 'y'] });
  });
});

describe('text', () => {
  it('reads Azure DevOps HTML', () => {
    expect(
      htmlToText('<div>Bir &amp; iki</div><ul><li>a</li><li>b</li></ul><p>son<br>satır</p>'),
    ).toBe('Bir & iki\n\n- a\n- b\n\nson\nsatır');
    expect(htmlToText('<script>x()</script><b>k</b>&#x131;')).toBe('kı');
  });

  it('writes HTML that cannot carry markup through', () => {
    expect(textToHtml('<b>a</b>\n- x')).toBe('<div>&lt;b&gt;a&lt;/b&gt;</div><ul><li>x</li></ul>');
  });

  it('round-trips through HTML and the Jira document as the same plain text', () => {
    const text = 'Başlık\n\n- bir\n- iki\n\nSon';
    expect(htmlToText(textToHtml(text))).toBe(text);
    expect(adfToText(textToAdf(text))).toBe(text);
  });

  it('reads nested Jira documents', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'H' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe('H\n- x');
    expect(adfToText(null)).toBe('');
  });

  it('reads Jira wiki text', () => {
    expect(wikiToText('h1. Başlık\n* a\n# b\n{code}x{code}')).toBe('Başlık\n- a\n- b\nx');
  });

  it('treats the bullet forms and line endings as the same text', () => {
    expect(normalizeText('• a\r\n* b  \r\n\r\n\r\n\r\nc')).toBe('- a\n- b\n\nc');
  });

  it('takes the calendar day in the sync time zone', () => {
    expect(dateIn('2026-11-10T21:30:00Z', 'Europe/Istanbul')).toBe('2026-11-11');
    expect(dateIn('2026-11-10T21:30:00Z', 'UTC')).toBe('2026-11-10');
    expect(dateIn(null, 'UTC')).toBeNull();
  });
});
