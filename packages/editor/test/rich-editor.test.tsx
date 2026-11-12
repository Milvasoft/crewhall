import type { Editor } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { markdownToDoc, type EditorDoc, type JSONNode } from '../src';
import { editorLabelKeys, RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

const getEditor = (container: HTMLElement): Editor => {
  const dom = container.querySelector('.ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  if (!dom?.editor) throw new Error('editor not mounted');
  return dom.editor;
};

/** Types like a user: each character goes through ProseMirror's text input handlers. */
function typeText(editor: Editor, text: string) {
  const view = editor.view;
  for (const ch of text) {
    act(() => {
      const { from, to } = view.state.selection;
      const deflt = () => view.state.tr.insertText(ch, from, to);
      const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, deflt));
      if (!handled) view.dispatch(deflt());
    });
  }
}

function pressKey(editor: Editor, key: string) {
  act(() => {
    fireEvent.keyDown(editor.view.dom, { key });
  });
}

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

/** Renders an editor with an empty paragraph focused at the end. */
function setup(md = '', extra: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const onChange = vi.fn<(d: EditorDoc) => void>();
  const ref = createRef<RichEditorHandle>();
  const utils = render(
    <RichEditor
      value={doc(md)}
      labels={fakeLabels}
      onChange={onChange}
      editorRef={ref}
      enableTruncate
      {...extra}
    />,
  );
  const editor = getEditor(utils.container);
  act(() => {
    editor.commands.focus('end');
  });
  return { ...utils, editor, onChange, ref };
}

const types = (d: EditorDoc | JSONNode): string[] => (d.content ?? []).map((n) => n.type);

