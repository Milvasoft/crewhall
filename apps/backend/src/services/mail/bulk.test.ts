import { describe, expect, it } from 'vitest';
import { applyBulk, type BulkClient } from './bulk';

/** An IMAP folder in memory: UIDs with their \Seen flag, and the calls made to it. */
function fakeImap(messages: { uid: number; seen: boolean }[]) {
  const calls: { op: string; uids: number[]; to?: string }[] = [];
  let box = [...messages];
  const client = {
    search: async (q: { seen?: boolean; all?: boolean }) =>
      box.filter((m) => q.all || m.seen === q.seen).map((m) => m.uid),
    messageFlagsAdd: async (uids: number[]) => {
      calls.push({ op: 'add', uids });
      for (const m of box) if (uids.includes(m.uid)) m.seen = true;
      return true;
    },
    messageFlagsRemove: async (uids: number[]) => {
      calls.push({ op: 'remove', uids });
      for (const m of box) if (uids.includes(m.uid)) m.seen = false;
      return true;
    },
    messageMove: async (uids: number[], to: string) => {
      calls.push({ op: 'move', uids, to });
      box = box.filter((m) => !uids.includes(m.uid));
      return false;
    },
    messageDelete: async (uids: number[]) => {
      calls.push({ op: 'delete', uids });
      box = box.filter((m) => !uids.includes(m.uid));
      return true;
    },
  };
  return { client: client as unknown as BulkClient, calls, box: () => box };
}

const range = (n: number, seen: (i: number) => boolean) =>
  Array.from({ length: n }, (_, i) => ({ uid: i + 1, seen: seen(i) }));

describe('mail bulk job', () => {
  it('marks only unread messages read, 500 UIDs per STORE, with progress', async () => {
    const imap = fakeImap(range(1203, (i) => i % 3 === 0));
    const progress: [number, number][] = [];
    const done = await applyBulk(imap.client, 'seen', null, async (d, t) => {
      progress.push([d, t]);
    });
    expect(done).toBe(802);
    expect(imap.calls.map((c) => [c.op, c.uids.length])).toEqual([
      ['add', 500],
      ['add', 302],
    ]);
    expect(progress).toEqual([
      [0, 802],
      [500, 802],
      [802, 802],
    ]);
    expect(imap.box().every((m) => m.seen)).toBe(true);
  });

  it('uses the chunk size it is given and sends UIDs in ascending order', async () => {
    const imap = fakeImap(range(7, () => true));
    await applyBulk(imap.client, 'unseen', null, async () => undefined, 3);
    expect(imap.calls.map((c) => c.uids)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    expect(imap.box().some((m) => m.seen)).toBe(false);
  });

  it('moves everything to the target, or to the trash when deleting', async () => {
    const moving = fakeImap(range(4, () => false));
    await applyBulk(moving.client, 'move', 'Arsiv', async () => undefined, 3);
    expect(moving.calls).toEqual([
      { op: 'move', uids: [1, 2, 3], to: 'Arsiv' },
      { op: 'move', uids: [4], to: 'Arsiv' },
    ]);
    const trash = fakeImap(range(2, () => true));
    await applyBulk(trash.client, 'delete', 'Trash', async () => undefined);
    expect(trash.calls).toEqual([{ op: 'move', uids: [1, 2], to: 'Trash' }]);
    const purge = fakeImap(range(2, () => true));
    await applyBulk(purge.client, 'delete', null, async () => undefined);
    expect(purge.calls).toEqual([{ op: 'delete', uids: [1, 2] }]);
  });

  it('does nothing on an empty result', async () => {
    const imap = fakeImap(range(3, () => true));
    const progress: [number, number][] = [];
    const done = await applyBulk(imap.client, 'seen', null, async (d, t) => {
      progress.push([d, t]);
    });
    expect(done).toBe(0);
    expect(imap.calls).toEqual([]);
    expect(progress).toEqual([[0, 0]]);
  });

  it('stops at the failing chunk and reports what was done before it', async () => {
    const imap = fakeImap(range(5, () => false));
    let stores = 0;
    const failing = {
      ...(imap.client as unknown as Record<string, unknown>),
      messageFlagsAdd: async () => {
        stores += 1;
        if (stores === 2) throw Object.assign(new Error('closed'), { code: 'NoConnection' });
        return true;
      },
    } as unknown as BulkClient;
    const progress: number[] = [];
    await expect(
      applyBulk(failing, 'seen', null, async (d) => void progress.push(d), 2),
    ).rejects.toMatchObject({ code: 'NoConnection' });
    expect(progress).toEqual([0, 2]);
  });
});
