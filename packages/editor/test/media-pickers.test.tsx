import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { emptyDoc, type EditorDoc } from '../src';
import { RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

type Props = Partial<Parameters<typeof RichEditor>[0]>;

function mount(doc: EditorDoc, props: Props = {}) {
  const ref = createRef<RichEditorHandle>();
  const utils = render(<RichEditor value={doc} labels={fakeLabels} editorRef={ref} {...props} />);
  return { ...utils, editor: ref.current!.getEditor() };
}

const ID = '0190f0a0-0000-7000-8000-000000000abc';
const emptyVideo: EditorDoc = { type: 'doc', content: [{ type: 'video', attrs: { src: '' } }] };

describe('an empty video block', () => {
  it('offers only a link where nothing can be uploaded', () => {
    mount(emptyVideo);
    expect(screen.getByRole('textbox', { name: 'L:videoPlaceholder' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'L:videoPickFile' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'L:videoPickDrive' })).toBeNull();
  });

  it('uploads a video picked from the computer and plays it from Drive', async () => {
    const uploadFile = vi.fn(async () => ({ nodeId: ID, nodeType: 'file' }));
    const { editor, container } = mount(emptyVideo, { uploadFile });
    expect(screen.getByRole('button', { name: 'L:videoPickFile' })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[data-testid="ch-video-file"]')!;
    expect(input.accept).toBe('video/*');
    const file = new File(['x'], 'tanıtım.mp4', { type: 'video/mp4' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(uploadFile).toHaveBeenCalledWith(file);
    await waitFor(() =>
      expect(editor.getJSON().content?.[0]?.attrs).toEqual({
        src: `node:${ID}`,
        title: 'tanıtım.mp4',
      }),
    );
  });

  it('shows the upload error when the upload fails, and keeps the block empty', async () => {
    const uploadFile = vi.fn(async () => {
      throw new Error('nope');
    });
    const { editor, container } = mount(emptyVideo, { uploadFile });
    const input = container.querySelector<HTMLInputElement>('input[data-testid="ch-video-file"]')!;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] },
      });
    });
    await screen.findByText('L:imageUploadError');
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe('');
  });

  it('takes a video chosen from the host, and nothing when the person cancels', async () => {
    const pickVideo = vi
      .fn<() => Promise<{ src: string; title: string | null } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ src: `node:${ID}`, title: 'Kayıt.webm' });
    const { editor } = mount(emptyVideo, { pickVideo });
    const button = screen.getByRole('button', { name: 'L:videoPickDrive' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe('');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'L:videoPickDrive' }));
    });
    await waitFor(() =>
      expect(editor.getJSON().content?.[0]?.attrs).toEqual({
        src: `node:${ID}`,
        title: 'Kayıt.webm',
      }),
    );
    expect(pickVideo).toHaveBeenCalledTimes(2);
  });
});

describe('"/" → Image without uploads', () => {
  const runImage = async (editor: ReturnType<typeof mount>['editor']) => {
    act(() => {
      editor.commands.focus('end');
      editor.commands.insertContent('/picture');
    });
    const menu = await screen.findByRole('listbox', { name: 'L:slashMenu' });
    const item = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].find((o) =>
      o.textContent?.startsWith('L:slashImage'),
    )!;
    act(() => {
      fireEvent.click(item);
    });
  };

  it('asks for the address in the editor, not with window.prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt');
    const { editor } = mount(emptyDoc());
    await runImage(editor);
    expect(prompt).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'L:imageUrlPrompt' });
    act(() => {
      fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    act(() => {
      fireEvent.change(input, { target: { value: 'example.com/a.png' } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(screen.queryByRole('textbox', { name: 'L:imageUrlPrompt' })).toBeNull();
    const images: unknown[] = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'image') images.push(n.attrs.src);
    });
    expect(images).toEqual(['https://example.com/a.png']);
    prompt.mockRestore();
  });

  it('closes on Escape without inserting anything', async () => {
    const { editor } = mount(emptyDoc());
    await runImage(editor);
    const input = screen.getByRole('textbox', { name: 'L:imageUrlPrompt' });
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(screen.queryByRole('textbox', { name: 'L:imageUrlPrompt' })).toBeNull();
    expect(JSON.stringify(editor.getJSON())).not.toContain('"image"');
  });
});
