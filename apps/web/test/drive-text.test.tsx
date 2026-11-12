import { type DriveNode } from '@crewhall/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type * as Editor from '@/features/drive/CodeEditor';
import { TEXT_EDIT_MAX_BYTES, isMarkdown, textMode } from '@/features/drive/textEdit';
import { api } from '@/lib/api';
import { db } from '@/mocks/db';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

// CodeMirror needs real layout; the screen logic is tested with a textarea in its place.
vi.mock('@/features/drive/CodeEditor', () => ({
  default: function CodeEditor({
    initial,
    label,
    readOnly,
    onChange,
    onSave,
  }: Editor.CodeEditorProps) {
    return (
      <textarea
        aria-label={label}
        defaultValue={initial}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 's' && e.ctrlKey) {
            e.preventDefault();
            onSave();
          }
        }}
      />
    );
  },
}));

const COMPOSE = `/drive/altyapi/folder/${NODE.milva01}?preview=${NODE.compose}`;
const versionsOf = (id: string) => db().drive!.versions.filter((v) => v.nodeId === id);

async function openCompose() {
  signedInAs(USER.bugra);
  renderApp(COMPOSE);
  const user = userEvent.setup();
  const editor = await screen.findByRole('textbox', { name: 'docker-compose.yml içeriği' });
  return { user, editor };
}

describe('text files in Drive (roadmap 7)', () => {
  it('saves an edit as a new version with Ctrl S', async () => {
    const { user, editor } = await openCompose();
    const before = versionsOf(NODE.compose).length;
    const save = screen.getByRole('button', { name: 'Kaydet' });
    expect(save).toBeDisabled();
    await user.type(editor, '# not');
    expect(screen.getByText('Kaydedilmemiş değişiklik')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await user.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(versionsOf(NODE.compose)).toHaveLength(before + 1));
    await waitFor(() => expect(screen.queryByText('Kaydedilmemiş değişiklik')).toBeNull());
  });

  it('warns when the file changed meanwhile and can save anyway', async () => {
    const { user, editor } = await openCompose();
    const before = versionsOf(NODE.compose).length;
    // Someone restores an older version while this editor is open.
    const old = versionsOf(NODE.compose)[0]!;
    await api.call('restoreVersion', { params: { nodeId: NODE.compose, versionId: old.id } });
    await user.type(editor, 'x');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dosya sen düzenlerken değişti' });
    expect(versionsOf(NODE.compose)).toHaveLength(before + 1);
    await user.click(within(dialog).getByRole('button', { name: 'Yine de kaydet' }));
    await waitFor(() => expect(versionsOf(NODE.compose)).toHaveLength(before + 2));
  });

  it('asks before closing with unsaved changes', async () => {
    const { user, editor } = await openCompose();
    await user.type(editor, 'y');
    await user.click(screen.getByRole('button', { name: 'Kapat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kaydedilmemiş değişiklikler var' });
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));
    const kept = screen.getByRole('textbox', { name: 'docker-compose.yml içeriği' });
    expect((kept as HTMLTextAreaElement).value).toContain('y');
    await user.click(screen.getByRole('button', { name: 'Kapat' }));
    await user.click(
      within(
        await screen.findByRole('dialog', { name: 'Kaydedilmemiş değişiklikler var' }),
      ).getByRole('button', { name: 'Kaydetmeden çık' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'docker-compose.yml içeriği' })).toBeNull(),
    );
  });

  it('previews Markdown and switches to the source', async () => {
    signedInAs(USER.bugra);
    // The seeded compose file, renamed: its first line is a Markdown heading.
    await api.call('updateNode', { params: { nodeId: NODE.compose }, body: { name: 'README.md' } });
    renderApp(COMPOSE);
    const user = userEvent.setup();
    const preview = await screen.findByTestId('markdown-preview');
    expect(
      await within(preview).findByRole('heading', { name: 'milva-01 · Crewhall yığını' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Kaynak' }));
    const source = await screen.findByRole('textbox', { name: 'README.md içeriği' });
    expect((source as HTMLTextAreaElement).value).toContain('services:');
    expect(screen.queryByTestId('markdown-preview')).toBeNull();
  });
});

describe('textMode', () => {
  const file = (name: string, sizeBytes = 100, mime: string | null = null) =>
    ({ type: 'file', name, sizeBytes, mime }) as DriveNode;
  it('edits text and code within the size limit, otherwise reads', () => {
    expect(textMode(file('a.yml'), true)).toBe('edit');
    expect(textMode(file('notes.txt'), true)).toBe('edit');
    expect(textMode(file('a.ts'), false)).toBe('readonly');
    expect(textMode(file('big.json', TEXT_EDIT_MAX_BYTES + 1), true)).toBe('readonly');
    expect(textMode(file('photo.png'), true)).toBe('none');
    expect(textMode({ ...file('a.md'), type: 'folder' } as DriveNode, true)).toBe('none');
    expect(isMarkdown('README.md')).toBe(true);
    expect(isMarkdown('notes.txt')).toBe(false);
  });
});
