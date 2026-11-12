import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyReaction,
  getWindow,
  noteNewMessage,
  patchMessage,
  putMessages,
} from '@/lib/chat/cache';
import { clearTyping, noteTyping } from '@/lib/chat/stores';
import { type Message } from '@/lib/chat/types';
import { isReducedMotion, useArrivals, useBadgeMotion, useExit, useFlip } from '@/lib/motion';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

function setReduced(on: boolean) {
  document.documentElement.dataset.motion = on ? 'reduced' : 'full';
}

/** The account switch, as the app reads it on load (ThemeProvider owns data-motion). */
function reduceMotionInApp() {
  localStorage.setItem('crewhall.reducedMotion', '1');
}

afterEach(() => {
  delete document.documentElement.dataset.motion;
  vi.useRealTimers();
});

describe('motion helpers', () => {
  it('reads reduced motion from the account switch', () => {
    setReduced(true);
    expect(isReducedMotion()).toBe(true);
    setReduced(false);
    expect(isReducedMotion()).toBe(false);
  });

  it('marks only keys that arrive at the end while the list is on screen', () => {
    const { result, rerender } = renderHook(
      ({ keys, ready }: { keys: string[]; ready: boolean }) =>
        useArrivals(keys, { ready, tail: true, max: 3 }),
      { initialProps: { keys: [] as string[], ready: false } },
    );
    // First load: history never animates.
    rerender({ keys: ['a', 'b', 'c'], ready: true });
    expect(result.current.size).toBe(0);
    rerender({ keys: ['a', 'b', 'c', 'd'], ready: true });
    expect([...result.current]).toEqual(['d']);
    // An older page above stays still; "d" keeps its mark so its animation is not cut off.
    rerender({ keys: ['y', 'z', 'a', 'b', 'c', 'd'], ready: true });
    expect([...result.current]).toEqual(['d']);
    // A jump to another window (many new keys at once) does not count either.
    rerender({ keys: ['1', '2', '3', '4', '5'], ready: true });
    expect(result.current.has('1')).toBe(false);
  });

  it('keeps an element for its exit animation, but not with reduced motion', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ show }) => useExit(show, 160), {
      initialProps: { show: true },
    });
    rerender({ show: false });
    expect(result.current).toEqual({ mounted: true, state: 'closed' });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.mounted).toBe(false);

    // Reduced motion set before mount (the switch changes it while nothing is open).
    setReduced(true);
    const reduced = renderHook(({ show }) => useExit(show, 160), {
      initialProps: { show: true },
    });
    reduced.rerender({ show: false });
    expect(reduced.result.current.mounted).toBe(false);
  });

  it('pops a badge when it appears and bumps it when the number changes', () => {
    const { result, rerender } = renderHook(({ n }) => useBadgeMotion(n), {
      initialProps: { n: 2 },
    });
    expect(result.current.className).toBeUndefined();
    rerender({ n: 0 });
    rerender({ n: 1 });
    expect(result.current.className).toBe('animate-pop');
    const key = result.current.key;
    rerender({ n: 2 });
    expect(result.current.className).toBe('animate-bump');
    expect(result.current.key).toBe(key + 1);
  });

  it('slides moved rows from their old place (FLIP), and skips it with reduced motion', () => {
    // jsdom has no layout: rows are 40px tall in DOM order.
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const i = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
        const top = this.dataset.flipKey ? i * 40 : 0;
        return {
          top,
          bottom: top + 40,
          left: 0,
          right: 0,
          width: 0,
          height: 40,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      });
    const animate = vi.fn(() => ({ id: '', cancel: () => undefined }) as unknown as Animation);
    HTMLElement.prototype.animate = animate;
    HTMLElement.prototype.getAnimations = () => [];

    function List({ order }: { order: string[] }) {
      const ref = useRef<HTMLUListElement>(null);
      useFlip(ref);
      return (
        <ul ref={ref}>
          {order.map((k) => (
            <li key={k} data-flip-key={k}>
              {k}
            </li>
          ))}
        </ul>
      );
    }
    const view = render(<List order={['a', 'b', 'c']} />);
    view.rerender(<List order={['c', 'a', 'b']} />);
    // "c" moved up two rows: it starts 80px lower; "a" and "b" start 40px higher.
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(80px)' }, { transform: 'none' }],
      expect.anything(),
    );
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(-40px)' }, { transform: 'none' }],
      expect.anything(),
    );
    animate.mockClear();
    setReduced(true);
    view.rerender(<List order={['a', 'b', 'c']} />);
    expect(animate).not.toHaveBeenCalled();
    rect.mockRestore();
  });
});

