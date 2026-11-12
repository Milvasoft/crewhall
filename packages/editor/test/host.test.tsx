import { Extension } from '@tiptap/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { markdownToDoc, type EditorDoc } from '../src';
import { createExtensions, RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

/**
 * Host hooks used by the wiki: extra extensions, extra "/" items, selection actions (also on a
 * read-only editor), the editor handle and remote carets with a collaboration provider.
 */

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

function mount(props: Partial<Parameters<typeof RichEditor>[0]> = {}, md = 'Hello world') {
  const ref = createRef<RichEditorHandle>();
  const utils = render(
    <RichEditor value={doc(md)} labels={fakeLabels} editorRef={ref} {...props} />,
  );
  return { ...utils, ref, editor: () => ref.current!.getEditor() };
}

/** Selects [from, to) of the first paragraph, in ProseMirror and in the DOM. */
function selectWord(handle: RichEditorHandle, from: number, to: number) {
  const editor = handle.getEditor();
  act(() => {
    editor.commands.focus();
    editor.commands.setTextSelection({ from, to });
    const p = editor.view.dom.querySelector('p')!;
    const range = document.createRange();
    range.setStart(p.firstChild!, from - 1);
    range.setEnd(p.firstChild!, to - 1);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // Any transaction makes the menu re-check shouldShow.
    editor.view.dispatch(editor.state.tr.setMeta('test', true));
  });
}

describe('RichEditor host hooks', () => {
  it('exposes the Tiptap editor and adds host extensions', () => {
    const Host = Extension.create({ name: 'hostProbe' });
    const { ref, editor } = mount({ extensions: [Host] });
    expect(ref.current!.getEditor()).toBe(editor());
    expect(editor().extensionManager.extensions.map((e) => e.name)).toContain('hostProbe');
  });

  it('appends host extensions after the built-in ones', () => {
    const names = createExtensions({ extensions: [Extension.create({ name: 'x' })] }).map(
      (e) => e.name,
    );
    expect(names.at(-1)).toBe('x');
  });

  it('adds host items to the "/" menu and runs them', async () => {
    const run = vi.fn();
    const { editor } = mount(
      {
        slashItems: () => [
          {
            id: 'embed',
            title: 'Embed it',
            description: 'Host item',
            keywords: ['drive'],
            icon: 'embed',
            run: (e, r) => {
              e.chain().focus().deleteRange(r).run();
              run();
            },
          },
        ],
      },
      '',
    );
    act(() => {
      editor().commands.focus('end');
      editor().commands.insertContent('/drive');
    });
    const menu = await screen.findByRole('listbox', { name: 'L:slashMenu' });
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Embed itHost item']),
    );
    act(() => {
      fireEvent.keyDown(editor().view.dom, { key: 'Enter' });
    });
    expect(run).toHaveBeenCalledOnce();
    expect(editor().getText()).toBe('');
  });

  it('shows selection actions after the marks and hides the toolbar once one runs', async () => {
    const onComment = vi.fn();
    const { ref } = mount({
      selectionActions: () => (
        <button type="button" onClick={onComment}>
          Comment
        </button>
      ),
    });
    selectWord(ref.current!, 1, 6);
    const button = await screen.findByRole('button', { name: 'Comment' });
    const bar = screen.getByRole('toolbar', { name: 'L:toolbar' });
    expect(within(bar).getByRole('button', { name: 'L:bold' })).toBeInTheDocument();
    fireEvent.click(button);
    expect(onComment).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(bar.parentElement?.style.visibility === 'hidden' || !bar.isConnected).toBe(true),
    );
  });

  it('offers only the selection actions on a read-only editor', async () => {
    const { ref } = mount({
      editable: false,
      selectionActions: () => <button type="button">Comment</button>,
    });
    selectWord(ref.current!, 1, 6);
    const button = await screen.findByRole('button', { name: 'Comment' });
    const bar = button.closest('[role="toolbar"]') as HTMLElement;
    expect(within(bar).queryByRole('button', { name: 'L:bold' })).not.toBeInTheDocument();
  });

  it('shows no toolbar for a read-only editor without selection actions', () => {
    const { ref } = mount({ editable: false });
    selectWord(ref.current!, 1, 6);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('adds remote carets when a provider is given', () => {
    const ydoc = new Y.Doc();
    const states = new Map<number, Record<string, unknown>>();
    const awareness = {
      clientID: 1,
      states,
      getStates: () => states,
      getLocalState: () => states.get(1) ?? null,
      setLocalState: (s: Record<string, unknown> | null) => {
        if (s) states.set(1, s);
        else states.delete(1);
      },
      setLocalStateField: (k: string, v: unknown) => states.set(1, { ...states.get(1), [k]: v }),
      on: () => undefined,
      off: () => undefined,
    };
    const { editor } = mount({
      collaboration: {
        doc: ydoc,
        provider: { awareness },
        user: { name: 'Ada', color: '#16a34a' },
      },
    });
    const names = editor().extensionManager.extensions.map((e) => e.name);
    expect(names).toContain('collaboration');
    expect(names).toContain('collaborationCaret');
    expect(states.get(1)).toMatchObject({ user: { name: 'Ada', color: '#16a34a' } });
  });
});
