import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canView, closeViewer, kindOf } from '@/lib/viewer';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

afterEach(() => closeViewer());

describe('shared viewer', () => {
  it('knows what it can show in place', () => {
    expect(kindOf('image/png')).toBe('image');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf(null, 'rapor.PDF')).toBe('pdf');
    expect(canView('application/zip', 'arsiv.zip')).toBe(false);
    // SVG can carry scripts: it is downloaded, not drawn.
    expect(canView('image/svg+xml')).toBe(false);
    // Without a type (files handed over by the desktop app) the name decides.
    expect(kindOf(null, 'ekran.JPG')).toBe('image');
    expect(kindOf('application/octet-stream', 'kayit.mp4')).toBe('video');
    expect(kindOf(null, 'notlar.docx')).toBe('other');
  });

  it('shows a file the desktop app hands back instead of opening a window', async () => {
    let listener: ((f: { url: string; name: string }) => void) | null = null;
    window.crewhallDesktop = {
      isDesktop: true,
      features: ['openFile'],
      onOpenFile: (l: (f: { url: string; name: string }) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    } as unknown as NonNullable<typeof window.crewhallDesktop>;
    try {
      signedInAs(USER.bugra);
      const view = renderApp('/drive/recent');
      await waitFor(() => expect(listener).not.toBeNull());
      act(() => listener?.({ url: 'https://files.example/ekran.png', name: 'ekran.png' }));
      const dialog = await screen.findByRole('dialog', { name: 'ekran.png' });
      await waitFor(() =>
        expect(
          within(dialog).getByTestId('viewer-image').querySelector('img[alt]'),
        ).toHaveAttribute('src', 'https://files.example/ekran.png'),
      );
      view.unmount();
      expect(listener).toBeNull();
    } finally {
      delete window.crewhallDesktop;
    }
  });

  it('opens a chat image in the app instead of a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const thumb = await screen.findByRole('button', {
      name: 'job-history-bench.png dosyasını aç',
    });
    await user.click(thumb);
    const dialog = await screen.findByRole('dialog', { name: 'job-history-bench.png' });
    expect(within(dialog).getByRole('button', { name: 'İndir' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Linki kopyala' })).toBeInTheDocument();
    await waitFor(() =>
      expect(within(dialog).getByTestId('viewer-image').querySelector('img[alt]')).not.toBeNull(),
    );
    expect(open).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    open.mockRestore();
  });

  it('opens a PDF attachment in the viewer too', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const [name] = await screen.findAllByRole('button', { name: /^milva-sunum-2026\.pdf/ });
    await user.click(name!);
    const dialog = await screen.findByRole('dialog', { name: 'milva-sunum-2026.pdf' });
    await waitFor(() =>
      expect(within(dialog).getByTitle('milva-sunum-2026.pdf')).toHaveAttribute('src'),
    );
  });
});
