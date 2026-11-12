import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { kudosState } from '@/mocks/announcements';
import { contactsMockState } from '@/mocks/contacts';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Duyurular › Teşekkür duvarı, the profile cards and the birthday setting. */

describe('thank-you wall', () => {
  it('sends a card with a badge and a message', async () => {
    signedInAs(USER.bugra);
    renderApp('/announcements/kudos');
    const user = userEvent.setup();
    // The seeded card is on the wall.
    const wall = await screen.findByRole('list', { name: 'Teşekkür duvarı' });
    expect(within(wall).getByText(/Portal ana sayfa tasarımı/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Teşekkür et' }));
    const dialog = await screen.findByRole('dialog', { name: 'Teşekkür kartı gönder' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Kişi ara' }), 'Zeynep');
    await user.click(await within(dialog).findByRole('button', { name: /Zeynep Arslan/ }));
    await user.click(within(dialog).getByRole('radio', { name: /Takım ruhu/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /Mesaj/ }), 'Süpersin');
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));

    await waitFor(() =>
      expect(kudosState(db()).cards.some((k) => k.message === 'Süpersin')).toBe(true),
    );
    const card = kudosState(db()).cards.find((k) => k.message === 'Süpersin')!;
    expect(card).toMatchObject({ fromUserId: USER.bugra, toUserId: USER.zeynep });
    expect(await screen.findByText('Süpersin')).toBeInTheDocument();
  });

  it('shows the coming birthdays and anniversaries beside the wall', async () => {
    signedInAs(USER.bugra);
    renderApp('/announcements/kudos');
    const side = await screen.findByRole('complementary', { name: 'Kutlamalar' });
    const upcoming = await within(side).findByRole('region', { name: 'Yaklaşanlar' });
    expect(within(upcoming).getByText('Doğum günü')).toBeInTheDocument();
    expect(within(upcoming).getByText('2. iş yılı')).toBeInTheDocument();
  });

  it('lets admins rename a ready badge', async () => {
    signedInAs(USER.bugra);
    renderApp('/announcements/kudos');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ayarlar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Teşekkür duvarı ayarları' });
    const field = await within(dialog).findByRole('textbox', {
      name: 'Parlak fikir rozetinin adı',
    });
    await user.clear(field);
    await user.type(field, 'Fikir makinesi{Enter}');
    await waitFor(() =>
      expect(kudosState(db()).badges.find((b) => b.key === 'idea')?.name).toBe('Fikir makinesi'),
    );
  });
});

describe('birthday on the profile', () => {
  it('is shown to members only after its person turns it on', async () => {
    contactsMockState().profiles[USER.elif] = {
      ...contactsMockState().profiles[USER.elif],
      birthday: '05-17',
      birthdayVisible: false,
    };
    // A plain member: admins always see birthdays.
    signedInAs(USER.mert);
    renderApp(`/people/${USER.elif}`);
    await screen.findByRole('heading', { name: 'Elif Yıldız', level: 1 });
    expect(screen.queryByText('Doğum günü')).toBeNull();
    // Cards Elif received are listed on her profile.
    expect(await screen.findByRole('region', { name: 'Aldığı teşekkürler' })).toBeInTheDocument();

    contactsMockState().profiles[USER.elif]!.birthdayVisible = true;
    renderApp(`/people/${USER.elif}`);
    expect(await screen.findByText('17 Mayıs')).toBeInTheDocument();
  });
});
