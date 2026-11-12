import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { conversationsQuery, messagesQuery } from '@/lib/chat/queries';
import { bindRuntimeForTests, reportVisibleSeq } from '@/lib/chat/runtime';
import { setVisibleConversation } from '@/lib/chat/stores';
import { createQueryClient } from '@/lib/queryClient';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { signedInAs } from './support/session';

function setFocus(on: boolean) {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => on });
}

afterEach(() => {
  setFocus(true);
  vi.restoreAllMocks();
});

describe('reading the open chat', () => {
  it('waits for its window to be in front: a visible window behind others reads nothing', async () => {
    signedInAs(USER.bugra);
    const qc = createQueryClient();
    await qc.fetchQuery(conversationsQuery);
    const w = await qc.fetchQuery(messagesQuery(CONV.milvaion));
    bindRuntimeForTests(qc, USER.bugra);
    setVisibleConversation(CONV.milvaion);
    const call = vi.spyOn(api, 'call');
    const reads = () => call.mock.calls.filter(([name]) => name === 'markConversationRead');
    const last = Math.max(...w.items.map((m) => m.seq)) + 1;

    // A new alert lands in the open chat while another window is in front.
    setFocus(false);
    reportVisibleSeq(CONV.milvaion, last);
    await new Promise((r) => setTimeout(r, 1200));
    expect(reads()).toEqual([]);

    // Back in front: the visible messages are read.
    setFocus(true);
    reportVisibleSeq(CONV.milvaion, last);
    await expect.poll(() => reads().length, { timeout: 3000 }).toBe(1);
  });
});
