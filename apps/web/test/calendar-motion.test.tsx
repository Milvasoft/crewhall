import { type CalendarOccurrence } from '@crewhall/shared';
import { Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { api } from '@/lib/api';
import {
  edgeDirection,
  enterMotion,
  springFrames,
  swipeLock,
  swipeOutcome,
  velocityOf,
  WHEEL_IDLE,
  wheelStep,
} from '@/lib/calendar/swipe';
import { addMockOccurrence, calendarMockState, resetCalendarMock } from '@/mocks/calendar';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

describe('swipe and spring (roadmap 14, motion)', () => {
  it('reads a gesture as a swipe only when it is mostly horizontal', () => {
    expect(swipeLock(5, 2)).toBeNull();
    expect(swipeLock(20, 4)).toBe('swipe');
    expect(swipeLock(6, 20)).toBe('other');
  });

  it('changes the period past a quarter of the width or on a flick, else springs back', () => {
    expect(swipeOutcome(-200, 0, 700)).toBe(1);
    expect(swipeOutcome(200, 0, 700)).toBe(-1);
    expect(swipeOutcome(-150, -0.1, 700)).toBe(0);
    // A quick flick to the right: previous period.
    expect(swipeOutcome(60, 0.8, 700)).toBe(-1);
    // Flicked back against the pull, or too short to count.
    expect(swipeOutcome(60, -0.8, 700)).toBe(0);
    expect(swipeOutcome(-10, -2, 700)).toBe(0);
  });

  it('measures the velocity over the last 100 ms', () => {
    expect(
      velocityOf([
        { t: 0, x: 0 },
        { t: 200, x: -20 },
        { t: 250, x: -40 },
        { t: 300, x: -100 },
      ]),
    ).toBeCloseTo(-0.8);
    expect(velocityOf([])).toBe(0);
  });

  it('springs to the target, overshooting a little when lightly damped', () => {
    const soft = springFrames(100, 0, { stiffness: 300, damping: 12 });
    expect(soft.values[0]).toBe(100);
    expect(soft.values.at(-1)).toBe(0);
    expect(Math.min(...soft.values)).toBeLessThan(0);
    expect(soft.duration).toBeLessThanOrEqual(2000);
    const firm = springFrames(100, 0, { stiffness: 300, damping: 40 });
    expect(Math.min(...firm.values)).toBeGreaterThanOrEqual(-0.5);
    expect(firm.duration).toBe(Math.round(((firm.values.length - 1) * 1000) / 60));
  });

  it('finds the edges that move a dragged event to the next period', () => {
    const rect = { left: 100, width: 700 };
    expect(edgeDirection(110, rect)).toBe(-1);
    expect(edgeDirection(790, rect)).toBe(1);
    expect(edgeDirection(450, rect)).toBe(0);
    expect(edgeDirection(105, { left: 100, width: 100 })).toBe(0);
  });

  it('steps once per trackpad swipe and swallows its momentum', () => {
    let r = wheelStep(WHEEL_IDLE, { deltaX: 100, deltaY: 4 }, 700);
    expect(r).toEqual({ state: { dx: -100, locked: false }, step: 0 });
    r = wheelStep(r.state, { deltaX: 90, deltaY: 0 }, 700);
    expect(r).toEqual({ state: { dx: 0, locked: true }, step: 1 });
    expect(wheelStep(r.state, { deltaX: 300, deltaY: 0 }, 700).step).toBe(0);
    // Vertical scrolling is not a swipe.
    expect(wheelStep(WHEEL_IDLE, { deltaX: 10, deltaY: 40 }, 700).state).toBe(WHEEL_IDLE);
  });

  it('slides periods, zooms views and fades to the agenda', () => {
    const week = { view: 'week' as const, first: '2026-10-19' };
    expect(enterMotion(week, { view: 'week', first: '2026-10-26' })).toEqual({
      kind: 'slide',
      dir: 1,
    });
    expect(enterMotion(week, { view: 'week', first: '2026-10-12' })).toEqual({
      kind: 'slide',
      dir: -1,
    });
    expect(enterMotion(week, { view: 'day', first: '2026-10-22' })).toEqual({
      kind: 'zoom',
      dir: 1,
    });
    expect(enterMotion(week, { view: 'month', first: '2026-09-28' })).toEqual({
      kind: 'zoom',
      dir: -1,
    });
    expect(enterMotion(week, { view: 'agenda', first: '2026-10-22' })).toEqual({ kind: 'fade' });
    expect(enterMotion(week, week)).toBeNull();
  });
});

type AnimateCall = { el: Element; frames: Keyframe[] };

/** jsdom has no Web Animations: record what the calendar asks for. */
function recordAnimations() {
  const calls: AnimateCall[] = [];
  const had = Object.prototype.hasOwnProperty.call(Element.prototype, 'animate');
  const original = Element.prototype.animate;
  Element.prototype.animate = function (
    this: Element,
    frames: Keyframe[] | PropertyIndexedKeyframes | null,
  ) {
    calls.push({ el: this, frames: Array.isArray(frames) ? frames : [] });
    return {
      finished: Promise.resolve(),
      cancel: () => undefined,
      id: '',
    } as unknown as Animation;
  };
  onTestFinished(() => {
    if (had) Element.prototype.animate = original;
    else delete (Element.prototype as Partial<Element>).animate;
  });
  return calls;
}

/** The track inside the stage: the element that slides and springs. */
const track = () => screen.getByTestId('calendar-stage').firstElementChild as HTMLElement;
const slidesOf = (calls: AnimateCall[]) =>
  calls
    .filter((c) => c.el === track())
    .map((c) => String(c.frames[0]?.transform ?? c.frames[0]?.opacity ?? ''));
const offset = (transform: string) => Number(/translate3d\((-?[\d.]+)px/.exec(transform)?.[1]);

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
    if (id === 'calendar-stage') return box(44, 150, 756, 1300);
    if (id === 'calendar-columns') return box(100, 300, 700, 24 * 48);
    if (id === 'calendar-allday') return box(44, 200, 756, 40);
    if (id === 'calendar-month-grid') return box(0, 0, 700, 600);
    return box(0, 0, 80, 20);
  };
  onTestFinished(() => {
    Element.prototype.getBoundingClientRect = original;
  });
}

