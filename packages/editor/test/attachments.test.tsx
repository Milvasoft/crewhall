import type { Editor } from '@tiptap/core';
import { Slice } from '@tiptap/pm/model';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { markdownToDoc, type EditorDoc } from '../src';
import { RichEditor } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** Files that are not images: they upload and land as an embedded node. */

type Upload = (file: File) => Promise<{ nodeId: string; nodeType: string }>;
type UploadImage = (file: File) => Promise<{ src: string; alt?: string }>;

function mount(uploadFile?: Upload, uploadImage?: UploadImage, md = 'Start') {
  const { container } = render(
    <RichEditor
      value={markdownToDoc(md).doc}
      labels={fakeLabels}
      uploadFile={uploadFile}
      uploadImage={uploadImage}
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

const blocks = (e: Editor) => (e.getJSON() as EditorDoc).content ?? [];
const embeds = (e: Editor) => blocks(e).filter((n) => n.type === 'embed');
const pdf = () => new File(['%PDF'], 'rapor.pdf', { type: 'application/pdf' });

describe('file attachments', () => {
  it('uploads a pasted file and embeds it', async () => {
    const uploadFile = vi.fn<Upload>(async () => ({ nodeId: 'n1', nodeType: 'file' }));
    const { editor } = mount(uploadFile);
    const file = pdf();
    expect(paste(editor, { files: [file] })).toBe(true);
    await waitFor(() => expect(embeds(editor)).toHaveLength(1));
    expect(uploadFile).toHaveBeenCalledWith(file);
    expect(embeds(editor)[0]?.attrs).toMatchObject({ nodeId: 'n1', nodeType: 'file' });
  });

  it('uploads a dropped file where it was dropped', async () => {
    const uploadFile = vi.fn<Upload>(async () => ({ nodeId: 'n1', nodeType: 'file' }));
    const { editor } = mount(uploadFile);
    const event = {
      dataTransfer: { files: [pdf()] },
      clientX: 0,
      clientY: 0,
      preventDefault: () => {},
    } as unknown as DragEvent;
    let handled = false;
    act(() => {
      handled =
        editor.view.someProp('handleDrop', (f) => f(editor.view, event, Slice.empty, false)) ??
        false;
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(embeds(editor)).toHaveLength(1));
  });

  it('keeps the order of mixed files: images stay images', async () => {
    const uploadFile = vi.fn<Upload>(async () => ({ nodeId: 'n1', nodeType: 'file' }));
    const uploadImage = vi.fn<UploadImage>(async () => ({ src: 'node:i1' }));
    const { editor } = mount(uploadFile, uploadImage);
    const image = new File(['x'], 'p.png', { type: 'image/png' });
    expect(paste(editor, { files: [image, pdf()] })).toBe(true);
    await waitFor(() => expect(embeds(editor)).toHaveLength(1));
    expect(uploadImage).toHaveBeenCalledOnce();
    const json = JSON.stringify(editor.getJSON());
    expect(json.indexOf('node:i1')).toBeLessThan(json.indexOf('"nodeId":"n1"'));
  });

  it('leaves files alone when the host takes none', () => {
    const { editor } = mount();
    expect(paste(editor, { files: [pdf()] })).toBe(false);
  });

  it('takes images only when the host has no file upload', async () => {
    const uploadImage = vi.fn<UploadImage>(async () => ({ src: 'node:i1' }));
    const { editor } = mount(undefined, uploadImage);
    expect(paste(editor, { files: [pdf()] })).toBe(false);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('keeps the text of a spreadsheet copy, not the picture of it', () => {
    const uploadImage = vi.fn<UploadImage>(async () => ({ src: 'node:i1' }));
    const { editor } = mount(undefined, uploadImage);
    const picture = new File(['x'], 'image.png', { type: 'image/png' });
    expect(paste(editor, { text: 'a\tb', files: [picture] })).toBe(false);
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('still uploads when the text only names the copied file', async () => {
    const uploadFile = vi.fn<Upload>(async () => ({ nodeId: 'n1', nodeType: 'file' }));
    const { editor } = mount(uploadFile);
    expect(paste(editor, { text: 'rapor.pdf', files: [pdf()] })).toBe(true);
    await waitFor(() => expect(embeds(editor)).toHaveLength(1));
  });

  it('tells when an upload fails and keeps the page as it was', async () => {
    const uploadFile = vi.fn<Upload>(async () => {
      throw new Error('quota');
    });
    const { editor } = mount(uploadFile);
    paste(editor, { files: [pdf()] });
    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    await screen.findByText('L:imageUploadError');
    expect(embeds(editor)).toHaveLength(0);
  });

  it('attaches through the picker from "/" at the caret', async () => {
    const uploadFile = vi.fn<Upload>(async () => ({ nodeId: 'n1', nodeType: 'file' }));
    const { editor, container } = mount(uploadFile);
    const input = container.querySelector('input[data-ch-attach]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdf()] } });
    await waitFor(() => expect(embeds(editor)).toHaveLength(1));
  });
});