// ---- Chat (design 04): only what arrives animates ----

async function openChat(): Promise<{ qc: QueryClient; last: Message }> {
  signedInAs(USER.bugra);
  const { queryClient } = renderApp(`/chat/c/${CONV.elif}`);
  await screen.findByRole('textbox', { name: 'Elif Yıldız sohbetine mesaj yaz' });
  await waitFor(() => expect(getWindow(queryClient, CONV.elif)?.items.length).toBeGreaterThan(0));
  const last = getWindow(queryClient, CONV.elif)!.items.at(-1)!;
  return { qc: queryClient, last };
}

function incoming(last: Message, text: string): Message {
  const author = getAuthor(last);
  return {
    ...last,
    id: `${last.id.slice(0, -4)}beef`,
    seq: last.seq + 1,
    text,
    author,
    clientMsgId: null,
    reactions: [],
    replyTo: null,
    attachments: [],
    card: null,
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    createdAt: new Date().toISOString(),
  };
}

function getAuthor(m: Message): Message['author'] {
  return {
    ...(m.author ?? { id: USER.elif, name: 'Elif Yıldız', imageUrl: null }),
    id: USER.elif,
    name: 'Elif Yıldız',
  } as Message['author'];
}

const rowOf = (text: string) => screen.getByText(text).closest('[data-seq]') as HTMLElement;

describe('chat motion', () => {
  it('slides in a message that arrives, never the history', async () => {
    const { qc, last } = await openChat();
    for (const row of document.querySelectorAll('[data-seq]')) {
      expect(row).not.toHaveAttribute('data-enter');
    }
    act(() => {
      putMessages(qc, CONV.elif, [incoming(last, 'Yeni geldi')]);
    });
    const row = await waitFor(() => rowOf('Yeni geldi'));
    expect(row).toHaveAttribute('data-enter', 'other');
    expect(row).toHaveClass('msg-in-other');
  });

  it('rises my own message from the composer', async () => {
    await openChat();
    const user = userEvent.setup();
    const box = screen.getByRole('textbox', { name: 'Elif Yıldız sohbetine mesaj yaz' });
    await user.type(box, 'Benden{Enter}');
    const row = await waitFor(() => {
      const r = rowOf('Benden');
      expect(r).toHaveAttribute('data-enter');
      return r;
    });
    // Sent quickly: it keeps rising; a slow send would only settle to full opacity.
    expect(['mine', 'settle']).toContain(row.dataset.enter);
  });

  it('adds no enter animation with reduced motion', async () => {
    reduceMotionInApp();
    const { qc, last } = await openChat();
    act(() => {
      putMessages(qc, CONV.elif, [incoming(last, 'Sessiz geldi')]);
    });
    const row = await waitFor(() => rowOf('Sessiz geldi'));
    expect(row).not.toHaveAttribute('data-enter');
  });

  it('fades the typing line in and out', async () => {
    await openChat();
    act(() => noteTyping(CONV.elif, USER.elif));
    const line = await screen.findByTestId('typing-line');
    expect(line).toHaveAttribute('data-state', 'open');
    expect(line).toHaveTextContent('Elif yazıyor');
    act(() => clearTyping(CONV.elif, USER.elif));
    // Still there while it fades, with the last name kept.
    expect(screen.getByTestId('typing-line')).toHaveAttribute('data-state', 'closed');
    expect(screen.getByTestId('typing-line')).toHaveTextContent('Elif');
    await waitFor(() => expect(screen.queryByTestId('typing-line')).toBeNull());
  });

  it('removes the typing line at once with reduced motion', async () => {
    reduceMotionInApp();
    await openChat();
    act(() => noteTyping(CONV.elif, USER.elif));
    await screen.findByTestId('typing-line');
    act(() => clearTyping(CONV.elif, USER.elif));
    expect(screen.queryByTestId('typing-line')).toBeNull();
  });

  it('pops a reaction someone adds', async () => {
    const { qc, last } = await openChat();
    act(() =>
      patchMessage(qc, CONV.elif, last.id, (m) =>
        applyReaction(m, '🎉', USER.elif, true, USER.bugra),
      ),
    );
    const row = document.getElementById(`msg-${last.seq}`)!;
    const chip = await within(row).findByRole('button', { pressed: false, name: /🎉/ });
    expect(chip).toHaveAttribute('data-fresh');
    expect(chip).toHaveClass('animate-pop');
  });

  it('pops the unread badge of a chat that gets a message', async () => {
    const { qc } = await openChat();
    const nav = screen.getByRole('complementary', { name: 'Sohbet' });
    const target = within(nav).getAllByRole('link', { name: /Zeynep/ })[0]!;
    const convId = target.getAttribute('href')!.split('/').at(-1)!;
    const before = target.querySelector('[aria-label*="okunmamış"]');
    act(() => {
      noteNewMessage(
        qc,
        {
          ...incoming(getWindow(qc, CONV.elif)!.items.at(-1)!, 'x'),
          conversationId: convId,
          seq: 10_000,
        },
        USER.bugra,
        { reading: false, excerpt: 'x' },
      );
    });
    const badge = await waitFor(() => {
      const b = nav.querySelector(`a[href$="${convId}"] [aria-label*="okunmamış"]`);
      expect(b).not.toBeNull();
      return b!;
    });
    expect(badge).toHaveClass(before ? 'animate-bump' : 'animate-pop');
  });
});

