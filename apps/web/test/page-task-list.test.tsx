import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageTasks, PageTaskList, type DocNode } from '@/features/quick/PageTasks';
import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';

/** The page card numbers to-dos as the server does, whatever else the page holds. */

const task = (text: string, ...rest: DocNode[]): DocNode => ({
  type: 'taskItem',
  attrs: { checked: false },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...rest],
});
const list = (...items: DocNode[]): DocNode => ({ type: 'taskList', content: items });

const DOC: DocNode = {
  type: 'doc',
  content: [
    { type: 'blockquote', content: [list(task('Alıntıdaki'))] },
    { type: 'toggle', attrs: { summary: 'Aç' }, content: [list(task('Süt'))] },
    list(
      task('Süt', list(task('Alt'))),
      task('Üst', { type: 'blockquote', content: [list(task('Gömülü'))] }),
      task('Son'),
    ),
  ],
};

function show(doc: DocNode) {
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale="tr">
        <PageTaskList nodeId="page" doc={doc} queryKey={['card']} disabled={false} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('page card to-dos', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['Üst', 4],
    ['Alt', 3],
    ['Son', 6],
  ])('sends the document-order number of "%s"', async (text, index) => {
    const call = vi.spyOn(api, 'call').mockResolvedValue({} as never);
    show(DOC);
    await userEvent.click(screen.getByRole('checkbox', { name: text }));
    expect(call).toHaveBeenCalledWith('setPageTask', {
      params: { nodeId: 'page' },
      body: { index, text, checked: true },
    });
    expect(pageTasks(DOC)[index]!.text).toBe(text);
  });

  it('does not tick a to-do of the same text hidden inside a toggle', async () => {
    const call = vi.spyOn(api, 'call').mockResolvedValue({} as never);
    show(DOC);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Süt' }));
    expect(call).toHaveBeenCalledWith('setPageTask', {
      params: { nodeId: 'page' },
      body: { index: 2, text: 'Süt', checked: true },
    });
  });
});
