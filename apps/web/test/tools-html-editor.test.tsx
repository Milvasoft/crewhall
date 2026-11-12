import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

describe('HTML WYSIWYG editor tool', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for a link address in a dialog, not window.prompt', async () => {
    // jsdom has no editing commands; the dialog's result is what is checked here.
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const prompt = vi.spyOn(window, 'prompt');
    signedInAs(USER.bugra);
    renderApp('/tools/html-wysiwyg-editor');
    const user = userEvent.setup();

    const linkButton = await screen.findByRole('button', { name: 'Bağlantı' }, { timeout: 10_000 });
    await user.click(linkButton);

    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Bağlantı ekle' });
    expect(add).toBeDisabled();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Bağlantı adresi' }),
      'https://example.com',
    );
    await user.click(add);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(exec).toHaveBeenCalledWith('createLink', false, 'https://example.com');
    expect(prompt).not.toHaveBeenCalled();
  });

  it('adds nothing when the dialog is cancelled', async () => {
    const exec = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    signedInAs(USER.bugra);
    renderApp('/tools/html-wysiwyg-editor');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Bağlantı' }, { timeout: 10_000 }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Vazgeç' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(exec).not.toHaveBeenCalled();
  });
});
