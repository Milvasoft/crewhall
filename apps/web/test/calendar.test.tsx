import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { calendarMockState, resetCalendarMock } from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { customRule, nthOfMonth, presetOf, presetRule } from '@/lib/calendar/recurrence';
import {
  datesOf,
  layoutDay,
  rangeInstants,
  rollEndDate,
  settleEndDate,
  shiftDate,
  viewDates,
} from '@/lib/calendar/time';
import { shifted } from '@/components/calendar/TimeGrid';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

describe('calendar view maths (roadmap 14)', () => {
  it('builds week and month ranges in the person zone', () => {
    expect(viewDates('week', '2026-10-22', 1)).toEqual({ first: '2026-10-19', end: '2026-10-26' });
    expect(viewDates('week', '2026-10-22', 0)).toEqual({ first: '2026-10-18', end: '2026-10-25' });
    expect(viewDates('month', '2026-10-22', 1)).toEqual({ first: '2026-09-28', end: '2026-11-09' });
    expect(shiftDate('month', '2026-01-31', 1)).toBe('2026-02-01');
    // Istanbul midnight is 21:00 UTC the day before.
    expect(rangeInstants('2026-10-19', '2026-10-26', 'Europe/Istanbul')).toEqual({
      from: '2026-10-18T21:00:00.000Z',
      to: '2026-10-25T21:00:00.000Z',
    });
  });

  it('places multi-day and midnight-ending events on the right days', () => {
    const tz = 'Europe/Istanbul';
    expect(
      datesOf({ allDay: false, start: '2026-10-22T20:00:00Z', end: '2026-10-22T21:00:00Z' }, tz),
    ).toEqual(['2026-10-22']);
    expect(datesOf({ allDay: true, start: '2026-10-22', end: '2026-10-25' }, tz)).toEqual([
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
    ]);
  });

  it('moves an end at or before the start to the next day', () => {
    expect(rollEndDate('2026-10-22', '23:30', '2026-10-22', '00:30')).toBe('2026-10-23');
    expect(rollEndDate('2026-10-22', '23:00', '2026-10-22', '00:00')).toBe('2026-10-23');
    expect(rollEndDate('2026-10-22', '10:00', '2026-10-22', '10:00')).toBe('2026-10-23');
    expect(rollEndDate('2026-10-22', '10:00', '2026-10-22', '11:00')).toBe('2026-10-22');
    // A two-day event stays as it is.
    expect(rollEndDate('2026-10-22', '10:00', '2026-10-24', '09:00')).toBe('2026-10-24');
    // Picking a later end again brings a rolled end back to the start's day.
    expect(settleEndDate('2026-10-22', '10:00', '2026-10-23', '11:00')).toBe('2026-10-22');
    expect(settleEndDate('2026-10-22', '23:30', '2026-10-23', '00:30')).toBe('2026-10-23');
  });

  it('lays overlapping events side by side', () => {
    const placed = layoutDay([
      { item: 'a', top: 600, bottom: 660 },
      { item: 'b', top: 630, bottom: 690 },
      { item: 'c', top: 700, bottom: 730 },
    ]);
    const by = Object.fromEntries(placed.map((p) => [p.item, p]));
    expect([by.a!.column, by.b!.column, by.a!.columns]).toEqual([0, 1, 2]);
    expect([by.c!.column, by.c!.columns]).toEqual([0, 1]);
  });

  it('moves a timed occurrence by wall-clock minutes and days', () => {
    const o = {
      start: '2026-10-22T07:00:00.000Z',
      end: '2026-10-22T08:00:00.000Z',
    } as Parameters<typeof shifted>[0];
    expect(shifted(o, 'move', 90, 1, 'Europe/Istanbul')).toEqual({
      start: '2026-10-23T08:30:00.000Z',
      end: '2026-10-23T09:30:00.000Z',
    });
    expect(shifted(o, 'resize', -60, 0, 'Europe/Istanbul').end).toBe('2026-10-22T07:15:00.000Z');
  });

  it('names repeat presets after the start date', () => {
    expect(nthOfMonth('2026-10-30')).toEqual({ n: -1, weekday: 5, day: 30 });
    expect(presetRule('monthlyNth', '2026-10-30')).toBe('FREQ=MONTHLY;BYDAY=-1FR');
    expect(presetOf('FREQ=WEEKLY;BYDAY=TH', '2026-10-22')).toBe('weekly');
    expect(presetOf('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', '2026-10-22')).toBe('custom');
    expect(
      customRule(
        {
          freq: 'WEEKLY',
          interval: 2,
          weekdays: [3, 1],
          end: 'count',
          count: 6,
          until: '2026-12-31',
        },
        false,
      ),
    ).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,WE');
  });
});

