import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '../src';
import {
  AssistHighlight,
  applyAssistResult,
  assistRange,
  markdownBefore,
  rangeMarkdown,
  RichEditor,
  setAssistRange,
  type RichEditorHandle,
} from '../src/react';
import { fakeLabels } from './helpers/labels';

/** Writing-assistant helpers: read a range, mark it, apply the answer as one undo step. */

function mount(md: string) {
  const ref = createRef<RichEditorHandle>();
  render(
    <RichEditor
      value={markdownToDoc(md).doc}
      labels={fakeLabels}
      editorRef={ref}
      extensions={[AssistHighlight]}
    />,
  );
  return ref.current!.getEditor();
}

/** Positions of `needle` inside the document text. */
function find(editor: ReturnType<typeof mount>, needle: string) {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return;
    const i = node.text!.indexOf(needle);
    if (i >= 0) found = { from: pos + i, to: pos + i + needle.length };
  });
  if (!found) throw new Error(`no ${needle}`);
  return found as { from: number; to: number };
}

const blocks = (editor: ReturnType<typeof mount>) =>
  editor.state.doc.content.content.map((n) => `${n.type.name}:${n.textContent}`);

describe('assist helpers', () => {
  it('reads a range as markdown, keeping lists and marks', () => {
    const editor = mount('Giriş **kalın** metin.\n\n- bir\n- iki\n\nSon.');
    const all = { from: 0, to: editor.state.doc.content.size };
    const md = rangeMarkdown(editor, all.from, all.to);
    expect(md).toContain('**kalın**');
    expect(md).toContain('- bir');
    expect(markdownBefore(editor, find(editor, 'Son').from, 12).length).toBeLessThanOrEqual(12);
  });

  it('replaces a phrase inline and undoes it in one step', () => {
    const editor = mount('Bu cümle çok uzun ve dağınık.');
    const r = find(editor, 'çok uzun ve dağınık');
    act(() => {
      applyAssistResult(editor, r, 'kısa', 'replace');
    });
    expect(blocks(editor)).toEqual(['paragraph:Bu cümle kısa.']);
    act(() => {
      editor.commands.undo();
    });
    expect(blocks(editor)).toEqual(['paragraph:Bu cümle çok uzun ve dağınık.']);
  });

  it('puts a summary below the block and continues text inline', () => {
    const editor = mount('İlk paragraf.\n\nİkinci paragraf.');
    act(() => {
      applyAssistResult(editor, find(editor, 'İlk paragraf'), '- özet bir\n- özet iki', 'below');
    });
    expect(blocks(editor)).toEqual([
      'paragraph:İlk paragraf.',
      'bulletList:özet birözet iki',
      'paragraph:İkinci paragraf.',
    ]);
    act(() => {
      applyAssistResult(editor, find(editor, 'İkinci paragraf.'), 'Devamı burada.', 'continue');
    });
    expect(blocks(editor).at(-1)).toBe('paragraph:İkinci paragraf. Devamı burada.');
  });

  it('keeps the highlighted range in place while the text changes', () => {
    const editor = mount('Önce bu, sonra hedef metin.');
    const r = find(editor, 'hedef');
    act(() => {
      setAssistRange(editor, r);
    });
    expect(editor.view.dom.querySelector('.ch-assist-range')?.textContent).toBe('hedef');
    act(() => {
      editor.commands.insertContentAt(1, 'Yeni ');
    });
    expect(assistRange(editor)).toEqual({ from: r.from + 5, to: r.to + 5 });
    act(() => {
      setAssistRange(editor, null);
    });
    expect(editor.view.dom.querySelector('.ch-assist-range')).toBeNull();
  });
});
