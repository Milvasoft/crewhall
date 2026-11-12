import type { EditorDoc } from '@crewhall/editor';
import { describe, expect, it } from 'vitest';
import { noteBlocks, noteFromDoc, noteToDoc } from '@/features/quick/noteDoc';

describe('quick note text ↔ editor document', () => {
  it('reads every line as its own block, keeping lists and code together', () => {
    expect(noteBlocks('# Başlık\nbirinci satır\nikinci satır\n- a\n- b\n- [ ] c\n\nson')).toEqual([
      '# Başlık',
      'birinci satır',
      'ikinci satır',
      '- a\n- b',
      '- [ ] c',
      'son',
    ]);
    expect(noteBlocks('```\nx = 1\n\ny = 2\n```\nsonra')).toEqual([
      '```\nx = 1\n\ny = 2\n```',
      'sonra',
    ]);
    const doc = noteToDoc('# Haftalık\nPazartesi demo\n- [ ] sunum\n- [x] **taslak**');
    expect(doc.content?.map((b) => b.type)).toEqual(['heading', 'paragraph', 'taskList']);
    expect(noteToDoc('').content).toEqual([{ type: 'paragraph' }]);
  });

  it('writes the same text back for the notes mobile and the old card wrote', () => {
    for (const text of [
      '# Haftalık\nPazartesi demo\nSalı **retro**\n- [ ] sunum\n- [x] taslak\n- madde',
      'Tek satır',
      '1. bir\n2. iki\n> alıntı\n```\nkod\n\nblok\n```',
    ]) {
      expect(noteFromDoc(noteToDoc(text))).toBe(text);
    }
  });

  it('turns line breaks inside a block into lines', () => {
    const doc: EditorDoc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'üst' },
            { type: 'hardBreak' },
            { type: 'text', text: 'alt' },
          ],
        },
      ],
    };
    expect(noteFromDoc(doc)).toBe('üst\nalt');
  });
});