describe('RichEditor', () => {
  it('renders the document and calls onChange on typing', () => {
    const { container, editor, onChange } = setup('# Hello\n\nWorld');
    expect(container.querySelector('h1')).toHaveTextContent('Hello');
    typeText(editor, '!');
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.lastCall?.[0];
    expect(last?.content?.[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'World!' }],
    });
  });

  it('exposes an imperative handle', () => {
    const { ref, onChange } = setup('Start');
    act(() => ref.current!.insertMarkdown('## Added\n\n- one\n- two'));
    // The trailing-node plugin keeps an empty paragraph after a list.
    expect(types(ref.current!.getJSON())).toEqual([
      'paragraph',
      'heading',
      'bulletList',
      'paragraph',
    ]);
    act(() => ref.current!.setContent(doc(':::tip\nHi\n:::')));
    expect(ref.current!.getJSON().content?.[0]).toEqual(doc(':::tip\nHi\n:::').content?.[0]);
    expect(onChange).toHaveBeenCalled();
    expect(() =>
      ref.current!.setContent({ type: 'doc', content: [{ type: 'hologram' }] }),
    ).toThrow();
  });

  it('opens the slash menu, filters it and inserts an admonition', async () => {
    const { editor, onChange } = setup('');
    typeText(editor, '/');
    const menu = await screen.findByRole('listbox', { name: 'L:slashMenu' });
    const all = within(menu).getAllByRole('option');
    expect(all.length).toBeGreaterThan(15);
    expect(all.map((o) => o.textContent)).toContain('L:slashTruncateL:slashTruncateDesc');

    typeText(editor, 'warn');
    await waitFor(() => {
      expect(
        within(menu)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['L:admonitionWarningL:slashAdmonitionDesc']);
    });
    pressKey(editor, 'Enter');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    const json = editor.getJSON() as EditorDoc;
    expect(json.content?.[0]).toMatchObject({
      type: 'admonition',
      attrs: { type: 'warning', title: null },
      content: [{ type: 'paragraph' }],
    });
    // The caret is inside the admonition: typing fills its paragraph.
    typeText(editor, 'Careful');
    expect(onChange.mock.lastCall?.[0].content?.[0]).toMatchObject({
      type: 'admonition',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }],
    });
    // The admonition view uses host labels.
    expect(screen.getByRole('combobox', { name: 'L:admonitionType' })).toHaveValue('warning');
    expect(screen.getByPlaceholderText('L:admonitionTitlePlaceholder')).toBeInTheDocument();
  });

  it('navigates the slash menu with arrow keys and inserts a table', async () => {
    const { editor } = setup('Intro');
    act(() => {
      editor.commands.enter();
    });
    typeText(editor, '/tab');
    const menu = await screen.findByRole('listbox');
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('option')
          .map((o) => o.id.replace(/^.*-/, '')),
      ).toEqual(['table', 'tabs']),
    );
    expect(within(menu).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    pressKey(editor, 'ArrowDown');
    pressKey(editor, 'ArrowUp');
    expect(within(menu).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    pressKey(editor, 'Enter');

    const table = (editor.getJSON() as EditorDoc).content?.[1];
    expect(table?.type).toBe('table');
    expect(table?.content).toHaveLength(3);
    expect(types(table!.content![0]!)).toEqual(['tableHeader', 'tableHeader', 'tableHeader']);
    expect(types(table!.content![1]!)).toEqual(['tableCell', 'tableCell', 'tableCell']);
  });

  it('inserts tabs from the slash menu and shows only the active tab', async () => {
    const { editor, container } = setup('');
    typeText(editor, '/tabs');
    const menu = await screen.findByRole('listbox');
    await waitFor(() => expect(within(menu).getAllByRole('option')).toHaveLength(1));
    act(() => fireEvent.click(within(menu).getAllByRole('option')[0]!));

    const tabs = (editor.getJSON() as EditorDoc).content?.[0];
    expect(tabs).toMatchObject({
      type: 'tabs',
      attrs: { groupId: null },
      content: [
        { type: 'tabItem', attrs: { value: 'tab1', label: 'L:tabsNewTab 1', default: false } },
        { type: 'tabItem', attrs: { value: 'tab2', label: 'L:tabsNewTab 2', default: false } },
      ],
    });
    const tabButtons = await screen.findAllByRole('tab');
    expect(tabButtons.map((t) => t.textContent)).toEqual(['L:tabsNewTab 1', 'L:tabsNewTab 2']);
    // The caret went into the first tab.
    expect(tabButtons[0]).toHaveAttribute('aria-selected', 'true');
    typeText(editor, 'First');
    expect((editor.getJSON() as EditorDoc).content?.[0]?.content?.[0]?.content?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'First' }],
    });
    // Only the active tab is visible (a generated rule hides the others).
    const style = container.querySelector('.ch-tabs style');
    expect(style?.textContent).toContain(':not(:nth-child(1))');

    act(() => fireEvent.click(screen.getAllByRole('tab')[1]!));
    await waitFor(() =>
      expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true'),
    );
    expect(container.querySelector('.ch-tabs style')?.textContent).toContain(':not(:nth-child(2))');
    // The caret moved into the second tab.
    typeText(editor, 'Second');
    expect((editor.getJSON() as EditorDoc).content?.[0]?.content?.[1]?.content?.[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Second' }],
    });

    act(() => fireEvent.click(screen.getByRole('button', { name: 'L:tabsAdd' })));
    expect((editor.getJSON() as EditorDoc).content?.[0]?.content).toHaveLength(3);
    act(() => fireEvent.click(screen.getByRole('button', { name: 'L:tabsRemove' })));
    expect((editor.getJSON() as EditorDoc).content?.[0]?.content).toHaveLength(2);
  });

  it('shows raw HTML as text and never renders it', async () => {
    const { container } = setup(
      '<div class="evil"><img src=x onerror="alert(1)"></div>\n\nA <b>b</b>',
    );
    await waitFor(() => {
      expect(container.querySelector('.ch-html-source')).not.toBeNull();
      expect(container.querySelector('.ch-html-inline')).not.toBeNull();
    });
    expect(container.querySelector('.evil')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('.ch-html-source')).toHaveTextContent('<div class="evil">');
    expect(container.querySelector('.ch-html-inline')).toHaveTextContent('<b>');
  });

  it('renders mermaid previews through the host renderer only', async () => {
    const renderMermaid = vi.fn(async (code: string) => `<svg data-code="${code.length}"></svg>`);
    const { container } = setup('```mermaid\nflowchart LR\n  A --> B\n```', { renderMermaid });
    await waitFor(() => expect(container.querySelector('.ch-mermaid-svg svg')).not.toBeNull());
    expect(renderMermaid).toHaveBeenCalledWith('flowchart LR\n  A --> B');
  });

  it('is read-only when editable is false and refuses invalid content', () => {
    const { container } = render(
      <RichEditor value={doc('Text')} labels={fakeLabels} editable={false} />,
    );
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    const bad = render(
      <RichEditor
        value={{ type: 'doc', content: [{ type: 'unknownBlock' }] }}
        labels={fakeLabels}
      />,
    );
    expect(within(bad.container).getByRole('alert')).toHaveTextContent('L:invalidContent');
  });

  it('shows a read-only code block file name as text and hides an empty one', async () => {
    const code = (title: string | null): EditorDoc => ({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'ts', title },
          content: [{ type: 'text', text: 'const a = 1;' }],
        },
      ],
    });
    const empty = render(<RichEditor value={code(null)} labels={fakeLabels} editable={false} />);
    // The node view mounts after the editor; wait for the code block's head.
    await waitFor(() => expect(empty.container.querySelector('.ch-code-head')).not.toBeNull());
    expect(empty.container.querySelector('.ch-code-title')).toBeNull();
    expect(within(empty.container).queryByPlaceholderText('L:codeTitlePlaceholder')).toBeNull();

    const named = render(
      <RichEditor value={code('index.ts')} labels={fakeLabels} editable={false} />,
    );
    await waitFor(() => expect(named.container.querySelector('.ch-code-title')).not.toBeNull());
    const title = named.container.querySelector('.ch-code-title');
    expect(title?.tagName).toBe('SPAN');
    expect(title).toHaveTextContent('index.ts');
    expect(within(named.container).queryByPlaceholderText('L:codeTitlePlaceholder')).toBeNull();

    // Editable: the field stays an input with its placeholder.
    const edit = render(<RichEditor value={code(null)} labels={fakeLabels} />);
    expect(
      (await within(edit.container).findByPlaceholderText('L:codeTitlePlaceholder')).tagName,
    ).toBe('INPUT');
  });

  it('inserts a toggle from the slash menu, edits its summary and collapses it', async () => {
    const { editor, container, onChange } = setup('');
    typeText(editor, '/toggle');
    const menu = await screen.findByRole('listbox');
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual([
        'L:slashToggleL:slashToggleDesc',
        'L:slashToggleHeading1L:slashToggleHeadingDesc',
        'L:slashToggleHeading2L:slashToggleHeadingDesc',
        'L:slashToggleHeading3L:slashToggleHeadingDesc',
      ]),
    );
    pressKey(editor, 'Enter');
    expect((editor.getJSON() as EditorDoc).content?.[0]).toEqual({
      type: 'toggle',
      attrs: { summary: '', level: null },
      content: [{ type: 'paragraph' }],
    });
    // A new toggle is open and the caret is in its body.
    const button = await screen.findByRole('button', { name: 'L:slashToggle' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    typeText(editor, 'Inside');
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('L:toggleSummaryPlaceholder'), {
        target: { value: 'Details' },
      });
    });
    expect(onChange.mock.lastCall?.[0].content?.[0]).toEqual({
      type: 'toggle',
      attrs: { summary: 'Details', level: null },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inside' }] }],
    });
    act(() => fireEvent.click(button));
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.ch-toggle')).toHaveAttribute('data-open', 'false');
  });

  it('inserts a toggle heading from the slash menu and shows it at that level', async () => {
    const { editor, container } = setup('');
    typeText(editor, '/toggle');
    const menu = await screen.findByRole('listbox');
    await waitFor(() => expect(within(menu).getAllByRole('option')).toHaveLength(4));
    pressKey(editor, 'ArrowDown');
    pressKey(editor, 'ArrowDown');
    pressKey(editor, 'Enter');
    expect((editor.getJSON() as EditorDoc).content?.[0]).toMatchObject({
      type: 'toggle',
      attrs: { summary: '', level: 2 },
    });
    await waitFor(() =>
      expect(container.querySelector('.ch-toggle')).toHaveAttribute('data-level', '2'),
    );
  });

  it('names a read-only toggle heading as a heading', async () => {
    setup(':::toggle[Kurulum]{level=2}\nGövde\n:::\n\n:::toggle[Düz]\nx\n:::', { editable: false });
    expect(await screen.findByRole('heading', { name: 'Kurulum', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Düz' })).toBeNull();
  });

  it('starts filled toggles closed and shows embeds and mentions', async () => {
    const renderEmbed = vi.fn((a: { nodeId: string; nodeType: string | null }) =>
      a.nodeType === 'board' ? <div className="host-preview">Board {a.nodeId}</div> : null,
    );
    const md = [
      ':::toggle[More]\nHidden\n:::',
      '::embed{node="f1" type="file"}',
      '::embed{node="b1" type="board"}',
      'Hi [@Ali](mention:user:u1) on [@20 Oct](mention:date:2026-10-20)',
    ].join('\n\n');
    const { container, ref } = setup(md, { renderEmbed });
    await waitFor(() => expect(container.querySelectorAll('.ch-embed')).toHaveLength(2));
    expect(container.querySelector('.ch-toggle')).toHaveAttribute('data-open', 'false');
    const cards = container.querySelectorAll('.ch-embed-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent('L:embedLabel');
    expect(cards[0]).toHaveTextContent('file');
    expect(cards[0]).toHaveTextContent('f1');
    expect(container.querySelector('.host-preview')).toHaveTextContent('Board b1');
    expect(renderEmbed).toHaveBeenCalledWith({ nodeId: 'b1', nodeType: 'board' });
    const chips = [...container.querySelectorAll('.ch-mention')].map((c) => c.textContent);
    expect(chips).toEqual(['@Ali', '@20 Oct']);
    expect(container.querySelector('.ch-mention-date')).not.toBeNull();
    const expected = markdownToDoc(md).doc;
    expected.content![0]!.attrs = { ...expected.content![0]!.attrs, level: null };
    expect(ref.current!.getJSON()).toEqual(expected);
  });

  it('shows only host labels (no untranslated text)', async () => {
    const md = [
      ':::note[Title]\nBody\n:::',
      '<Tabs>\n  <TabItem value="a" label="A">\n    x\n  </TabItem>\n</Tabs>',
      '```mermaid\ngraph TD\n```',
      '```js\nconst a = 1;\n```',
      'Summary\n\n<!-- truncate -->',
      '<div>raw</div>',
      'Inline <span>html</span>',
      ':::toggle[Sum]\nIn\n:::',
      '::embed{node="e1" type="file"}',
      'By [@Ali](mention:user:u1)',
    ].join('\n\n');
    const { container, editor } = setup(md);
    await waitFor(() => expect(container.querySelector('.ch-truncate')).not.toBeNull());
    typeText(editor, '/');
    await screen.findByRole('listbox');
    const docText = new Set([
      'Title',
      'Body',
      'A',
      'x',
      'graph TD',
      'const a = 1;',
      'Summary',
      'In',
      'file',
      'e1',
    ]);
    const leaks: string[] = [];
    const scan = (root: Element) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = (n.textContent ?? '').trim();
        if (!t || t.startsWith('L:') || docText.has(t) || t.startsWith('<') || t.includes('{')) {
          continue;
        }
        if (
          n.parentElement?.closest('.ProseMirror [data-node-view-content], .ProseMirror p, pre')
        ) {
          continue;
        }
        leaks.push(t);
      }
      for (const el of root.querySelectorAll('[placeholder],[aria-label],[title]')) {
        for (const attr of ['placeholder', 'aria-label', 'title']) {
          const v = el.getAttribute(attr);
          if (v && !v.startsWith('L:') && !docText.has(v)) leaks.push(`${attr}=${v}`);
        }
      }
    };
    scan(container);
    scan(document.body.querySelector('.ch-slash')!);
    expect(leaks).toEqual([]);
    for (const key of [
      'admonitionNote',
      'tabsAdd',
      'mermaidLabel',
      'truncateLabel',
      'htmlBlockLabel',
      'embedLabel',
      'toggleSummaryPlaceholder',
    ]) {
      expect(container.textContent + container.innerHTML).toContain(`L:${key}`);
    }
  });
});

describe('editorLabelKeys', () => {
  it('lists every EditorLabels key once', () => {
    expect(new Set(editorLabelKeys).size).toBe(editorLabelKeys.length);
    expect(editorLabelKeys.length).toBeGreaterThan(60);
    // Type level: a Record over the keys must be assignable to EditorLabels.
    const labels: Record<(typeof editorLabelKeys)[number], string> = fakeLabels;
    expect(Object.keys(labels).sort()).toEqual([...editorLabelKeys].sort());
  });
});
