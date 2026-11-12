import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/**
 * "Okunmadı olarak işaretle" sticks: the open chat does not read it back, the list shows it
 * unread even when the last message is mine, and opening the chat again reads it.
 */

const myRow = () =>
  chatState(db()).members.find(
    (m) => m.conversationId === CONV.milvaion && m.userId === USER.bugra,
  )!;
const listRow = () =>
  within(screen.getByRole('complementary', { name: 'Sohbet' })).getAllByRole('link', {
    name: /Milvaion Ekibi/,
  })[0]!;

// jsdom has no layout: report every observed message as on screen, so the read path runs.
const realObserver = globalThis.IntersectionObserver;
class SeeingEverything {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() =>
      this.cb(
        [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      ),
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
beforeEach(() => {
  globalThis.IntersectionObserver = SeeingEverything as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  globalThis.IntersectionObserver = realObserver;
});

describe('mark as unread', () => {
  it('stays unread in the open chat, even after my own last message, until reopened', async () => {
    signedInAs(USER.bugra);
    const { router } = renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.clear(box);
    await user.type(box, 'benim son mesajım{Enter}');
    const mine = await screen.findByText('benim son mesajım');
    await waitFor(() => expect(myRow().markedUnread ?? false).toBe(false));

    // From my own (last) message's menu.
    const row = mine.closest('[data-seq]') as HTMLElement;
    await user.hover(row);
    await user.click(within(row).getByRole('button', { name: 'Diğer eylemler' }));
    await user.click(await screen.findByRole('menuitem', { name: /Okunmadı olarak işaretle/ }));
    await waitFor(() => expect(myRow().markedUnread).toBe(true));
    expect(await within(listRow()).findByLabelText('1 okunmamış mesaj')).toBeInTheDocument();

    // Past the 1 s read delay, still unread while the chat is on screen, even when the
    // messages are reported again (coming back to the tab).
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 1600));
    expect(myRow().markedUnread).toBe(true);
    expect(within(listRow()).getByLabelText('1 okunmamış mesaj')).toBeInTheDocument();

    // Another chat, then back: reading it ends the mark.
    await router.navigate({ to: '/chat/c/$conversationId', params: { conversationId: CONV.elif } });
    await router.navigate({
      to: '/chat/c/$conversationId',
      params: { conversationId: CONV.milvaion },
    });
    await waitFor(() => expect(myRow().markedUnread).toBe(false), { timeout: 4000 });
  });
});