describe('double click quick reaction', () => {
  async function bubbleOf(text: string) {
    await openChat();
    const row = rowOf(text);
    const quick = within(row).getAllByRole('button', { name: /tepkisi ver$/ })[0]!;
    const emoji = quick.getAttribute('aria-label')!.replace(/ tepkisi ver$/, '');
    const bubble = row.querySelector<HTMLElement>('[data-quick-react]')!;
    const mineChip = () =>
      within(row)
        .queryAllByRole('button', { pressed: true })
        .find((b) => b.textContent?.includes(emoji));
    return { row, bubble, emoji, mineChip };
  }

  it('adds the first quick reaction, and a second double click takes it back', async () => {
    const { bubble, mineChip } = await bubbleOf('İyi hafta sonları 👋');
    const user = userEvent.setup();
    expect(mineChip()).toBeUndefined();
    await user.dblClick(bubble);
    await waitFor(() => expect(mineChip()).toBeDefined());
    await user.dblClick(bubble);
    await waitFor(() => expect(mineChip()).toBeUndefined());
  });

  it('does nothing while text in the message is selected', async () => {
    const { bubble, mineChip } = await bubbleOf('İyi hafta sonları 👋');
    const range = document.createRange();
    range.selectNodeContents(bubble.querySelector('p')!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.dblClick(bubble.querySelector('p')!);
    await new Promise((r) => setTimeout(r, 50));
    expect(mineChip()).toBeUndefined();
    sel.removeAllRanges();
  });

  it('keeps its hands off links, buttons and mentions inside the bubble', async () => {
    const { bubble, mineChip } = await bubbleOf('İyi hafta sonları 👋');
    const link = document.createElement('a');
    link.href = 'https://example.com';
    link.textContent = 'bağlantı';
    bubble.querySelector('p')!.append(link);
    fireEvent.dblClick(link);
    await new Promise((r) => setTimeout(r, 50));
    expect(mineChip()).toBeUndefined();
    link.remove();
  });
});
