import type { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc, type EditorDoc, type JSONNode } from '../src';
import { RichEditor } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** Width and alignment of an image in a page. */

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

function mount(md = 'Önce ![Alt](a.png) sonra', imageLayout = true) {
  const { container } = render(
    <RichEditor value={markdownToDoc(md).doc} labels={fakeLabels} imageLayout={imageLayout} />,
  );
  const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
  return { editor: dom.editor, container };
}

const imagePos = (e: Editor) => {
  let at = -1;
  e.state.doc.descendants((n, pos) => {
    if (n.type.name === 'image') at = pos;
  });
  return at;
};

const selectImage = (e: Editor) =>
  act(() => {
    e.commands.focus();
    e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, imagePos(e))));
  });

const attrs = (e: Editor) => e.state.doc.nodeAt(imagePos(e))!.attrs;

describe('image layout', () => {
  beforeAll(() => {
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Range.prototype.getClientRects = noRects;
    Element.prototype.getClientRects = noRects;
  });
  afterAll(() => {
    Range.prototype.getBoundingClientRect = layout.rangeRect;
    Range.prototype.getClientRects = layout.rangeRects;
    Element.prototype.getClientRects = layout.elRects;
  });

  it('sets width and alignment from the toolbar, keeping the image selected', async () => {
    const { editor, container } = mount();
    selectImage(editor);
    fireEvent.click(await screen.findByRole('button', { name: 'L:imageWidth 50%' }));
    expect(attrs(editor).width).toBe(50);
    fireEvent.click(screen.getByRole('button', { name: 'L:tableAlignCenter' }));
    expect(attrs(editor).align).toBe('center');
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);

    const wrap = container.querySelector('.ch-image-wrap') as HTMLElement;
    expect(wrap.style.width).toBe('50%');
    expect(wrap.dataset.align).toBe('center');
    expect(wrap).toHaveClass('has-layout');
  });

  it('clears a choice when it is picked again', async () => {
    const { editor, container } = mount();
    selectImage(editor);
    const half = await screen.findByRole('button', { name: 'L:imageWidth 50%' });
    fireEvent.click(half);
    expect(half).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(half);
    expect(attrs(editor).width).toBeNull();
    const wrap = container.querySelector('.ch-image-wrap') as HTMLElement;
    expect(wrap.style.width).toBe('');
    expect(wrap).not.toHaveClass('has-layout');
  });

  it('resizes with the handle in one step and stays within limits', () => {
    const { editor, container } = mount();
    const wrap = container.querySelector('.ch-image-wrap') as HTMLElement;
    const handle = container.querySelector('.ch-image-handle') as HTMLElement;
    wrap.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
    wrap.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    const before = editor.state.doc;

    const drag = (from: number, to: number) => {
      act(() => {
        handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: from, bubbles: true }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
      });
    };
    drag(200, 300);
    expect(wrap.style.width).toBe('75%');
    expect(editor.state.doc).toBe(before);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(attrs(editor).width).toBe(75);

    drag(200, 2000);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(attrs(editor).width).toBe(100);
    drag(200, -2000);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(attrs(editor).width).toBe(10);
  });

  it('grows on both sides when centred', () => {
    const { editor, container } = mount();
    act(() => {
      editor.view.dispatch(editor.state.tr.setNodeAttribute(imagePos(editor), 'align', 'center'));
    });
    const wrap = container.querySelector('.ch-image-wrap') as HTMLElement;
    const handle = container.querySelector('.ch-image-handle') as HTMLElement;
    wrap.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
    wrap.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, bubbles: true }));
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 250 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(attrs(editor).width).toBe(75);
  });

  it('does nothing on a read-only page', () => {
    const { container } = render(
      <RichEditor
        value={markdownToDoc('![Alt](a.png)').doc}
        labels={fakeLabels}
        imageLayout
        editable={false}
      />,
    );
    const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
    const handle = container.querySelector('.ch-image-handle') as HTMLElement;
    const wrap = container.querySelector('.ch-image-wrap') as HTMLElement;
    wrap.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, 400, 100);
    act(() => {
      handle.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, bubbles: true }));
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(dom.editor.state.doc.nodeAt(0)?.firstChild?.attrs.width).toBeNull();
  });

  it('is only offered where the host asks for it', () => {
    const { editor, container } = mount('![Alt](a.png)', false);
    selectImage(editor);
    expect(screen.queryByRole('toolbar', { name: 'L:imageToolbar' })).toBeNull();
    expect(container.querySelector('.ch-editor')).not.toHaveClass('ch-editor--image-layout');
  });

  it('keeps the layout through HTML, and markdown leaves it out quietly', () => {
    const { editor } = mount();
    act(() => {
      const tr = editor.state.tr.setNodeAttribute(imagePos(editor), 'width', 40);
      editor.view.dispatch(tr.setNodeAttribute(imagePos(editor), 'align', 'right'));
    });
    const html = editor.getHTML();
    expect(html).toContain('data-width="40"');
    expect(html).toContain('data-align="right"');
    act(() => {
      editor.commands.setContent(html);
    });
    expect(attrs(editor)).toMatchObject({ width: 40, align: 'right' });
    expect(docToMarkdown(editor.getJSON() as EditorDoc).trimEnd()).toBe('Önce ![Alt](a.png) sonra');
    const image = ((editor.getJSON() as EditorDoc).content?.[0] as JSONNode).content?.[1];
    expect(image?.attrs).toMatchObject({ src: 'a.png', width: 40, align: 'right' });
  });

  it('ignores values it should not trust', () => {
    const { editor, container } = mount();
    act(() => {
      const tr = editor.state.tr.setNodeAttribute(imagePos(editor), 'width', 5000);
      editor.view.dispatch(tr.setNodeAttribute(imagePos(editor), 'align', 'bad;"'));
    });
    const wrap = container.querySelector('.ch-image-wrap') as HTMLElement;
    expect(wrap.style.width).toBe('');
    expect(wrap.dataset.align).toBeUndefined();
  });
});
