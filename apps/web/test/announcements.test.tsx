import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { announcementsState } from '@/mocks/announcements';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Roadmap 19: internal announcements feed, "Okudum", the home card and the rail entry. */

describe('announcements', () => {
  it('shows the pinned and newest ones on the home card', async () => {
    signedInAs(USER.zeynep);
    renderApp('/');
    const card = await screen.findByRole('region', { name: 'Duyurular' });
    const links = await within(card).findAllByRole('link');
    expect(links[0]).toHaveTextContent('Tümü');
    expect(within(card).getByText('Yeni izin politikası 1 Kasım’da başlıyor')).toBeInTheDocument();
    expect(within(card).getByLabelText('2 okunmamış duyuru')).toBeInTheDocument();
  });

  it('confirms "Okudum" right on the home card', async () => {
    signedInAs(USER.zeynep);
    renderApp('/');
    const user = userEvent.setup();
    const card = await screen.findByRole('region', { name: 'Duyurular' });
    const pinned = announcementsState(db()).find((a) => a.requiresAck)!;
    await user.click(
      await within(card).findByRole('button', { name: `${pinned.title} için okudum de` }),
    );
    await waitFor(() =>
      expect(pinned.reads.find((r) => r.userId === USER.zeynep)?.ackedAt).toBeTruthy(),
    );
    await waitFor(() =>
      expect(within(card).queryByRole('button', { name: /okudum de/ })).toBeNull(),
    );
  });

  it('asks for "Okudum" and counts the reader', async () => {
    signedInAs(USER.zeynep);
    const pinned = announcementsState(db()).find((a) => a.requiresAck)!;
    renderApp(`/announcements/${pinned.id}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: pinned.title });
    // Opening it counts as read.
    await waitFor(() =>
      expect(announcementsState(db())[0]!.reads.some((r) => r.userId === USER.zeynep)).toBe(true),
    );
    await user.click(await screen.findByRole('button', { name: 'Okudum' }));
    expect(await screen.findByText(/Okudum dedin/)).toBeInTheDocument();
    // The author (Elif) is neither counted nor in the total (B3): 1 of the other 6.
    expect(screen.getByText(/1 \/ 6 kişi onayladı/)).toBeInTheDocument();
    // Members can't manage someone else's announcement.
    expect(screen.queryByRole('button', { name: 'Duyuru işlemleri' })).toBeNull();
  });

  it('lets an admin publish one, pinned first in the feed', async () => {
    signedInAs(USER.bugra);
    renderApp('/announcements');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Duyuru yaz' }));
    const dialog = await screen.findByRole('dialog', { name: 'Duyuru yaz' });
    await user.type(within(dialog).getByLabelText('Başlık'), 'Ofis taşınıyor');
    await user.type(
      within(dialog).getByLabelText('Metin'),
      'Pazartesiden itibaren yeni ofisteyiz.',
    );
    await user.click(within(dialog).getByRole('checkbox', { name: /Önemli/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Yayınla' }));
    expect(await screen.findByRole('heading', { name: 'Ofis taşınıyor' })).toBeInTheDocument();
    const created = announcementsState(db()).find((a) => a.title === 'Ofis taşınıyor');
    expect(created?.pinnedAt).not.toBeNull();
    // Its manager sees who has not read it yet; the heading follows the filter (B3).
    const unread = await screen.findByRole('region', { name: 'Okumayanlar' });
    expect(within(unread).queryByText('Ahmet Buğra Kösen')).toBeNull();
    await user.click(within(unread).getByRole('button', { name: 'Okuyanlar' }));
    const read = await screen.findByRole('region', { name: 'Okuyanlar' });
    expect(within(read).getByRole('heading', { name: 'Okuyanlar' })).toBeInTheDocument();
    // The author is not a reader of their own announcement.
    expect(within(read).getByText('Bu listede kimse yok.')).toBeInTheDocument();
  });

  it('hides the write button from members without the permission', async () => {
    signedInAs(USER.zeynep);
    renderApp('/announcements');
    expect(await screen.findByText('Cuma 16:00 Milvasoft buluşması')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Duyuru yaz' })).toBeNull();
    expect(screen.getAllByRole('link', { name: /Duyurular/ }).length).toBeGreaterThan(0);
  });
});