describe('calendar page (roadmap 14)', () => {
  beforeEach(() => {
    resetCalendarMock();
    signedInAs(USER.bugra);
  });

  it('shows the week with the calendars in the sidebar and the rail entry', async () => {
    renderApp('/calendar?view=week');
    expect(await screen.findByTestId('calendar-timegrid')).toBeInTheDocument();
    expect(await screen.findByText('Haftalık planlama')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Takvimim takvimini göster' })).toBeChecked();
    expect(screen.getAllByRole('link', { name: /Takvim/ }).length).toBeGreaterThan(0);
  });

  // The default slot is the next full hour in the calendar zone (Istanbul, UTC+3). Late in the
  // evening it crosses midnight: 23:00-00:00 must end the next day, not half an hour later.
  it.each([
    ['10:00', '2026-10-22T07:00:00Z', '2026-10-22T08:00:00.000Z', '2026-10-22T09:00:00.000Z'],
    ['22:30', '2026-10-22T19:30:00Z', '2026-10-22T20:00:00.000Z', '2026-10-22T21:00:00.000Z'],
    ['23:45', '2026-10-22T20:45:00Z', '2026-10-22T20:00:00.000Z', '2026-10-22T21:00:00.000Z'],
  ])(
    'creates an event with the kit pickers at %s (no native date input)',
    async (_t, now, start, end) => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(now) });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      renderApp('/calendar?view=agenda');
      const user = userEvent.setup();
      await screen.findByTestId('calendar-title');
      await user.click(screen.getByRole('button', { name: 'Yeni etkinlik' }));
      const dialog = await screen.findByRole('dialog', { name: 'Yeni etkinlik' });
      expect(dialog.querySelector('input[type="date"], input[type="time"]')).toBeNull();
      await user.type(within(dialog).getByLabelText('Başlık'), 'Müşteri demosu');
      await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const created = calendarMockState().events.find((e) => e.title === 'Müşteri demosu');
      expect(created).toMatchObject({
        allDay: false,
        timeZone: 'Europe/Istanbul',
        rrule: null,
        start,
        end,
      });
    },
  );

  it('adds a Crewhall meeting and offers to join it', async () => {
    renderApp('/calendar?view=agenda');
    const user = userEvent.setup();
    await screen.findByTestId('calendar-title');
    await user.click(screen.getByRole('button', { name: 'Yeni etkinlik' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni etkinlik' });
    await user.type(within(dialog).getByLabelText('Başlık'), 'Teklif görüşmesi');
    await user.click(within(dialog).getByRole('switch', { name: /Crewhall toplantısı ekle/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const created = calendarMockState().events.find((e) => e.title === 'Teklif görüşmesi')!;
    expect(created.meeting?.slug).toBeTruthy();
    await user.click(await screen.findByRole('button', { name: /Teklif görüşmesi/ }));
    const panel = await screen.findByTestId('calendar-event-panel');
    expect(await within(panel).findByRole('link', { name: /Toplantıya git/ })).toHaveAttribute(
      'href',
      `/meetings/room/${created.meeting!.slug}`,
    );
  });

  it('removes one occurrence of a series after asking the scope', async () => {
    renderApp('/calendar?view=agenda');
    const user = userEvent.setup();
    const rows = await screen.findAllByRole('button', { name: /Haftalık planlama/ });
    const before = rows.length;
    await user.click(rows[0]!);
    const panel = await screen.findByTestId('calendar-event-panel');
    await user.click(await within(panel).findByRole('button', { name: 'Sil' }));
    const scope = await screen.findByRole('dialog', { name: 'Tekrarlanan etkinliği sil' });
    expect(within(scope).getByRole('radio', { name: 'Yalnız bu etkinlik' })).toBeChecked();
    await user.click(within(scope).getByRole('button', { name: 'Sil' }));
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /Haftalık planlama/ }).length).toBe(before - 1),
    );
    expect(
      calendarMockState().events.find((e) => e.title === 'Haftalık planlama')!.exdates,
    ).toHaveLength(1);
  });

  it('hides a calendar from the views', async () => {
    renderApp('/calendar?view=agenda');
    const user = userEvent.setup();
    await screen.findAllByRole('button', { name: /Haftalık planlama/ });
    await user.click(screen.getByRole('checkbox', { name: 'Takvimim takvimini göster' }));
    await waitFor(() =>
      expect(screen.queryAllByRole('button', { name: /Haftalık planlama/ })).toHaveLength(0),
    );
    expect(await screen.findByText('Önümüzdeki 30 gün boş')).toBeInTheDocument();
  });

  it('offers Google once the admin sets up the OAuth client', async () => {
    const admin = renderApp('/admin/calendar');
    const user = userEvent.setup();
    await user.type(
      (await screen.findAllByLabelText('İstemci kimliği (Client ID)'))[0]!,
      'g-client',
    );
    await user.type(screen.getAllByLabelText('İstemci sırrı (Client secret)')[0]!, 'g-secret');
    await user.click(screen.getAllByRole('switch', { name: 'Kişiler bağlayabilsin' })[0]!);
    await user.click(screen.getAllByRole('button', { name: 'Kaydet' })[0]!);
    // Saved: the card starts over from the server, which now keeps the secret.
    expect(
      await screen.findByText('Kayıtlı sır korunur. Değiştirmek için yenisini yaz.'),
    ).toBeInTheDocument();
    admin.unmount();

    renderApp('/calendar?view=week');
    await user.click(await screen.findByRole('button', { name: 'Takvim ayarları' }));
    const dialog = await screen.findByRole('dialog', { name: 'Takvim ayarları' });
    const connect = await within(dialog).findByRole('link', { name: 'Google hesabı bağla' });
    expect(connect.getAttribute('href')).toMatch(/\/api\/calendar\/oauth\/google\/start$/);
    expect(within(dialog).queryByRole('link', { name: 'Microsoft hesabı bağla' })).toBeNull();
  });
});
