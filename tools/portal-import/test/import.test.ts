import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importSite } from '@crewhall/backend/src/services/portal/import';
import { toActor } from '@crewhall/backend/src/services/membership';
import { orgMembers, organizations } from '@crewhall/db';
import { eq } from 'drizzle-orm';
import {
  Client,
  createTestApp,
  setupWithOwner,
  type TestApp,
} from '@crewhall/backend/test/helpers';
// Pulls in the backend test context types (databaseUrl, s3Endpoint).
import type {} from '@crewhall/backend/test/global-setup';
import { parseDocusaurus, type ImportBundle } from '../src';
import { findCorpus } from './helpers';

/**
 * End to end on a real Postgres + S3 (the backend's Testcontainers setup): parse → import as
 * drafts → first publish → the public API serves exactly the URLs Docusaurus served.
 */
const SITE = fileURLToPath(new URL('./fixtures/site', import.meta.url));

let app: TestApp;
let owner: Client;

beforeAll(async () => {
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
});
afterAll(async () => app.close());

async function ownerActor() {
  const [org] = await app.deps.db.select().from(organizations).limit(1);
  const [member] = await app.deps.db
    .select()
    .from(orgMembers)
    .where(eq(orgMembers.organizationId, org!.id));
  return { org: org!, actor: toActor(member!), userId: member!.userId };
}

async function importAndRead(bundle: ImportBundle, slug: string) {
  const result = await importSite(app.deps, await ownerActor(), bundle, {
    siteSlug: slug,
    publish: true,
  });
  const { token } = await owner.api.call('rotatePortalToken', {
    params: { siteId: result.siteId },
  });
  const reader = new Client(app);
  reader.bearer = token;
  const paths = await reader.api.call('portalPublicPaths', {});
  return { result, reader, served: paths.items.map((p) => p.path) };
}

const norm = (p: string) => (p.length > 1 ? p.replace(/\/$/, '') : p);

describe('import of the fixture site', () => {
  let bundle: ImportBundle;
  let siteId: string;
  let reader: Client;
  let served: string[];

  beforeAll(async () => {
    bundle = await parseDocusaurus(SITE);
    ({
      result: { siteId },
      reader,
      served,
    } = await (async () => {
      const r = await importAndRead(bundle, 'acme');
      return { ...r, result: r.result };
    })());
  });

  it('writes drafts, media and a report, then publishes', async () => {
    const reports = await owner.api.call('listPortalImports', { params: { siteId } });
    expect(reports.items[0]?.counts).toMatchObject({
      files: bundle.fileCount,
      posts: bundle.posts.length,
      media: bundle.media.length,
    });
    expect(reports.items[0]?.entries.length).toBe(bundle.entries.length);
    const changes = await owner.api.call('listPortalChanges', { params: { siteId } });
    // Only next (and unlisted) drafts stay unpublished.
    expect(
      changes.items.every(
        (c) => c.kind === 'doc' && (c.version === 'next' || c.action === 'create'),
      ),
    ).toBe(true);
  });

  it('serves every URL Docusaurus served (URL mapping)', () => {
    const missing = bundle.urls.map(norm).filter((u) => !served.map(norm).includes(u));
    expect(missing).toEqual([]);
  });

  it('serves pages, media and blog from the import', async () => {
    const page = await reader.api.call('portalPublicPage', {
      query: { version: bundle.currentVersion, locale: 'en', slug: 'guides/setup' },
    });
    expect(page.kind).toBe('doc');
    const media = bundle.media[0];
    if (media) {
      const res = await reader.fetch(
        `http://localhost:3000/api/v1/public/portal/media/${media.path.replace(/^\/media\//, '')}`,
      );
      expect(res.status).toBe(200);
    }
    const posts = await reader.api.call('portalPublicPosts', { query: { locale: 'en' } });
    expect(posts.total).toBe(bundle.posts.filter((p) => p.locale === 'en').length);
  });

  it('re-import changes nothing when the source did not change', async () => {
    const again = await importSite(app.deps, await ownerActor(), bundle, { siteSlug: 'acme' });
    expect(again.created).toBe(false);
    const changes = await owner.api.call('listPortalChanges', { params: { siteId } });
    expect(changes.items.filter((c) => c.version !== 'next' && c.action === 'update')).toEqual([]);
  });
});

const corpus = findCorpus();

describe.skipIf(!corpus)('import of ../milva-portal', () => {
  it('imports the 164 documents and serves the old site URLs', { timeout: 240_000 }, async () => {
    const root = path.resolve(corpus!);
    const bundle = await parseDocusaurus(root);
    const { served } = await importAndRead(bundle, 'milva-portal');
    const docs = bundle.docs.filter((d) => d.locale === bundle.site.defaultLocale);
    expect(docs.filter((d) => d.sourcePath.endsWith('.md')).length).toBe(164);
    const missing = bundle.urls.map(norm).filter((u) => !served.map(norm).includes(u));
    expect(missing).toEqual([]);
  });
});
