import { act, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { emptyDoc } from '../src';
import { RichEditor, type RichEditorHandle } from '../src/react';
import { fakeLabels } from './helpers/labels';

/** A shared document from a newer client: what this client does not know must not cost the page. */

const FIELD = 'default';
const PLACEHOLDER = 'L:unknownBlock';

function paragraph(text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  return p;
}

/** A block of a newer version, with an attribute and content of its own. */
function future() {
  const el = new Y.XmlElement('futureBlock');
  el.setAttribute('level', '2');
  el.insert(0, [paragraph('İç')]);
  return el;
}

const FUTURE = '<futureblock level="2"><paragraph>İç</paragraph></futureblock>';

async function mount(build: () => Y.XmlElement[]) {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment(FIELD);
  doc.transact(() => frag.insert(0, build()));
  const ref = createRef<RichEditorHandle>();
  render(
    <RichEditor
      value={emptyDoc()}
      labels={fakeLabels}
      editorRef={ref}
      collaboration={{
        doc,
        field: FIELD,
        provider: null as never,
        user: { name: 'U', color: '#000' },
      }}
    />,
  );
  const editor = ref.current!.getEditor();
  await waitFor(() => expect(frag.length).toBeGreaterThan(0));
  await waitFor(() => expect(editor.state.doc.childCount).toBe(frag.length));
  return { doc, frag, editor, shared: () => frag.toString() };
}

const placeholders = () => screen.queryAllByText(PLACEHOLDER);

describe('content this client does not know', () => {
  it('shows a placeholder and leaves the rest of the page editable', async () => {
    const { editor, shared } = await mount(() => [paragraph('Önce'), future(), paragraph('Sonra')]);
    expect(editor.isEditable).toBe(true);
    expect(editor.state.doc.textContent).toBe('ÖnceSonra');
    expect(await screen.findByText(PLACEHOLDER)).toBeInTheDocument();
    expect(shared()).toBe(`<paragraph>Önce</paragraph>${FUTURE}<paragraph>Sonra</paragraph>`);
  });

  it('shows a known block with a newer attribute as it knows it, losing it only on edits inside', async () => {
    const toggle = () => {
      const el = new Y.XmlElement('toggle');
      el.setAttribute('summary', 'Kurulum');
      el.setAttribute('futureAttr', '2');
      el.insert(0, [paragraph('İç')]);
      return el;
    };
    const { editor, shared } = await mount(() => [paragraph('Önce'), toggle(), paragraph('Sonra')]);
    expect(editor.state.doc.child(1).type.name).toBe('toggle');
    expect(placeholders()).toHaveLength(0);
    act(() => {
      editor.commands.insertContentAt(1, 'X');
    });
    await waitFor(() => expect(shared()).toContain('<paragraph>XÖnce</paragraph>'));
    expect(shared()).toContain('futureAttr="2"');
    // An edit inside rewrites the block as this client knows it; the content stays.
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.child(0).nodeSize + 2, 'Y');
    });
    await waitFor(() => expect(shared()).toContain('<paragraph>Yİç</paragraph>'));
    expect(shared()).toContain('<toggle summary="Kurulum">');
  });

  it('keeps the unknown content through edits around it', async () => {
    const { editor, shared } = await mount(() => [paragraph('Önce'), future(), paragraph('Sonra')]);
    act(() => {
      editor.commands.insertContentAt(1, 'X');
    });
    await waitFor(() => expect(shared()).toContain('<paragraph>XÖnce</paragraph>'));
    expect(shared()).toContain(FUTURE);

    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Yeni' }],
      });
    });
    act(() => {
      editor.commands.insertContentAt(0, {
        type: 'heading',
        attrs: { level: 1 },
        content: [{ type: 'text', text: 'Başlık' }],
      });
    });
    await waitFor(() => expect(shared()).toContain('Yeni'));
    await waitFor(() => expect(shared()).toContain('Başlık'));
    expect(shared()).toContain(FUTURE);
  });

  it('keeps it through changes that arrive from other people', async () => {
    const { editor, frag, shared } = await mount(() => [paragraph('Önce'), future()]);
    act(() => {
      frag.insert(frag.length, [paragraph('Uzaktan')]);
    });
    await waitFor(() => expect(editor.state.doc.textContent).toContain('Uzaktan'));
    expect(placeholders()).toHaveLength(1);
    act(() => {
      editor.commands.insertContentAt(1, 'X');
    });
    await waitFor(() => expect(shared()).toContain('XÖnce'));
    expect(shared()).toContain(FUTURE);
  });

  it('stays inside a container that allows it', async () => {
    const { editor, shared } = await mount(() => {
      const note = new Y.XmlElement('admonition');
      note.setAttribute('type', 'note');
      note.insert(0, [paragraph('Not'), future()]);
      return [note];
    });
    expect(editor.state.doc.firstChild?.type.name).toBe('admonition');
    expect(editor.state.doc.textContent).toBe('Not');
    expect(await screen.findByText(PLACEHOLDER)).toBeInTheDocument();
    act(() => {
      editor.commands.insertContentAt(2, 'X');
    });
    await waitFor(() => expect(shared()).toContain('<paragraph>XNot</paragraph>'));
    expect(shared()).toContain(FUTURE);
  });

  it('takes the paragraph along when an inline node is unknown', async () => {
    const inline = () => {
      const p = new Y.XmlElement('paragraph');
      p.insert(0, [new Y.XmlText('Değer '), new Y.XmlElement('futureInline')]);
      return p;
    };
    const { editor, shared } = await mount(() => [inline(), paragraph('Sonra')]);
    const before = shared();
    expect(before).toContain('<futureinline');
    expect(editor.state.doc.textContent).toBe('Sonra');
    expect(await screen.findByText(PLACEHOLDER)).toBeInTheDocument();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!');
    });
    await waitFor(() => expect(shared()).toContain('Sonra!'));
    expect(shared()).toContain('Değer ');
    expect(shared()).toContain('<futureinline');
  });

  it('takes the text along when a mark is unknown', async () => {
    const { editor, shared } = await mount(() => {
      const p = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      p.insert(0, [text]);
      text.insert(0, 'Süslü', { futureMark: { tone: 1 } });
      return [p, paragraph('Düz')];
    });
    expect(editor.state.doc.textContent).toBe('Düz');
    expect(await screen.findByText(PLACEHOLDER)).toBeInTheDocument();
    const before = shared();
    expect(before).toContain('Süslü');
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!');
    });
    await waitFor(() => expect(shared()).toContain('Düz!'));
    expect(shared()).toContain('futureMark');
    expect(shared()).toContain('Süslü');
  });

  it('climbs out of a parent that has rules about its children', async () => {
    const { editor, shared } = await mount(() => {
      const list = new Y.XmlElement('taskList');
      const item = new Y.XmlElement('taskItem');
      item.setAttribute('checked', 'false');
      item.insert(0, [future()]);
      list.insert(0, [item]);
      return [list, paragraph('Sonra')];
    });
    expect(editor.state.doc.firstChild?.type.name).toBe('unknownBlock');
    expect(editor.state.doc.check()).toBeUndefined();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, '!');
    });
    await waitFor(() => expect(shared()).toContain('Sonra!'));
    expect(shared()).toContain('<tasklist');
    expect(shared()).toContain(FUTURE);
  });

  it('refuses to move a block across it, which would lose the content', async () => {
    const { editor, shared } = await mount(() => [paragraph('Önce'), future(), paragraph('Sonra')]);
    const before = shared();
    const moved = editor.state.doc.child(0);
    act(() => {
      const tr = editor.state.tr.delete(0, moved.nodeSize);
      editor.view.dispatch(tr.insert(tr.doc.content.size, moved));
    });
    expect(editor.state.doc.firstChild?.textContent).toBe('Önce');
    expect(shared()).toBe(before);
  });

  it('refuses a copy of it and a wrapper around it', async () => {
    const { editor, shared } = await mount(() => [future(), paragraph('Sonra')]);
    const before = shared();
    const unknown = editor.state.doc.child(0);
    act(() => {
      editor.view.dispatch(editor.state.tr.insert(editor.state.doc.content.size, unknown));
    });
    expect(editor.state.doc.childCount).toBe(2);
    act(() => {
      editor.commands.selectAll();
      editor.commands.setAdmonition('note');
    });
    expect(editor.state.doc.firstChild?.type.name).toBe('unknownBlock');
    expect(shared()).toBe(before);
  });

  it('can be deleted on purpose, and undo brings the real content back', async () => {
    const { editor, shared } = await mount(() => [paragraph('Önce'), future(), paragraph('Sonra')]);
    const from = editor.state.doc.child(0).nodeSize;
    act(() => {
      editor.commands.focus();
      editor.view.dispatch(editor.state.tr.delete(from, from + editor.state.doc.child(1).nodeSize));
    });
    await waitFor(() => expect(shared()).not.toContain('futureblock'));
    act(() => {
      editor.commands.undo();
    });
    await waitFor(() => expect(shared()).toContain(FUTURE));
    expect(await screen.findByText(PLACEHOLDER)).toBeInTheDocument();
  });

  it('does not read a placeholder back from pasted HTML', async () => {
    const { editor, shared } = await mount(() => [paragraph('Önce')]);
    act(() => {
      editor.commands.insertContentAt(1, '<div data-type="unknown-block"></div>');
    });
    expect(shared()).not.toContain('unknownblock');
    expect(placeholders()).toHaveLength(0);
  });
});
