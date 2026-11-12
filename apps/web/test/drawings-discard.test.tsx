import { QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useDiscardEmpty } from '@/components/drawings/useDiscardEmpty';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/queryClient';

function Probe({ count, isNew = true }: { count: () => number; isNew?: boolean }) {
  useDiscardEmpty(isNew, { id: 'd1', myRole: 'editor' }, count);
  return null;
}

const mount = (count: () => number, isNew = true) =>
  render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <Probe count={count} isNew={isNew} />
      </QueryClientProvider>
    </StrictMode>,
  );

const trashCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((args) => args[0] === 'trashNodes');

describe('new empty drawing (6.14)', () => {
  let spy: MockInstance;
  beforeEach(() => {
    vi.useFakeTimers();
    spy = vi.spyOn(api, 'call').mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    spy.mockRestore();
    vi.useRealTimers();
  });

  it('survives the StrictMode remount right after it opens', async () => {
    const view = mount(() => 0);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(trashCalls(spy)).toHaveLength(0);
    view.unmount();
  });

  it('goes to the trash when left without an element', async () => {
    const view = mount(() => 0);
    view.unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(trashCalls(spy)).toEqual([['trashNodes', { body: { nodeIds: ['d1'] } }]]);
  });

  it('stays when it has elements, or when it was not new', async () => {
    mount(() => 3).unmount();
    mount(() => 0, false).unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(trashCalls(spy)).toHaveLength(0);
  });
});
