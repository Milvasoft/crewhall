import { waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Link preview cards under chat messages (kararlar.md 2026-11-13). */

const preview = {
  url: 'https://example.com/post',
  title: 'Sürüm notları',
  description: 'Kasımda neler değişti.',
  siteName: 'Example Blog',
  imageUrl: 'https://cdn.example.com/cover.png',
};

function postWithPreview(authorId: string) {
  const c = chatState(db());
  const conv = c.conversations.find((x) => x.id === CONV.milvaion)!;
  const last = c.messages
    .filter((m) => m.conversationId === conv.id)
    .sort((a, b) => b.seq - a.seq)[0]!;
  const seq = last.seq + 1;
  c.messages.push({
    ...last,
    id: crypto.randomUUID(),
    seq,
    kind: 'user',
    text: `Şuna bakın ${preview.url}`,
    authorId,
    webhookId: null,
    system: null,
    card: null,
    attachments: [],
    reactions: [],
    replyToId: null,
    linkPreview: preview,
  });
  conv.lastSeq = seq;
  return seq;
}

async function row(seq: number) {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) throw new Error('not rendered yet');
    return el;
  });
}

describe('chat link preview card', () => {
  it('shows site, title, description and picture; the author removes it', async () => {
    const seq = postWithPreview(USER.bugra);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const el = await row(seq);
    const link = within(el).getByRole('link', { name: 'Example Blog bağlantı önizlemesi' });
    expect(link).toHaveAttribute('href', preview.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveTextContent('Sürüm notları');
    expect(link).toHaveTextContent('Kasımda neler değişti.');
    const img = link.querySelector('img');
    expect(img).toHaveAttribute('src', preview.imageUrl);
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');

    const user = userEvent.setup();
    await user.click(within(el).getByRole('button', { name: 'Önizlemeyi kaldır' }));
    await waitFor(() => expect(el.querySelector('[data-link-preview]')).toBeNull());
    const stored = chatState(db()).messages.find(
      (m) => m.seq === seq && m.linkPreview !== undefined,
    );
    expect(stored?.linkPreview).toBeNull();
  });

  it('offers no remove button on someone else’s message', async () => {
    const seq = postWithPreview(USER.elif);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const el = await row(seq);
    expect(within(el).getByRole('link', { name: /bağlantı önizlemesi/ })).toBeInTheDocument();
    expect(within(el).queryByRole('button', { name: 'Önizlemeyi kaldır' })).toBeNull();
  });
});
