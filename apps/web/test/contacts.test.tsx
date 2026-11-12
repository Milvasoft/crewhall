import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { contactsMockState, resetContactsMock } from '@/mocks/contacts';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

describe('rehber (roadmap 15)', () => {
  beforeEach(() => {
    resetContactsMock();
    signedInAs(USER.bugra);
  });

  it('lists the directory and opens a person with their manager', async () => {
    renderApp('/contacts');
    const user = userEvent.setup();
    const list = await screen.findByTestId('directory-list');
    await user.click(within(list).getByRole('button', { name: /Mert/ }));
    const panel = await screen.findByTestId('person-panel');
    expect((await within(panel).findAllByText('Backend Geliştirici')).length).toBeGreaterThan(0);
    expect(within(panel).getByRole('button', { name: /Ahmet Buğra Kösen/ })).toBeInTheDocument();
  });

  it('draws the org chart from the manager line', async () => {
    renderApp('/contacts/org-chart');
    const chart = await screen.findByTestId('org-chart');
    expect(within(chart).getByRole('button', { name: /Elif .* ekibini aç/ })).toBeInTheDocument();
    // Zeynep reports to Elif: closed until Elif opens.
    expect(within(chart).queryAllByRole('button', { name: /Zeynep/ })).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(within(chart).getByRole('button', { name: /Elif .* ekibini aç/ }));
    expect(within(chart).getAllByRole('button', { name: /Zeynep/ }).length).toBeGreaterThan(0);
  });

  it('adds an external contact with tags', async () => {
    renderApp('/contacts/people');
    const user = userEvent.setup();
    await screen.findByText('Henüz kişi yok');
    await user.click(screen.getByRole('button', { name: 'Yeni kişi' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni kişi' });
    await user.type(within(dialog).getByLabelText('Ad'), 'Ayşe');
    await user.type(within(dialog).getByLabelText('Soyad'), 'Yılmaz');
    await user.type(within(dialog).getByLabelText('Etiketler'), 'VIP{enter}');
    await user.click(within(dialog).getByRole('button', { name: 'Ekle' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('Ayşe Yılmaz')).toBeInTheDocument();
    expect(contactsMockState().contacts[0]).toMatchObject({ tags: ['VIP'], visibility: 'org' });
  });
});