/** The OS setting (the account switch is applied by the app and would be overwritten here). */
function reduceMotion() {
  const original = window.matchMedia;
  window.matchMedia = (query: string) =>
    ({
      ...original(query),
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
    }) as MediaQueryList;
  onTestFinished(() => {
    window.matchMedia = original;
  });
}

/** A horizontal mouse drag on an empty part of the header. */
function swipeHeader(dx: number) {
  const header = screen.getByTestId('calendar-timegrid').firstElementChild!;
  const at = (x: number) => ({ clientX: x, clientY: 160, pointerId: 3, pointerType: 'mouse' });
  fireEvent.pointerDown(header, { ...at(500), button: 0, isPrimary: true });
  for (let i = 1; i <= 5; i++) fireEvent.pointerMove(window, at(500 + (dx * i) / 5));
  fireEvent.pointerUp(window, at(500 + dx));
}

const title = () => screen.getByTestId('calendar-title').textContent;

describe('calendar motion (roadmap 14)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-22T09:00:00Z') });
    resetCalendarMock();
    signedInAs(USER.bugra);
    render(<Toaster />);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('slides the next week in from the right and the previous one from the left', async () => {
    const calls = recordAnimations();
    renderApp('/calendar?view=week&date=2026-10-22');
    await screen.findByRole('button', { name: /^Haftalık planlama,/ });
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki' }));
    await waitFor(() => expect(title()).toBe('26 Eki – 1 Kas 2026'));
    expect(offset(slidesOf(calls).at(-1)!)).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Önceki' }));
    await waitFor(() => expect(title()).toBe('19 Eki – 25 Eki 2026'));
    expect(offset(slidesOf(calls).at(-1)!)).toBeLessThan(0);
    // The events of the week rise in one after another.
    const weekly = await screen.findByRole('button', { name: /^Haftalık planlama,/ });
    expect(weekly).toHaveClass('cal-enter');
    // A view change zooms instead.
    fireEvent.click(screen.getByRole('radio', { name: 'Gün' }));
    await waitFor(() => expect(slidesOf(calls).at(-1)).toBe('scale(0.94)'));
  });

  it('follows a swipe and moves a week, or springs back from a short one', async () => {
    stubLayout();
    const calls = recordAnimations();
    renderApp('/calendar?view=week&date=2026-10-22');
    await screen.findByRole('button', { name: /^Haftalık planlama,/ });
    // Short: back to place with a spring.
    swipeHeader(-15);
    expect(title()).toBe('19 Eki – 25 Eki 2026');
    expect(slidesOf(calls).at(-1)).toBe('translate3d(-15px, 0, 0)');
    // Past a quarter of the width to the left: the next week.
    swipeHeader(-260);
    await waitFor(() => expect(title()).toBe('26 Eki – 1 Kas 2026'));
    expect(track().style.transform).toBe('');
  });

  it('turns a trackpad swipe into one step', async () => {
    stubLayout();
    recordAnimations();
    renderApp('/calendar?view=week&date=2026-10-22');
    await screen.findByRole('button', { name: /^Haftalık planlama,/ });
    const stage = screen.getByTestId('calendar-stage');
    for (let i = 0; i < 6; i++) fireEvent.wheel(stage, { deltaX: -60, deltaY: 0 });
    await waitFor(() => expect(title()).toBe('12 Eki – 18 Eki 2026'));
    // Momentum after the step does not move another week.
    await new Promise((r) => setTimeout(r, 300));
    expect(title()).toBe('12 Eki – 18 Eki 2026');
  });

  it('with reduced motion swipes and buttons change the period at once, without animation', async () => {
    stubLayout();
    reduceMotion();
    const calls = recordAnimations();
    renderApp('/calendar?view=week&date=2026-10-22');
    await screen.findByRole('button', { name: /^Haftalık planlama,/ });
    fireEvent.click(screen.getByRole('button', { name: 'Sonraki' }));
    await waitFor(() => expect(title()).toBe('26 Eki – 1 Kas 2026'));
    const header = screen.getByTestId('calendar-timegrid').firstElementChild!;
    fireEvent.pointerDown(header, {
      clientX: 500,
      clientY: 160,
      pointerId: 4,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
    });
    fireEvent.pointerMove(window, { clientX: 400, clientY: 160, pointerId: 4 });
    // The view does not follow the finger…
    expect(track().style.transform).toBe('');
    fireEvent.pointerMove(window, { clientX: 200, clientY: 160, pointerId: 4 });
    fireEvent.pointerUp(window, { clientX: 200, clientY: 160, pointerId: 4 });
    // …and the step comes right away, with nothing animated.
    await waitFor(() => expect(title()).toBe('2 Kas – 8 Kas 2026'));
    expect(calls).toEqual([]);
  });

  it('moves to the next week while an event is held at the right edge', async () => {
    stubLayout();
    recordAnimations();
    renderApp('/calendar?view=week&date=2026-10-22');
    const izin = await screen.findByRole('button', { name: /^İzin,/ });
    fireEvent.mouseDown(izin, { clientX: 550, clientY: 220, button: 0 });
    fireEvent.mouseMove(document, { clientX: 556, clientY: 220 });
    fireEvent.mouseMove(document, { clientX: 795, clientY: 220 });
    await waitFor(() => expect(title()).toBe('26 Eki – 1 Kas 2026'), { timeout: 2000 });
    // Off the edge: Monday of the new week, in the all-day row.
    fireEvent.mouseMove(document, { clientX: 150, clientY: 220 });
    expect(await screen.findByTestId('calendar-ghost')).toHaveTextContent('İzin');
    fireEvent.mouseUp(document, { clientX: 150, clientY: 220 });
    await waitFor(() =>
      expect(calendarMockState().events.find((e) => e.title === 'İzin')).toMatchObject({
        start: '2026-10-26',
        end: '2026-10-27',
      }),
    );
    expect(title()).toBe('26 Eki – 1 Kas 2026');
  });

  it('moves a one-off meeting through updateMeeting and cancels it from the panel', async () => {
    const m = await api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Bütçe görüşmesi',
        startsAt: '2026-10-21T11:00:00.000Z',
        durationMinutes: 45,
        recurrence: 'none',
        invitees: { userIds: [], emails: [] },
        settings: { guestsAllowed: false, lobby: true, autoRecord: false },
      },
    });
    const occ: CalendarOccurrence = {
      key: `meeting:${m.id}:once`,
      source: 'meeting',
      sourceId: m.id,
      seriesId: null,
      recurrenceId: null,
      calendarId: null,
      color: 's2',
      title: m.title,
      hidden: false,
      location: null,
      allDay: false,
      start: '2026-10-21T11:00:00.000Z',
      end: '2026-10-21T11:45:00.000Z',
      status: 'confirmed',
      busy: true,
      recurring: false,
      myResponse: null,
      attendeeCount: 0,
      editable: true,
      url: `/meetings/room/${m.slug}`,
      flag: null,
    };
    addMockOccurrence(occ);
    renderApp('/calendar?view=week&date=2026-10-22');
    const chip = await screen.findByRole('button', { name: /^Bütçe görüşmesi,/ });
    // Alt + ↓: 15 minutes later, saved as the meeting's new time (no dialog for a meeting).
    fireEvent.keyDown(chip, { key: 'ArrowDown', altKey: true });
    await waitFor(
      async () =>
        expect(await api.call('getMeeting', { params: { meetingId: m.id } })).toMatchObject({
          startsAt: '2026-10-21T11:15:00.000Z',
          durationMinutes: 45,
        }),
      { timeout: 2000 },
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Bütçe görüşmesi,/ }));
    const panel = await screen.findByTestId('calendar-event-panel');
    fireEvent.click(await within(panel).findByRole('button', { name: 'İptal et' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bütçe görüşmesi iptal edilsin mi?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'İptal et' }));
    expect(await screen.findByText('Toplantı iptal edildi')).toBeInTheDocument();
    const after = await api.call('getMeeting', { params: { meetingId: m.id } });
    expect(after.cancelledAt).not.toBeNull();
  });
});
