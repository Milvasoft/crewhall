import { pages } from '@crewhall/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { docFromState, docToJson, setTaskChecked, stateFromJson } from '../src/services/wiki/doc';
import { createTestApp, join, setupWithOwner, type Client, type TestApp } from './helpers';

/** Ticking a page's to-do from outside the editor (the home page's page card). */

const task = (text: string, checked = false, sub?: unknown[]) => ({
  type: 'taskItem',
  attrs: { checked },
  content: [
    { type: 'paragraph', content: [{ type: 'text', text }] },
    ...(sub ? [{ type: 'taskList', content: sub }] : []),
  ],
});

describe('setTaskChecked', () => {
  const doc = () =>
    docFromState(
      stateFromJson({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Giriş' }] },
          { type: 'taskList', content: [task('Bir', false, [task('Alt')]), task('İki', true)] },
        ],
      } as never),
    );
  const checks = (d: Y.Doc) => JSON.stringify(docToJson(d)).match(/"checked":(true|false)/g);

  it('counts sub-tasks in document order and checks the text', () => {
    const d = doc();
    expect(setTaskChecked(d, { index: 1, text: 'Alt', checked: true })).toBe(true);
    expect(checks(d)).toEqual(['"checked":false', '"checked":true', '"checked":true']);
    // The page changed under the card: nothing happens.
    expect(setTaskChecked(d, { index: 0, text: 'Başka', checked: true })).toBe(false);
    expect(setTaskChecked(d, { index: 9, text: 'Bir', checked: true })).toBe(false);
    expect(checks(d)).toEqual(['"checked":false', '"checked":true', '"checked":true']);
    expect(setTaskChecked(d, { index: 2, text: ' İki ', checked: false })).toBe(true);
    expect(checks(d)).toEqual(['"checked":false', '"checked":true', '"checked":false']);
  });
});

describe('setPageTask', () => {
  let app: TestApp;
  let owner: Client;
  let viewer: Client;
  let spaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    owner = (await setupWithOwner(app)).owner;
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    // Invited people join default spaces as viewers.
    viewer = (await join(app, owner, 'selin@milvasoft.com', 'member')).person;
  });
  afterAll(async () => {
    await app?.close();
  });

  const page = (markdown: string) =>
    owner.api.call('createPage', { params: { spaceId }, body: { name: 'Liste', markdown } });

  it('ticks a to-do, shown by the next read', async () => {
    const { id } = await page('Giriş\n\n- [ ] Süt\n- [ ] Ekmek\n');
    await owner.api.call('setPageTask', {
      params: { nodeId: id },
      body: { index: 1, text: 'Ekmek', checked: true },
    });
    const { markdown } = await owner.api.call('getPageContent', {
      params: { nodeId: id },
      query: { format: 'markdown' },
    });
    expect(markdown).toContain('- [ ] Süt');
    expect(markdown).toContain('- [x] Ekmek');
  });

  it('records where the tick came from', async () => {
    const { id } = await page('- [ ] Süt\n- [ ] Ekmek\n');
    const tick = (index: number, text: string, headers: Record<string, string>) =>
      owner.raw('POST', `/api/v1/pages/${id}/tasks`, { index, text, checked: true }, headers);
    const lastSource = async () => {
      const [row] = await app.deps.db
        .select({ source: pages.lastSource })
        .from(pages)
        .where(eq(pages.nodeId, id));
      return row?.source;
    };

    expect((await tick(0, 'Süt', { 'User-Agent': 'okhttp/4.12.0' })).status).toBe(200);
    expect(await lastSource()).toBe('mobile');
    expect((await tick(1, 'Ekmek', { 'User-Agent': 'Mozilla/5.0 Chrome/130' })).status).toBe(200);
    expect(await lastSource()).toBe('web');
  });

  it('refuses a to-do that changed, and those who may not edit', async () => {
    const { id } = await page('- [ ] Süt\n');
    await expect(
      owner.api.call('setPageTask', {
        params: { nodeId: id },
        body: { index: 0, text: 'Ekmek', checked: true },
      }),
    ).rejects.toMatchObject({ code: 'page_task_changed' });
    await expect(
      viewer.api.call('setPageTask', {
        params: { nodeId: id },
        body: { index: 0, text: 'Süt', checked: true },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await owner.api.call('updatePage', { params: { nodeId: id }, body: { locked: true } });
    await expect(
      owner.api.call('setPageTask', {
        params: { nodeId: id },
        body: { index: 0, text: 'Süt', checked: true },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
