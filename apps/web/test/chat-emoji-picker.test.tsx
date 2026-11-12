import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { animatedHex, jumboEmojis } from '@/lib/emoji/jumbo';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** The full emoji picker, large emoji-only messages and the about page credits. */

const cp = (...c: number[]) => String.fromCodePoint(...c);
const thumbs = cp(0x1f44d);
const party = cp(0x1f389);
const turtle = cp(0x1f422);
const heart = cp(0x2764, 0xfe0f);

describe('jumbo emoji', () => {
  it('takes one to three emojis and nothing else', () => {
    expect(jumboEmojis(thumbs)).toEqual([thumbs]);
    expect(jumboEmojis(` ${thumbs} ${party} `)).toEqual([thumbs, party]);
    // A flag and a family are one emoji each.
    expect(jumboEmojis(cp(0x1f1f9, 0x1f1f7))).toHaveLength(1);
    expect(jumboEmojis(cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467))).toHaveLength(1);
    expect(jumboEmojis(`${thumbs}${thumbs}${thumbs}${thumbs}`)).toBeNull();
    expect(jumboEmojis(`tamam ${thumbs}`)).toBeNull();
    expect(jumboEmojis('123')).toBeNull();
    expect(jumboEmojis('')).toBeNull();
  });

  it('finds the animation file with or without the variation selector', () => {
    expect(animatedHex(heart)).toBe('2764_fe0f');
    expect(animatedHex(cp(0x2764))).toBe('2764_fe0f');
    expect(animatedHex(thumbs)).toBe('1f44d');
    expect(animatedHex(turtle)).toBeNull();
  });
});

describe('emoji picker', () => {
  it('searches in Turkish and inserts the pick into the composer', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.clear(box);
    await user.click(screen.getByRole('button', { name: 'Emoji ekle' }));
    await user.type(await screen.findByRole('textbox', { name: 'Emoji ara' }), 'kaplumbağa');
    await user.click(await screen.findByRole('option', { name: turtle }));
    await waitFor(() => expect(box).toHaveTextContent(turtle));
  });

  it('shows the categories and applies the chosen skin tone', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.click(screen.getByRole('button', { name: 'Emoji ekle' }));
    await user.click(await screen.findByRole('tab', { name: 'Bayraklar' }));
    expect(await screen.findByRole('option', { name: cp(0x1f1f9, 0x1f1f7) })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Koyu' }));
    await user.click(screen.getByRole('tab', { name: 'İnsanlar ve vücut' }));
    expect(await screen.findByRole('option', { name: cp(0x1f44b, 0x1f3ff) })).toBeInTheDocument();
  });
});

describe('emoji-only messages', () => {
  it('are shown large', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
    await user.clear(box);
    await user.type(box, `${party}${party}{Enter}`);
    const msg = await waitFor(() => {
      const m = chatState(db()).messages.find((x) => x.text === `${party}${party}`);
      if (!m) throw new Error('not sent yet');
      return m;
    });
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-seq="${msg.seq}"] [data-jumbo]`);
      if (!el) throw new Error('not rendered yet');
      return el;
    });
    expect(within(row).getAllByRole('img', { name: party })).toHaveLength(2);
  });
});

describe('about page', () => {
  it('credits the animated emoji under CC BY 4.0', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/about');
    expect(await screen.findByRole('link', { name: 'Noto Animated Emoji' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CC BY 4.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by/4.0/',
    );
  });
});
