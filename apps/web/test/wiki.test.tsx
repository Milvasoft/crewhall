import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SNIPPET_MARK_END, SNIPPET_MARK_START } from '@crewhall/shared';
import { Snippet } from '@/components/wiki/SearchView';
import { api } from '@/lib/api';
import { SPACE, USER } from '@/mocks/seed';
import { mockMarkdownToDoc, resetWikiMock } from '@/mocks/wiki';
import { blockText, changeCount, diffBlocks, wordDiff, type PMNode } from '@/lib/wiki/diff';
import { fold } from '@/lib/wiki/editor/suggest';
import { crc32 } from '@/lib/wiki/files';
import { renderApp } from './support/render';
import { makeZip } from './support/zip';
import { signedInAs } from './support/session';

const p = (text: string): PMNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (text: string): PMNode => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
});

describe('wiki version diff (design 5.10)', () => {
  it('marks added, removed and edited blocks', () => {
    const before = [h('Genel bakış'), p('API 8 ile çalışır.'), p('Silinecek paragraf')];
    const after = [h('Genel bakış'), p('API 9 ile çalışır.'), p('Yeni paragraf')];
    const ops = diffBlocks(before, after);
    expect(ops.map((o) => o.op)).toEqual(['same', 'mod', 'mod']);
    const mod = ops[1]!;
    expect(mod.op === 'mod' && mod.words.filter((w) => w.op !== 'same').map((w) => w.text)).toEqual(
      ['8', '9'],
    );
    expect(changeCount(ops)).toBe(2);
    expect(diffBlocks([p('a')], [p('a'), { type: 'horizontalRule' }]).map((o) => o.op)).toEqual([
      'same',
      'add',
    ]);
  });

  it('diffs words and reads block text', () => {
    expect(wordDiff('kuyruk RabbitMQ 3.12', 'kuyruk RabbitMQ 4.0')).toEqual([
      { op: 'same', text: 'kuyruk RabbitMQ ' },
      { op: 'del', text: '3.12' },
      { op: 'add', text: '4.0' },
    ]);
    expect(
      blockText({ type: 'paragraph', content: [{ type: 'mention', attrs: { label: 'Can' } }] }),
    ).toBe('@Can');
  });
});

describe('wiki helpers', () => {
  it('computes ZIP checksums', () => {
    expect(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))).toBe(
      0x414fa339,
    );
  });

  it('highlights snippet matches without HTML', () => {
    render(<Snippet text={`üstel ${SNIPPET_MARK_START}retry${SNIPPET_MARK_END} politikası <b>`} />);
    expect(screen.getByText('retry').tagName).toBe('MARK');
    expect(screen.getByText(/politikası <b>/)).toBeInTheDocument();
  });

  it('filters menus accent- and case-insensitively', () => {
    expect(fold('Başlık')).toBe('baslik');
    expect(fold('IŞIK')).toBe('isik');
  });

  it('turns mock markdown into blocks', () => {
    const doc = mockMarkdownToDoc('## Başlık\n\n- [x] bitti\n- madde\n\nmetin');
    expect(doc.content.map((n) => n.type)).toEqual([
      'heading',
      'taskList',
      'bulletList',
      'paragraph',
    ]);
  });
});

// jsdom has no layout: the editor's menus (suggestion, floating-ui) ask for rectangles.
const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

