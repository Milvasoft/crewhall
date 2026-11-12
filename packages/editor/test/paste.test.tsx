import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { markdownToDoc, type EditorDoc } from '../src';
import { looksLikeMarkdown, RichEditor } from '../src/react';
import { fakeLabels } from './helpers/labels';

function mount(uploadImage?: (file: File) => Promise<{ src: string; alt?: string }>) {
  const { container } = render(
    <RichEditor
      value={markdownToDoc('Start').doc}
      labels={fakeLabels}
      uploadImage={uploadImage}
      resolveImageUrl={(src) => `https://cdn.test${src}`}
    />,
  );
  const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
  act(() => {
    dom.editor.commands.focus('end');
  });
  return { editor: dom.editor, container };
}

function paste(editor: Editor, data: { text?: string; html?: string; files?: File[] }): boolean {
  const event = {
    clipboardData: {
      getData: (type: string) =>
        type === 'text/plain' ? (data.text ?? '') : type === 'text/html' ? (data.html ?? '') : '',
      files: data.files ?? [],
    },
    preventDefault: () => {},
  } as unknown as ClipboardEvent;
  let handled = false;
  act(() => {
    handled =
      editor.view.someProp('handlePaste', (f) => f(editor.view, event, Slice.empty)) ?? false;
  });
  return handled;
}

describe('paste', () => {
  it('detects markdown-looking text', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true);
    expect(looksLikeMarkdown('- a\n- b')).toBe(true);
    expect(looksLikeMarkdown('```js\nx\n```')).toBe(true);
    expect(looksLikeMarkdown(':::tip\nx\n:::')).toBe(true);
    expect(looksLikeMarkdown('Just a sentence.')).toBe(false);
  });

  it('converts pasted markdown text into blocks', () => {
    const { editor } = mount();
    expect(paste(editor, { text: '## Setup\n\n:::tip\nUse **pnpm**\n:::\n' })).toBe(true);
    const json = editor.getJSON() as EditorDoc;
    expect(json.content?.map((n) => n.type)).toContain('heading');
    expect(json.content?.find((n) => n.type === 'admonition')).toMatchObject({
      attrs: { type: 'tip' },
    });
  });

  it('leaves plain sentences and rich HTML to the default paste', () => {
    const { editor } = mount();
    expect(paste(editor, { text: 'hello world' })).toBe(false);
    expect(paste(editor, { text: '# x', html: '<h1>x</h1>' })).toBe(false);
  });

  it('uploads pasted image files and shows them through resolveImageUrl', async () => {
    const uploadImage = vi.fn(async () => ({ src: '/media/img/p.png', alt: 'Pasted' }));
    const { editor, container } = mount(uploadImage);
    const file = new File(['x'], 'p.png', { type: 'image/png' });
    expect(paste(editor, { files: [file] })).toBe(true);
    await waitFor(() => expect(uploadImage).toHaveBeenCalledWith(file));
    await waitFor(() => {
      const para = (editor.getJSON() as EditorDoc).content?.[0];
      expect(para?.content).toContainEqual({
        type: 'image',
        attrs: { src: '/media/img/p.png', alt: 'Pasted', title: null, width: null, align: null },
      });
    });
    expect(container.querySelector('img.ch-image')).toHaveAttribute(
      'src',
      'https://cdn.test/media/img/p.png',
    );
  });

  it('holds the place with a placeholder until the upload ends, whatever is typed meanwhile', async () => {
    let finish: (v: { src: string }) => void = () => undefined;
    const uploadImage = vi.fn(() => new Promise<{ src: string }>((r) => (finish = r)));
    const { editor, container } = mount(uploadImage);
    act(() => {
      editor.commands.setTextSelection(3);
    });
    paste(editor, { files: [new File(['x'], 'p.png', { type: 'image/png' })] });
    expect(container.querySelector('.ch-image-uploading')).not.toBeNull();
    // Text typed before the place pushes it along.
    act(() => {
      editor.commands.insertContentAt(1, 'Önce ');
    });
    await act(async () => {
      finish({ src: '/a.png' });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(container.querySelector('.ch-image-uploading')).toBeNull());
    const para = (editor.getJSON() as EditorDoc).content?.[0]?.content ?? [];
    expect(para.map((n) => n.text ?? n.type)).toEqual(['Önce St', 'image', 'art']);
  });

  it('takes a screenshot listed only under clipboard items, and keeps several in order', async () => {
    const uploadImage = vi.fn(async (f: File) => ({ src: `/${f.name}` }));
    const { editor } = mount(uploadImage);
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    const event = {
      clipboardData: {
        getData: () => '',
        files: [],
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => shot },
        ],
      },
    } as unknown as ClipboardEvent;
    act(() => {
      editor.view.someProp('handlePaste', (f) => f(editor.view, event, Slice.empty));
    });
    await waitFor(() => expect(uploadImage).toHaveBeenCalledWith(shot));

    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const b = new File(['b'], 'b.png', { type: 'image/png' });
    paste(editor, { files: [a, b] });
    await waitFor(() => expect(uploadImage).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      const para = (editor.getJSON() as EditorDoc).content?.[0]?.content ?? [];
      const srcs = para.filter((n) => n.type === 'image').map((n) => n.attrs?.src);
      expect(srcs).toEqual(['/shot.png', '/a.png', '/b.png']);
    });
  });

  it('uploads dropped image files where they fall', async () => {
    const uploadImage = vi.fn(async () => ({ src: '/d.png' }));
    const { editor } = mount(uploadImage);
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 });
    const event = {
      clientX: 1,
      clientY: 1,
      dataTransfer: { files: [new File(['x'], 'd.png', { type: 'image/png' })] },
      preventDefault: () => undefined,
    } as unknown as DragEvent;
    act(() => {
      editor.view.someProp('handleDrop', (f) => f(editor.view, event, Slice.empty, false));
    });
    await waitFor(() => {
      const para = (editor.getJSON() as EditorDoc).content?.[0]?.content ?? [];
      expect(para.map((n) => n.text ?? n.type)).toEqual(['S', 'image', 'tart']);
    });
  });

  it('removes the placeholder and reports a failed upload', async () => {
    const onError = vi.fn();
    const { container } = render(
      <RichEditor
        value={markdownToDoc('Start').doc}
        labels={fakeLabels}
        uploadImage={async () => {
          onError();
          throw new Error('no');
        }}
      />,
    );
    const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor };
    paste(dom.editor, { files: [new File(['x'], 'p.png', { type: 'image/png' })] });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('.ch-image-uploading')).toBeNull());
    expect(container.querySelector('.ch-editor-alert')).not.toBeNull();
    expect(JSON.stringify(dom.editor.getJSON())).not.toContain('image');
  });
});
