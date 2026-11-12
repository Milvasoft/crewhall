import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { markSessionExpired } from '@/lib/sessionEvents';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Manual test findings 2026-10-22, B1 and B2 (docs/contracts/test-bulgulari-2026-10-22.md). */
describe('Yönetim › Yedekler opens clean (B1)', () => {
  it('shows no pending change for a schedule that was never saved', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/backups');
    expect(await screen.findByRole('heading', { name: 'Yedekler', level: 1 })).toBeInTheDocument();
    await screen.findByRole('switch', { name: 'Gece yedeği' });
    expect(screen.queryByText(/Kaydedilmemiş/)).toBeNull();
  });

  it('opens with the saved time zone and still no pending change', async () => {
    const holder = db() as ReturnType<typeof db> & {
      backups?: { configured: boolean; settings: { timezone: string } };
    };
    signedInAs(USER.bugra);
    renderApp('/admin/backups');
    await screen.findByRole('switch', { name: 'Gece yedeği' });
    holder.backups!.configured = true;
    holder.backups!.settings = { ...holder.backups!.settings, timezone: 'Asia/Tokyo' };
    renderApp('/admin/backups');
    expect(await screen.findAllByText('Asia/Tokyo')).not.toHaveLength(0);
    expect(screen.queryByText(/Kaydedilmemiş/)).toBeNull();
  });

  it('asks before leaving with unsaved changes, and stays on "Vazgeç"', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/backups');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Gece yedeği' }));
    expect(screen.getByText('Kaydedilmemiş 1 değişiklik')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Genel' }));
    const ask = await screen.findByRole('dialog', { name: 'Kaydedilmemiş değişiklikler' });
    await user.click(within(ask).getByRole('button', { name: 'Vazgeç' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('heading', { name: 'Yedekler', level: 1 })).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Genel' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Kaydedilmemiş değişiklikler' })).getByRole(
        'button',
        { name: 'Çık' },
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Genel' })).toBeInTheDocument();
  });
});

describe('re-auth dialog (B2)', () => {
  it('speaks of security and keeps "Devam" inside the dialog', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/compliance');
    await screen.findByRole('heading', { name: 'Uyumluluk' });
    act(() => markSessionExpired());
    const dialog = await screen.findByRole('dialog', { name: 'Güvenlik için yeniden doğrula' });
    expect(within(dialog).queryByText('Oturumun sona erdi')).toBeNull();
    const next = within(dialog).getByRole('button', { name: 'Devam' });
    // Next to the passkey button it takes the remaining width instead of 100% (the overflow).
    expect(next.className).not.toMatch(/\bw-full\b/);
    expect(next.className).toMatch(/\bflex-1\b/);
    expect(next.parentElement!.className).toMatch(/\bflex-wrap\b/);
  });
});
