import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  docToMarkdown,
  markdownToDoc,
  plainText,
  toPublicDoc,
  videoSource,
  webUrl,
  type EditorDoc,
} from '../src';
import { RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

type Props = Partial<Parameters<typeof RichEditor>[0]>;

function mount(doc: EditorDoc, props: Props = {}) {
  const ref = createRef<RichEditorHandle>();
  const utils = render(<RichEditor value={doc} labels={fakeLabels} editorRef={ref} {...props} />);
  return { ...utils, editor: ref.current!.getEditor() };
}

const one = (type: string, attrs: Record<string, unknown>): EditorDoc => ({
  type: 'doc',
  content: [{ type, attrs }],
});

const FILE = 'node:0190f0a0-0000-7000-8000-000000000abc';

describe('addresses', () => {
  it('reads a typed address as a web URL and refuses anything else', () => {
    expect(webUrl('example.com/a')).toBe('https://example.com/a');
    expect(webUrl(' https://example.com ')).toBe('https://example.com/');
    expect(webUrl('http://example.com')).toBe('http://example.com/');
    expect(webUrl('javascript:alert(1)')).toBeNull();
    expect(webUrl('data:text/html,x')).toBeNull();
    expect(webUrl('file:///etc/passwd')).toBeNull();
    expect(webUrl('metin')).toBeNull();
    expect(webUrl('')).toBeNull();
  });

  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=x', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
  ])('finds the YouTube video in %s', (src, id) => {
    expect(videoSource(src)).toEqual({
      kind: 'player',
      host: 'youtube',
      url: `https://www.youtube-nocookie.com/embed/${id}`,
    });
  });

  it('builds the player address itself, never from the document', () => {
    expect(videoSource('https://vimeo.com/76979871')).toEqual({
      kind: 'player',
      host: 'vimeo',
      url: 'https://player.vimeo.com/video/76979871',
    });
    expect(videoSource('https://youtu.be/"><script>')).toBeNull();
    expect(videoSource('https://youtube.com.evil.test/embed/dQw4w9WgXcQ')).toBeNull();
    expect(videoSource('https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('plays files and Drive files, and nothing else', () => {
    expect(videoSource('https://cdn.example.com/a.MP4?x=1')?.kind).toBe('file');
    expect(videoSource(FILE)).toEqual({ kind: 'file', src: FILE });
    expect(videoSource('https://example.com/sayfa')).toBeNull();
    expect(videoSource('javascript:alert(1)//a.mp4')).toBeNull();
  });
});

describe('in Markdown', () => {
  it('reads and writes bookmarks and videos', () => {
    const source =
      '::bookmark{url="https://example.com/a" title="Örnek &quot;sayfa&quot;"}\n\n::video{src="https://youtu.be/dQw4w9WgXcQ"}';
    const { doc, warnings } = markdownToDoc(source);
    expect(warnings).toEqual([]);
    expect(doc.content?.[0]).toEqual({
      type: 'bookmark',
      attrs: { url: 'https://example.com/a', title: 'Örnek "sayfa"', favicon: null },
    });
    expect(doc.content?.[1]).toEqual({
      type: 'video',
      attrs: { src: 'https://youtu.be/dQw4w9WgXcQ', title: null },
    });
    expect(markdownToDoc(docToMarkdown(doc)).doc).toEqual(doc);
    expect(plainText(doc)).toContain('Örnek "sayfa"');
  });

  it('keeps an unsafe address as text instead of making a block of it', () => {
    const { doc, warnings } = markdownToDoc('::bookmark{url="javascript:alert(1)"}');
    expect(doc.content?.[0]?.type).toBe('paragraph');
    expect(warnings[0]?.type).toBe('unknown-directive');
  });

  it('removes Drive videos from what leaves the Hub', () => {
    const doc: EditorDoc = {
      type: 'doc',
      content: [
        { type: 'video', attrs: { src: FILE } },
        { type: 'video', attrs: { src: 'https://youtu.be/dQw4w9WgXcQ' } },
      ],
    };
    expect(toPublicDoc(doc).content?.map((n) => n.attrs?.src)).toEqual([
      'https://youtu.be/dQw4w9WgXcQ',
    ]);
  });
});

describe('bookmarks in the editor', () => {
  it('asks for an address, fills in the title through the host', async () => {
    const previewLink = vi.fn(async () => ({
      title: 'Örnek',
      faviconUrl: 'https://example.com/i.png',
    }));
    const { editor, container } = mount(one('bookmark', { url: '' }), { previewLink });
    const input = screen.getByRole('textbox', { name: 'L:bookmarkPlaceholder' });
    act(() => {
      fireEvent.change(input, { target: { value: 'example.com/a' } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(previewLink).toHaveBeenCalledWith('https://example.com/a');
    await waitFor(() =>
      expect(editor.getJSON().content?.[0]?.attrs).toEqual({
        url: 'https://example.com/a',
        title: 'Örnek',
        favicon: 'https://example.com/i.png',
      }),
    );
    const card = await waitFor(() => {
      const el = container.querySelector<HTMLAnchorElement>('a.ch-bookmark-card');
      if (!el) throw new Error('no card yet');
      return el;
    });
    expect(card).toHaveAttribute('href', 'https://example.com/a');
    expect(card).toHaveAttribute('rel', 'noopener noreferrer');
    await waitFor(() => expect(card).toHaveTextContent('Örnek'));
  });

  it('refuses an unsafe address, and an abandoned prompt removes the block', () => {
    const { editor } = mount({
      type: 'doc',
      content: [
        { type: 'bookmark', attrs: { url: '' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Sonra' }] },
      ],
    });
    const input = screen.getByRole('textbox', { name: 'L:bookmarkPlaceholder' });
    act(() => {
      fireEvent.change(input, { target: { value: 'javascript:alert(1)' } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(editor.getJSON().content?.[0]?.attrs?.url).toBe('');
    act(() => {
      fireEvent.keyDown(input, { key: 'Escape' });
    });
    expect(editor.getJSON().content?.[0]?.type).toBe('paragraph');
  });

  it('never links a stored unsafe address', () => {
    const { container } = mount(one('bookmark', { url: 'javascript:alert(1)', title: 'x' }), {
      editable: false,
    });
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe('videos in the editor', () => {
  const YT = 'https://youtu.be/dQw4w9WgXcQ';

  it('asks the site for nothing until play is pressed', async () => {
    const { container } = mount(one('video', { src: YT }));
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /L:videoPlay/ }));
    const frame = await waitFor(() => {
      const el = container.querySelector('iframe');
      if (!el) throw new Error('no frame yet');
      return el;
    });
    expect(frame.getAttribute('src')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1',
    );
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
  });

  it('plays a Drive file through the host, and shows other pages as a link', () => {
    const resolveImageUrl = (src: string) => `/files/${src}`;
    const file = mount(one('video', { src: FILE }), { resolveImageUrl });
    expect(file.container.querySelector('video')).toHaveAttribute('src', `/files/${FILE}`);
    file.unmount();
    const page = mount(one('video', { src: 'https://example.com/sayfa' }));
    expect(page.container.querySelector('video, iframe')).toBeNull();
    expect(page.container.querySelector('a')).toHaveAttribute('href', 'https://example.com/sayfa');
  });

  it('asks for the address of a new video', () => {
    const { editor } = mount(one('video', { src: '' }));
    const input = screen.getByRole('textbox', { name: 'L:videoPlaceholder' });
    act(() => {
      fireEvent.change(input, { target: { value: YT } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(editor.getJSON().content?.[0]?.attrs?.src).toBe(YT);
  });
});
