import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pages } from '@crewhall/db';
import { pagePath } from '@crewhall/shared';
import { stateFromJson, type PMDoc } from '../src/services/wiki/doc';
import { Client, createTestApp, join, setupWithOwner, uploadFile, type TestApp } from './helpers';

/** "Portal'a gönder" (design 05 5.12, 10.13): a Hub page becomes a draft portal doc. */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const MISSING = '0190f0a0-0000-7000-8000-000000000abc';

describe('sending a page to the Portal', () => {
  let app: TestApp;
  let owner: Client;
  let siteId: string;
  let spaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    const site = await owner.api.call('createPortalSite', {
      body: {
        name: 'Milva Portal',
        slug: 'milva-portal',
        domain: 'portal.milvasoft.com',
        locales: ['en', 'tr'],
        defaultLocale: 'en',
        initialVersion: '1.0.1',
      },
    });
    siteId = site.id;
  });
  afterAll(async () => {
    await app?.close();
  });

  /** Stores a body the way the collab server does. */
  const setBody = (nodeId: string, doc: PMDoc) =>
    app.deps.db
      .update(pages)
      .set({ ydoc: stateFromJson(doc) })
      .where(eq(pages.nodeId, nodeId));

  it('creates a draft, copies Drive images and drops Hub links; again updates the same draft', async () => {
    const { node: image } = await uploadFile(owner, {
      spaceId,
      name: 'şema.png',
      content: PNG,
      mime: 'image/png',
    });
    const other = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Sürüm notları' },
    });
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Mimari' },
    });
    await setBody(page.id, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Bkz. ' },
            {
              type: 'text',
              text: 'Sürüm notları',
              marks: [{ type: 'link', attrs: { href: pagePath(other) } }],
            },
            { type: 'text', text: ' ve ' },
            {
              type: 'text',
              text: 'site',
              marks: [{ type: 'link', attrs: { href: 'https://milvasoft.com' } }],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: `node:${image.id}`, alt: 'Şema', title: null } },
          ],
        },
        {
          type: 'paragraph',
          content: [{ type: 'image', attrs: { src: `node:${MISSING}`, alt: null, title: null } }],
        },
      ],
    });

    const first = await owner.api.call('createPortalDocFromPage', {
      params: { siteId },
      body: { nodeId: page.id, version: '1.0.1', locale: 'tr' },
    });
    expect(first.created).toBe(true);
    expect(first.images).toEqual({ copied: 1, skipped: 1 });
    expect(first.doc).toMatchObject({
      title: 'Mimari',
      locale: 'tr',
      version: '1.0.1',
      status: 'draft',
      sourceNodeId: page.id,
    });
    const body = JSON.stringify(first.doc.content);
    expect(body).toContain(`"src":"/media/pages/${image.id}/sema.png"`);
    expect(body).not.toContain(MISSING);
    expect(body).not.toContain(pagePath(other));
    expect(body).toContain('Sürüm notları');
    expect(body).toContain('https://milvasoft.com');

    const media = await owner.api.call('listPortalMedia', { params: { siteId }, query: {} });
    const copied = media.items.find((m) => m.path === `/media/pages/${image.id}/sema.png`);
    expect(copied).toMatchObject({ status: 'ready', mime: 'image/png', width: 1, height: 1 });

    // The page changes and goes again: the same draft, a new revision, the image reused.
    await owner.api.call('updatePage', { params: { nodeId: page.id }, body: { name: 'Mimari 2' } });
    await setBody(page.id, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Yeni hali.' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'image', attrs: { src: `node:${image.id}`, alt: 'Şema', title: null } },
          ],
        },
      ],
    });
    const again = await owner.api.call('createPortalDocFromPage', {
      params: { siteId },
      body: { nodeId: page.id, version: '1.0.1', locale: 'tr' },
    });
    expect(again.created).toBe(false);
    expect(again.doc.id).toBe(first.doc.id);
    expect(again.doc.rev).toBeGreaterThan(first.doc.rev);
    expect(again.doc.title).toBe('Mimari 2');
    expect(JSON.stringify(again.doc.content)).toContain('Yeni hali.');
    const after = await owner.api.call('listPortalMedia', { params: { siteId }, query: {} });
    expect(after.items).toHaveLength(media.items.length);

    // Another language of the same page becomes its translation.
    const en = await owner.api.call('createPortalDocFromPage', {
      params: { siteId },
      body: { nodeId: page.id, version: '1.0.1', locale: 'en' },
    });
    expect(en.created).toBe(true);
    expect(en.doc.groupId).toBe(first.doc.groupId);
    expect(en.doc.slug).toBe(first.doc.slug);

    // Nothing is published by sending.
    const changes = await owner.api.call('listPortalChanges', { params: { siteId } });
    expect(changes.items.map((c) => c.key)).toContain(`doc:${first.doc.id}`);
  });

  it('needs portal rights, a page the person can read and a language of the site', async () => {
    const page = await owner.api.call('createPage', {
      params: { spaceId },
      body: { name: 'Açık', markdown: 'Metin.' },
    });
    const { person } = await join(app, owner, 'elif@milvasoft.com', 'member');
    const denied = await person.raw('POST', `/api/v1/portal/sites/${siteId}/docs/from-page`, {
      nodeId: page.id,
      version: '1.0.1',
      locale: 'tr',
    });
    expect(denied.status).toBe(403);

    const missing = await owner.raw('POST', `/api/v1/portal/sites/${siteId}/docs/from-page`, {
      nodeId: MISSING,
      version: '1.0.1',
      locale: 'tr',
    });
    expect(missing.status).toBe(404);

    const notASite = await owner.raw('POST', `/api/v1/portal/sites/${siteId}/docs/from-page`, {
      nodeId: page.id,
      version: '1.0.1',
      locale: 'de',
    });
    expect(notASite.status).toBe(400);
  });
});
