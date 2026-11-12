import { type CalendarOccurrence } from '@crewhall/shared';
import { Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  dropTarget,
  resizeTarget,
  shiftBy,
  shiftDays,
  zoneAt,
  type GridGeometry,
} from '@/lib/calendar/drag';
import { addMockEvent, calendarMockState, resetCalendarMock } from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { server } from './support/server';
import { signedInAs } from './support/session';

const TZ = 'Europe/Istanbul';

const occ = (over: Partial<CalendarOccurrence>): CalendarOccurrence => ({
  key: 'event:x:1',
  source: 'event',
  sourceId: '0190f0a0-0000-7000-8000-000000000999',
  seriesId: null,
  recurrenceId: null,
  calendarId: null,
  color: 's1',
  title: 'Demo',
  hidden: false,
  location: null,
  allDay: false,
  start: '2026-10-21T11:00:00.000Z',
  end: '2026-10-21T12:00:00.000Z',
  status: 'confirmed',
  busy: true,
  recurring: false,
  myResponse: null,
  attendeeCount: 0,
  editable: true,
  url: null,
  flag: null,
  ...over,
});

const WEEK = [
  '2026-10-19',
  '2026-10-20',
  '2026-10-21',
  '2026-10-22',
  '2026-10-23',
  '2026-10-24',
  '2026-10-25',
];
const GEO: GridGeometry = {
  dates: WEEK,
  columns: { left: 100, width: 700, top: 300 },
  allDay: { top: 200, bottom: 240 },
};

describe('drop targets (roadmap 14, drag and drop)', () => {
  it('finds the day column, the minute and the all-day row under a point', () => {
    expect(zoneAt(350, 300 + 10 * 48, GEO)).toEqual({
      kind: 'timed',
      date: '2026-10-21',
      minute: 600,
    });
    expect(zoneAt(550, 220, GEO)).toEqual({ kind: 'allday', date: '2026-10-23' });
    expect(zoneAt(50, 500, GEO)).toBeNull();
  });

  it('moves a timed event by 15-minute steps, keeping where it was held', () => {
    // Held 20 minutes below its start, dropped with the pointer at 16:07 on Thursday.
    const t = dropTarget(
      occ({}),
      { kind: 'timed', date: '2026-10-22', minute: 16 * 60 + 7 },
      { minutes: 20, date: '2026-10-21' },
      TZ,
    );
    expect(t).toEqual({
      allDay: false,
      start: '2026-10-22T12:45:00.000Z',
      end: '2026-10-22T13:45:00.000Z',
    });
  });

  it('switches between the all-day row and the grid', () => {
    expect(
      dropTarget(
        occ({}),
        { kind: 'allday', date: '2026-10-23' },
        { minutes: 0, date: '2026-10-21' },
        TZ,
      ),
    ).toEqual({
      allDay: true,
      start: '2026-10-23',
      end: '2026-10-24',
    });
    const allDay = occ({ allDay: true, start: '2026-10-23', end: '2026-10-24' });
    expect(
      dropTarget(
        allDay,
        { kind: 'timed', date: '2026-10-21', minute: 9 * 60 + 53 },
        { minutes: 0, date: '2026-10-23' },
        TZ,
      ),
    ).toEqual({
      allDay: false,
      start: '2026-10-21T07:00:00.000Z',
      end: '2026-10-21T08:00:00.000Z',
    });
    // A card's due date stays a day wherever it is dropped.
    const card = occ({ source: 'card', allDay: true, start: '2026-10-23', end: '2026-10-24' });
    expect(
      dropTarget(
        card,
        { kind: 'timed', date: '2026-10-20', minute: 600 },
        { minutes: 0, date: '2026-10-23' },
        TZ,
      ),
    ).toEqual({
      allDay: true,
      start: '2026-10-20',
      end: '2026-10-21',
    });
    expect(
      dropTarget(
        allDay,
        { kind: 'allday', date: '2026-10-23' },
        { minutes: 0, date: '2026-10-23' },
        TZ,
      ),
    ).toBeNull();
  });

  it('resizes to the nearest 15 minutes and never below 15 minutes', () => {
    expect(resizeTarget(occ({}), 53)?.end).toBe('2026-10-21T13:00:00.000Z');
    expect(resizeTarget(occ({}), -500)?.end).toBe('2026-10-21T11:15:00.000Z');
  });

  it('moves whole days at the same wall-clock time, across DST too', () => {
    // Berlin 09:00 on Saturday (UTC+1) → Monday 09:00 (UTC+2).
    const berlin = occ({ start: '2026-03-28T08:00:00.000Z', end: '2026-03-28T09:00:00.000Z' });
    expect(shiftDays(berlin, 2, 'Europe/Berlin')).toEqual({
      allDay: false,
      start: '2026-03-30T07:00:00.000Z',
      end: '2026-03-30T08:00:00.000Z',
    });
    expect(shiftBy(occ({}), { minutes: -15, days: 1 }, TZ)?.start).toBe('2026-10-22T10:45:00.000Z');
  });
});

