import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMockEvent, addMockVersion, resetCalendarMock } from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Mirrored events: the versions lost to "the last writer wins" (sonraki-isler). */
describe('event history', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T09:00:00Z') });
    resetCalendarMock();
    signedInAs(USER.bugra);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const mirrored = (title: string) => {
    const e = addMockEvent({
      ownerId: USER.bugra,
      title,
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
    });
    e.external = {
      provider: 'google',
      joinUrl: null,
      webUrl: null,
      organizer: null,
      occurrenceOnly: false,
      readOnly: false,
    };
    return e;
  };

  it('lists overwritten versions in the event panel', async () => {
    const e = mirrored('Planlama');
    addMockVersion(e.id, {
      id: '0190f0a0-0000-7000-8000-000000000c01',
      overwritten: 'provider',
      replacedAt: '2026-10-20T10:00:00.000Z',
      title: 'Google başlığı',
      description: 'Eski not',
      location: 'Oda 1',
      allDay: false,
      start: '2026-10-21T10:00:00.000Z',
      end: '2026-10-21T11:00:00.000Z',
      attendees: [{ email: 'ayse@example.com', name: 'Ayşe' }],
    });
    addMockVersion(e.id, {
      id: '0190f0a0-0000-7000-8000-000000000c02',
      overwritten: 'crewhall',
      replacedAt: '2026-10-21T10:00:00.000Z',
      title: 'Crewhall başlığı',
      description: null,
      location: null,
      allDay: false,
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
      attendees: [],
    });
    renderApp('/calendar?view=week&date=2026-10-22');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Planlama,/ }));
    const versions = await screen.findByTestId('event-versions');
    expect(within(versions).getByText('Önceki sürümler (2)')).toBeInTheDocument();
    const rows = within(versions).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Crewhall başlığı');
    expect(rows[0]).toHaveTextContent("Crewhall'da yazılan sürüm");
    expect(rows[1]).toHaveTextContent('Google başlığı');
    expect(rows[1]).toHaveTextContent('Google');
    expect(rows[1]).toHaveTextContent('Eski not');
    expect(rows[1]).toHaveTextContent('Ayşe');
  });

  it('shows nothing until a version was overwritten', async () => {
    mirrored('Sakin toplantı');
    renderApp('/calendar?view=week&date=2026-10-22');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Sakin toplantı,/ }));
    const panel = await screen.findByTestId('calendar-event-panel');
    // The event has loaded (its edit button shows), so the versions were asked for too.
    await within(panel).findByRole('button', { name: 'Düzenle' });
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId('event-versions')).toBeNull();
  });
});
