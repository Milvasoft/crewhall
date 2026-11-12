import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docToMarkdown, markdownToDoc, type EditorDoc } from '../src';
import { findMatches, findState, RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** Find and replace in a page (Ctrl+F / Ctrl+H). */

const doc = (md: string): EditorDoc => markdownToDoc(md).doc;

function mount(md: string, props: Partial<Parameters<typeof RichEditor>[0]> = {}) {
  const ref = createRef<RichEditorHandle>();
  const utils = render(
    <RichEditor value={doc(md)} labels={fakeLabels} editorRef={ref} find {...props} />,
  );
  return { ...utils, editor: () => ref.current!.getEditor() };
}
type Ed = ReturnType<ReturnType<typeof mount>['editor']>;

const md = (e: Ed) => docToMarkdown(e.getJSON() as EditorDoc).trimEnd();

const openFind = (key: 'f' | 'h' = 'f') =>
  act(() => {
    fireEvent.keyDown(window, { key, ctrlKey: true });
  });

const type = (label: string, value: string) => {
  fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
};

describe('findMatches', () => {
  const schemaDoc = () => mount('Kalın **metin** ve metİn.\n\n```\nmetin\n```').editor().state.doc;

  it('finds across marks in every block, folding case and the Turkish i', () => {
    expect(findMatches(schemaDoc(), 'METIN', false)).toHaveLength(3);
    expect(findMatches(schemaDoc(), 'metin', true)).toHaveLength(2);
    expect(findMatches(schemaDoc(), 'n me', false)).toHaveLength(1);
    expect(findMatches(schemaDoc(), '', false)).toEqual([]);
  });

  it('does not match over a block boundary or an inline image', () => {
    const d = mount('Bir\n\nİki ![a](/a.png) son').editor().state.doc;
    expect(findMatches(d, 'BirIki', false)).toEqual([]);
    expect(findMatches(d, 'iki  son', false)).toEqual([]);
    expect(findMatches(d, 'son', false)).toHaveLength(1);
  });
});

describe('find bar', () => {
  it('opens on Ctrl+F, highlights matches, walks them and closes on Escape', () => {
    const { editor, container } = mount('elma armut\n\nelma\n\nkiraz elma');
    openFind();
    const box = screen.getByRole('search', { name: 'L:findLabel' });
    expect(box).toBeInTheDocument();
    type('L:findPlaceholder', 'elma');
    expect(screen.getByRole('status')).toHaveTextContent('1/3');
    expect(container.querySelectorAll('.ch-find-match')).toHaveLength(3);
    expect(container.querySelectorAll('.ch-find-current')).toHaveLength(1);
    const input = screen.getByRole('textbox', { name: 'L:findPlaceholder' });

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('status')).toHaveTextContent('2/3');
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    // Around the start.
    expect(screen.getByRole('status')).toHaveTextContent('3/3');
    fireEvent.click(screen.getByRole('button', { name: 'L:findNext' }));
    expect(screen.getByRole('status')).toHaveTextContent('1/3');

    type('L:findPlaceholder', 'yok');
    expect(screen.getByRole('status')).toHaveTextContent('L:findNoResults');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('search')).toBeNull();
    expect(container.querySelector('.ch-find-match')).toBeNull();
    expect(findState(editor().state).query).toBe('');
    // Nothing of this is in the document.
    expect(md(editor())).toBe('elma armut\n\nelma\n\nkiraz elma');
  });

  it('honours the case option and starts from the selected text', () => {
    const { editor } = mount('Elma elma ELMA');
    act(() => {
      editor().commands.setTextSelection({ from: 6, to: 10 });
    });
    openFind();
    expect(screen.getByRole('textbox', { name: 'L:findPlaceholder' })).toHaveValue('elma');
    expect(screen.getByRole('status')).toHaveTextContent('2/3');
    fireEvent.click(screen.getByRole('button', { name: 'L:findCase' }));
    expect(screen.getByRole('status')).toHaveTextContent('1/1');
  });

  it('follows the document as it changes', () => {
    const { editor } = mount('elma');
    openFind();
    type('L:findPlaceholder', 'elma');
    expect(screen.getByRole('status')).toHaveTextContent('1/1');
    act(() => {
      editor().commands.insertContentAt(1, 'elma ');
    });
    expect(findState(editor().state).matches).toHaveLength(2);
  });

  it('replaces one and moves on; a replacement containing the word does not loop', () => {
    const { editor } = mount('elma elma');
    openFind('h');
    type('L:findPlaceholder', 'elma');
    type('L:findReplacePlaceholder', 'elma suyu');
    fireEvent.click(screen.getByRole('button', { name: 'L:findReplace' }));
    expect(md(editor())).toBe('elma suyu elma');
    expect(findState(editor().state).current).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'L:findReplace' }));
    expect(md(editor())).toBe('elma suyu elma suyu');
  });

  it('replaces all in one undo step, keeping marks', () => {
    const { editor } = mount('**elma** ve elma');
    openFind('h');
    type('L:findPlaceholder', 'elma');
    type('L:findReplacePlaceholder', 'armut');
    fireEvent.click(screen.getByRole('button', { name: 'L:findReplaceAll' }));
    expect(md(editor())).toBe('**armut** ve armut');
    act(() => {
      editor().commands.undo();
    });
    expect(md(editor())).toBe('**elma** ve elma');
  });

  it('replaces all over Yjs as one undoable step for everyone', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u));
    const first = mount('', { collaboration: { doc: a } });
    const second = mount('', { collaboration: { doc: b }, find: false });
    // Written by the other editor, so it is not in the first one's undo history.
    act(() => {
      second.editor().commands.setContent(doc('elma elma\n\nelma'));
    });
    openFind('h');
    type('L:findPlaceholder', 'elma');
    type('L:findReplacePlaceholder', 'armut');
    fireEvent.click(screen.getByRole('button', { name: 'L:findReplaceAll' }));
    expect(md(second.editor())).toBe('armut armut\n\narmut');
    act(() => {
      first.editor().commands.undo();
    });
    expect(md(first.editor())).toBe('elma elma\n\nelma');
    expect(md(second.editor())).toBe('elma elma\n\nelma');
  });

  it('keeps matches when someone else edits', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u));
    b.on('update', (u: Uint8Array) => Y.applyUpdate(a, u));
    const first = mount('', { collaboration: { doc: a } });
    const second = mount('', { collaboration: { doc: b }, find: false });
    act(() => {
      second.editor().commands.setContent(doc('elma'));
    });
    openFind();
    type('L:findPlaceholder', 'elma');
    act(() => {
      second.editor().commands.insertContentAt(1, 'elma ');
    });
    expect(findState(first.editor().state).matches).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('/2');
  });

  it('finds but does not replace in a read-only editor', () => {
    mount('elma', { editable: false });
    openFind('h');
    type('L:findPlaceholder', 'elma');
    expect(screen.getByRole('status')).toHaveTextContent('1/1');
    expect(screen.queryByRole('textbox', { name: 'L:findReplacePlaceholder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'L:findToggleReplace' })).toBeNull();
  });

  it('leaves Ctrl+F to the browser without the option', () => {
    mount('elma', { find: false });
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('search')).toBeNull();
  });
});