/** jsdom has no layout: the grid gets the geometry of a 700 px week (or a 700×600 month). */
function stubLayout() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const box = (left: number, top: number, width: number, height: number) =>
      ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    const id = this.getAttribute('data-testid');
    if (id === 'calendar-columns') return box(100, 300, 700, 24 * 48);
    if (id === 'calendar-allday') return box(44, 200, 756, 40);
    if (id === 'calendar-month-grid') return box(0, 0, 700, 600);
    return box(0, 0, 80, 20);
  };
  onTestFinished(() => {
    Element.prototype.getBoundingClientRect = original;
  });
}

/** A mouse drag through dnd-kit's mouse sensor (past its 4 px activation distance). */
function mouseDrag(el: Element, from: { x: number; y: number }, to: { x: number; y: number }) {
  fireEvent.mouseDown(el, { clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.mouseMove(document, { clientX: from.x + 6, clientY: from.y + 6 });
  fireEvent.mouseMove(document, { clientX: to.x, clientY: to.y });
  fireEvent.mouseUp(document, { clientX: to.x, clientY: to.y });
}

const stored = (title: string) =>
  calendarMockState().events.find((e) => e.title === title && !e.parentId)!;

/**
 * The sonner toast with this text (the live region repeats it for screen readers). Toasts of an
 * earlier test may still arrive: match the text precisely.
 */
function toast(text: RegExp) {
  return waitFor(() => {
    const note = screen
      .getAllByText(text)
      .map((e) => e.closest('[data-sonner-toast]'))
      .find((e) => e instanceof HTMLElement);
    if (!(note instanceof HTMLElement)) throw new Error('toast not found');
    return note;
  });
}

describe('calendar drag and drop (roadmap 14)', () => {
  beforeEach(() => {
    // Thursday 22 October 2026, 12:00 in Istanbul; the mock seeds its week around it.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T09:00:00Z') });
    resetCalendarMock();
    signedInAs(USER.bugra);
    render(<Toaster />);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drags an all-day event into the grid as a one-hour event, with a ghost on the way', async () => {
    stubLayout();
    renderApp('/calendar?view=week&date=2026-10-22');
    const izin = await screen.findByRole('button', { name: /^İzin,/ });
    fireEvent.mouseDown(izin, { clientX: 550, clientY: 220, button: 0 });
    fireEvent.mouseMove(document, { clientX: 556, clientY: 226 });
    fireEvent.mouseMove(document, { clientX: 350, clientY: 300 + 10 * 48 + 5 });
    expect(await screen.findByTestId('calendar-ghost')).toHaveTextContent('10:00–11:00');
    fireEvent.mouseUp(document, { clientX: 350, clientY: 300 + 10 * 48 + 5 });
    await waitFor(() =>
      expect(stored('İzin')).toMatchObject({
        allDay: false,
        start: '2026-10-21T07:00:00.000Z',
        end: '2026-10-21T08:00:00.000Z',
      }),
    );
  });

  it('drags a timed event into the all-day row and resizes another from its bottom edge', async () => {
    stubLayout();
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Demo',
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
    });
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Uzat',
      start: '2026-10-22T12:00:00.000Z',
      end: '2026-10-22T13:00:00.000Z',
    });
    renderApp('/calendar?view=week&date=2026-10-22');
    const demo = await screen.findByRole('button', { name: /^Demo,/ });
    mouseDrag(demo, { x: 350, y: 300 + 14 * 48 + 10 }, { x: 650, y: 220 });
    await waitFor(() =>
      expect(stored('Demo')).toMatchObject({
        allDay: true,
        start: '2026-10-24',
        end: '2026-10-25',
      }),
    );

    const uzat = await screen.findByRole('button', { name: /^Uzat,/ });
    const handle = within(uzat).getByLabelText('Süreyi değiştir');
    mouseDrag(handle, { x: 450, y: 300 + 16 * 48 - 2 }, { x: 450, y: 300 + 17 * 48 - 2 });
    await waitFor(() => expect(stored('Uzat').end).toBe('2026-10-22T14:00:00.000Z'));
  });

  it('drags a chip to another day in the month and keeps its time', async () => {
    stubLayout();
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Ay demosu',
      start: '2026-10-22T11:00:00.000Z',
      end: '2026-10-22T12:00:00.000Z',
    });
    renderApp('/calendar?view=month&date=2026-10-22');
    const chip = await screen.findByRole('button', { name: 'Ay demosu' });
    // 28 Sep starts the grid: 22 Oct is row 3, column 3; 29 Oct is row 4, column 3.
    mouseDrag(chip, { x: 350, y: 350 }, { x: 350, y: 450 });
    await waitFor(() => expect(stored('Ay demosu').start).toBe('2026-10-29T11:00:00.000Z'));
  });

  it('moves with Alt + arrows, announces it and undoes from the toast', async () => {
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Demo',
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
    });
    renderApp('/calendar?view=week&date=2026-10-22');
    const demo = await screen.findByRole('button', { name: /^Demo,/ });
    demo.focus();
    fireEvent.keyDown(demo, { key: 'ArrowDown', altKey: true });
    fireEvent.keyDown(screen.getByRole('button', { name: /^Demo,/ }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(screen.getByTestId('calendar-live')).toHaveTextContent('14:30–15:30');
    await waitFor(() => expect(stored('Demo').start).toBe('2026-10-21T11:30:00.000Z'));
    const note = await toast(/Demo taşındı: .* 14:30/);
    fireEvent.click(within(note).getByRole('button', { name: 'Geri al' }));
    await waitFor(() => expect(stored('Demo').start).toBe('2026-10-21T11:00:00.000Z'));
  });

  it('asks which occurrences of a series move', async () => {
    renderApp('/calendar?view=week&date=2026-10-22');
    const weekly = await screen.findByRole('button', { name: /^Haftalık planlama,/ });
    fireEvent.keyDown(weekly, { key: 'ArrowRight', altKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Tekrarlanan etkinliği değiştir' });
    expect(within(dialog).getByRole('radio', { name: 'Yalnız bu etkinlik' })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Taşı' }));
    await waitFor(() => {
      const override = calendarMockState().events.find(
        (e) => e.parentId && e.title === 'Haftalık planlama',
      );
      expect(override?.start).toBe('2026-10-20T07:00:00.000Z');
    });
  });

  it('offers to notify guests and sends the choice', async () => {
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Müşteri',
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
      inviteIds: [USER.mert],
    });
    const sent: unknown[] = [];
    server.use(
      http.patch('*/api/v1/calendar/events/:eventId', async ({ request }) => {
        sent.push(await request.clone().json());
        return undefined;
      }),
    );
    renderApp('/calendar?view=week&date=2026-10-22');
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Müşteri,/ }), {
      key: 'ArrowDown',
      altKey: true,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Etkinliği taşı' });
    const notify = within(dialog).getByRole('switch', { name: /Katılımcılara bildir/ });
    expect(notify).toBeChecked();
    fireEvent.click(notify);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Taşı' }));
    await waitFor(() =>
      expect(sent).toEqual([expect.objectContaining({ notify: false, scope: 'all' })]),
    );
  });

  it("does not move other people's events", async () => {
    addMockEvent({
      ownerId: USER.mert,
      title: 'Mert davet etti',
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
      inviteIds: [USER.bugra],
    });
    renderApp('/calendar?view=week&date=2026-10-22');
    const chip = await screen.findByRole('button', { name: /^Mert davet etti,/ });
    expect(chip).not.toHaveAttribute('aria-description');
    fireEvent.keyDown(chip, { key: 'ArrowDown', altKey: true });
    await new Promise((r) => setTimeout(r, 900));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(stored('Mert davet etti').start).toBe('2026-10-21T11:00:00.000Z');
  });

  it('puts the event back and shows the error when the server refuses', async () => {
    addMockEvent({
      ownerId: USER.bugra,
      title: 'Demo',
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T12:00:00.000Z',
    });
    server.use(
      http.patch('*/api/v1/calendar/events/:eventId', () =>
        HttpResponse.json({ code: 'calendar_read_only', message: 'read only' }, { status: 403 }),
      ),
    );
    renderApp('/calendar?view=week&date=2026-10-22');
    fireEvent.keyDown(await screen.findByRole('button', { name: /^Demo,/ }), {
      key: 'ArrowDown',
      altKey: true,
    });
    expect(await screen.findByText('Bu takvimi yalnız görüntüleyebilirsin.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Demo,/ })).toHaveAccessibleName(/14:00–15:00/),
    );
    expect(stored('Demo').start).toBe('2026-10-21T11:00:00.000Z');
  });
});
