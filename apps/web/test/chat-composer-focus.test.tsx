import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Opening a chat puts the cursor in its message box, except on touch screens. */

const box = (name: string) => screen.findByRole('textbox', { name: `${name} sohbetine mesaj yaz` });

function pointer(coarse: boolean) {
  const real = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
    query === '(pointer: coarse)'
      ? ({ ...real(query), matches: coarse } as MediaQueryList)
      : real(query),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('message box focus', () => {
  it('is in the message box when a chat opens', async () => {
    pointer(false);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const el = await box('Milvaion Ekibi');
    await waitFor(() => expect(document.activeElement).toBe(el));
  });

  it('stays out of the box on a touch screen, so the keyboard does not cover the chat', async () => {
    pointer(true);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const el = await box('Milvaion Ekibi');
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).not.toBe(el);
  });
});