describe('Sayfalar (design 05, mock)', () => {
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
  beforeEach(() => resetWikiMock());

  it('lists the space pages and opens one from the sidebar tree', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\/milvaion-/));
    expect(await screen.findByDisplayValue('Milvaion')).toBeInTheDocument();
    expect(await screen.findByText(/Dağıtık iş zamanlayıcısı/)).toBeInTheDocument();
  });

  it('moves pages in the tree with Alt + arrows and by dropping on a page', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    const rows = () => [...sidebar.querySelectorAll<HTMLElement>('[data-tree-page]')];
    const roots = () =>
      rows()
        .filter((r) => r.querySelector('a')!.style.paddingLeft === '10px')
        .map((r) => r.textContent ?? '');
    await waitFor(() => expect(roots().length).toBeGreaterThanOrEqual(3));
    const initial = roots();
    const [first, second, third] = initial;
    const link = (name: string) =>
      rows()
        .find((r) => r.textContent === name)!
        .querySelector('a')!;

    // Up among siblings.
    link(second!).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    // Only the two pages swap; the rest keeps its order.
    await waitFor(() => expect(roots()).toEqual([second, first, ...initial.slice(2)]));
    await waitFor(() => expect(document.activeElement).toBe(link(second!)));

    // Right: into the previous sibling (now "second" is first, "first" is under it).
    link(first!).focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    await waitFor(() => expect(roots()).not.toContain(first));
    await waitFor(() => expect(link(first!).style.paddingLeft).toBe('24px'));

    // Drop the third root page in the middle of the first one: it becomes a child.
    const dataTransfer = { setData: () => undefined, effectAllowed: '', dropEffect: '' };
    const source = rows().find((r) => r.textContent === third)!;
    const target = rows().find((r) => r.textContent === second)!;
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    expect(target).toHaveAttribute('data-drop', 'inside');
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(roots()).not.toContain(third));
    expect(link(third!).style.paddingLeft).toBe('24px');
  });

  it('imports an Outline package with its images into Drive (H18)', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'İçe aktar' }));
    const dialog = await screen.findByRole('dialog', { name: 'İçe aktar' });
    const enc = new TextEncoder();
    const zip = await makeZip([
      {
        path: 'Mühendislik/Kuyruk.md',
        data: enc.encode(
          [
            '# Kuyruk',
            '',
            '![şema](uploads/t/1f0e8c3a-5b6d-4e7f-8a9b-0c1d2e3f4a5b/%C5%9Fema.png)',
            '',
            '![](uploads/t/yok.png)',
          ].join('\n'),
        ),
      },
      {
        path: 'uploads/t/1f0e8c3a-5b6d-4e7f-8a9b-0c1d2e3f4a5b/şema.png',
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    ]);
    const input = dialog.querySelector<HTMLInputElement>(
      'input[type=file]:not([webkitdirectory])',
    )!;
    await user.upload(
      input,
      new File([zip as BlobPart], 'outline-export.zip', { type: 'application/zip' }),
    );
    expect(await within(dialog).findByText(/1 sayfa içe aktarıldı/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 görsel ya da ek Drive'a yüklendi/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Kuyruk\.md · ek pakette bulunamadı: uploads\/t\/yok\.png/),
    ).toBeInTheDocument();

    const tree = await api.call('listPageTree', { params: { spaceId: SPACE.milvasoft } });
    const page = tree.items.find((i) => i.name === 'Kuyruk')!;
    const body = await api.call('getPageContent', {
      params: { nodeId: page.id },
      query: { format: 'markdown' },
    });
    expect(body.markdown).toMatch(/!\[şema\]\(node:[0-9a-f-]{36}\)/);
    expect(body.markdown).toContain('![](uploads/t/yok.png)');
    // The dialog state outlives the render; close it for the next cases.
    await user.click(within(dialog).getByRole('button', { name: 'Kapat' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('exports a page from its menu and starts the download (roadmap 6)', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    await user.click(await screen.findByRole('button', { name: 'Sayfa menüsü' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Dışa aktar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dışa aktar' });
    await user.click(within(dialog).getByRole('radio', { name: /Word \(\.docx\)/ }));
    await user.click(within(dialog).getByRole('checkbox'));
    const clicked: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.href);
    };
    try {
      await user.click(within(dialog).getByRole('button', { name: 'Dışa aktar' }));
      await waitFor(() => expect(clicked).toHaveLength(1));
    } finally {
      HTMLAnchorElement.prototype.click = original;
    }
    expect(clicked[0]).toMatch(/\/api\/v1\/page-exports\/[0-9a-f-]{36}\/download$/);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('creates an untitled page and renames it from the title', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Yeni sayfa' }))[0]!);
    const title = await screen.findByRole('textbox', { name: 'Sayfa başlığı' });
    await waitFor(() => expect(title).toHaveValue('Başlıksız'));
    await user.clear(title);
    await user.type(title, 'Haftalık notlar{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/p\/haftalik-notlar-/));
  });

  it('edits the body with the shared editor and its wiki "/" items', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    await screen.findByText(/Dağıtık iş zamanlayıcısı/);
    const dom = document.querySelector('.ch-editor .ProseMirror') as HTMLElement & {
      editor?: Editor;
    };
    expect(dom.editor).toBeDefined();
    act(() => {
      dom.editor!.chain().focus('end').splitBlock().insertContent('/alt').run();
    });
    const menu = await screen.findByRole('listbox', { name: 'Bloklar' });
    await waitFor(() =>
      expect(within(menu).getByRole('option', { name: /Alt sayfa/ })).toHaveTextContent(
        'Bu sayfanın altında yeni sayfa aç ve linkle',
      ),
    );
  });

  it('opens the "@" menu at the caret in a portal and closes it with Escape', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/milvasoft');
    const user = userEvent.setup();
    const sidebar = await screen.findByRole('complementary', { name: /Space/i });
    await user.click((await within(sidebar).findAllByRole('link', { name: /Milvaion/ }))[0]!);
    await screen.findByText(/Dağıtık iş zamanlayıcısı/);
    const dom = document.querySelector('.ch-editor .ProseMirror') as HTMLElement & {
      editor?: Editor;
    };
    act(() => {
      dom.editor!.chain().focus('end').splitBlock().insertContent(' @Zey').run();
    });
    const menu = await screen.findByRole('listbox', { name: 'Bahset' });
    expect(await within(menu).findByRole('option', { name: /Zeynep Arslan/ })).toBeInTheDocument();
    // doc 02 · 9.4: on body (flips, shifts and fits the height), not inside the page that scrolls.
    const panel = menu.closest('[data-radix-popper-content-wrapper]');
    expect(panel?.parentElement).toBe(document.body);
    expect(dom.contains(menu)).toBe(false);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox', { name: 'Bahset' })).toBeNull());
  });

  it('searches pages with highlighted snippets', async () => {
    signedInAs(USER.bugra);
    renderApp('/pages/search?q=Worker');
    // The hit title is bold; the page tree may also list "Mimari" when its parent is open.
    expect(await screen.findByText('Mimari', { selector: 'b' })).toBeInTheDocument();
    expect(screen.getByText('Worker').tagName).toBe('MARK');
  });
});
