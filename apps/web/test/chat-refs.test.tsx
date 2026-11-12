import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { internalTargetOf } from '@crewhall/shared';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { driveState } from '@/mocks/drive';
import { NODE } from '@/mocks/driveSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Internal references: the card per viewer, `[[` in the composer, a pasted address. */

const box = () => screen.findByRole('textbox', { name: 'Milvaion Ekibi sohbetine mesaj yaz' });
const finans = () => driveState(db()).nodes.find((n) => n.id === NODE.finans)!;

/** A message from Mert carrying a reference, already in the chat. */
function refMessage(nodeId: string) {
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
    text: '',
    authorId: USER.mert,
    refs: [{ kind: 'node', id: nodeId }],
  });
  conv.lastSeq = seq;
  return seq;
}

const row = (seq: number) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
    if (!el) throw new Error('not rendered yet');
    return el;
  });

describe('reference cards', () => {
  it('shows the title to someone who can see the item and links to it', async () => {
    const node = finans();
    const seq = refMessage(node.id);
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const link = await within(await row(seq)).findByRole('link', { name: new RegExp(node.name) });
    expect(link.getAttribute('href')).toContain(node.id);
  });

  it('tells someone without access only that, with no title', async () => {
    const node = finans();
    const seq = refMessage(node.id);
    const s = db();
    s.spaceMembers = s.spaceMembers.filter(
      (m) => m.spaceId !== node.spaceId || m.userId === USER.bugra,
    );
    signedInAs(USER.mert);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const r = await row(seq);
    expect(await within(r).findByText('Bu öğeye erişimin yok')).toBeInTheDocument();
    expect(r.textContent).not.toContain(node.name);
    expect(within(r).queryByRole('link')).toBeNull();
  });

  it('says so when the item was deleted', async () => {
    const node = finans();
    const seq = refMessage(node.id);
    node.deletedAt = new Date().toISOString();
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const r = await row(seq);
    expect(await within(r).findByText('Bu öğe silinmiş')).toBeInTheDocument();
    expect(r.textContent).not.toContain(node.name);
  });
});

describe('referring from the composer', () => {
  it('picks an item with [[ and sends it without any text', async () => {
    const node = finans();
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const input = await box();
    await user.clear(input);
    // user-event reads [[ as one literal bracket.
    await user.type(input, `[[[[${node.name.slice(0, 4)}`);
    await user.click(await screen.findByRole('option', { name: new RegExp(node.name) }));
    const chips = await screen.findByRole('list', { name: 'Eklenen öğeler' });
    expect(within(chips).getByText(node.name)).toBeInTheDocument();
    expect(input).toHaveValue('');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(chatState(db()).messages.some((m) => m.refs?.[0]?.id === node.id)).toBe(true),
    );
    expect(screen.queryByRole('list', { name: 'Eklenen öğeler' })).toBeNull();
  });

  it('turns a pasted internal address into a reference, and leaves others as text', async () => {
    const node = finans();
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    const input = await box();
    await user.clear(input);
    await user.click(input);
    await user.paste(`${window.location.origin}/drive/x/folder/${node.id}`);
    const chips = await screen.findByRole('list', { name: 'Eklenen öğeler' });
    expect(within(chips).getByText(node.name)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue(''));

    await user.paste('https://example.com/p/1');
    expect(input).toHaveValue('https://example.com/p/1');
    expect(within(chips).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('Sohbete gönder', () => {
  it('sends a Drive item to a chat from its menu, with no share created', async () => {
    const d = driveState(db());
    const node = finans();
    const space = db().spaces.find((s) => s.id === node.spaceId)!;
    const shares = d.shares.length;
    signedInAs(USER.bugra);
    renderApp(`/drive/${space.slug}`);
    const user = userEvent.setup();
    // The name is in the sidebar tree too; the row is the last one.
    const names = await screen.findAllByText(node.name);
    await user.pointer({ keys: '[MouseRight]', target: names.at(-1)! });
    await user.click(await screen.findByRole('menuitem', { name: 'Sohbete gönder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sohbete gönder' });
    await user.type(within(dialog).getByRole('textbox', { name: /Not ekle/ }), 'şuna bak');
    await user.click(await within(dialog).findByRole('button', { name: /Milvaion Ekibi/ }));
    await waitFor(() => {
      const m = chatState(db()).messages.find((x) => x.refs?.[0]?.id === node.id);
      expect(m?.text).toBe('şuna bak');
    });
    expect(d.shares).toHaveLength(shares);
  });
});

describe('internal addresses', () => {
  const id = '0190f0a0-0000-7000-8000-000000000123';
  it('recognises in-app items and nothing else', () => {
    expect(internalTargetOf(`/p/${id}`)).toEqual({ kind: 'node', id });
    expect(internalTargetOf(`/p/yillik-plan-${id}`)).toEqual({ kind: 'node', id });
    expect(internalTargetOf(`/d/${id}`)).toEqual({ kind: 'node', id });
    expect(internalTargetOf(`/b/${id}`)).toEqual({ kind: 'node', id });
    expect(internalTargetOf(`/b/${id}/MLV-12`)).toEqual({
      kind: 'card',
      boardId: id,
      ref: 'MLV-12',
    });
    expect(internalTargetOf(`/drive/milva/folder/${id}`)).toEqual({ kind: 'node', id });
    expect(internalTargetOf(`/drive/milva?preview=${id}`)).toEqual({ kind: 'node', id });
    expect(internalTargetOf(`/b/${id}/settings`)).toBeNull();
    expect(internalTargetOf('/drive/milva')).toBeNull();
    expect(internalTargetOf('/chat')).toBeNull();
    expect(internalTargetOf('/p/kisa')).toBeNull();
  });
});
