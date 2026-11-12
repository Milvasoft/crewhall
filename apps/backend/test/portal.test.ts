import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { nodes, portalPublishJobs, portalSites } from '@crewhall/db';
import type { PortalRevalidatePayload } from '@crewhall/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRevalidateJob } from '../src/services/portal/revalidate';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const SECRET = 'test-portal-revalidate-secret-0123';

interface Hit {
  payload: PortalRevalidatePayload;
  signature: string | undefined;
}

/** A stand-in for the Next.js /api/revalidate endpoint. */
function startSite(): Promise<{
  server: Server;
  base: string;
  hits: Hit[];
  fail: { next: number };
}> {
  const hits: Hit[] = [];
  const fail = { next: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (fail.next > 0) {
        fail.next--;
        res.writeHead(504).end();
        return;
      }
      hits.push({
        payload: JSON.parse(body) as PortalRevalidatePayload,
        signature: req.headers['x-portal-signature'] as string | undefined,
      });
      // Check the signature like the site does.
      const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
      res.writeHead(req.headers['x-portal-signature'] === expected ? 200 : 401).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}`, hits, fail });
    }),
  );
}

let app: TestApp;
let owner: Client;
let site: Awaited<ReturnType<typeof startSite>>;
let siteId: string;
let reader: Client;

beforeAll(async () => {
  app = await createTestApp({ PORTAL_REVALIDATE_SECRET: SECRET });
  ({ owner } = await setupWithOwner(app));
  site = await startSite();
});

afterAll(async () => {
  site.server.close();
  await app.close();
});

const md = (title: string, body: string) => `# ${title}\n\n${body}\n`;

describe('portal sites', () => {
  it('creates a site with the Portal space, next + first release and starter content', async () => {
    const created = await owner.api.call('createPortalSite', {
      body: {
        name: 'Milva Portal',
        slug: 'milva-portal',
        domain: 'portal.milvasoft.com',
        locales: ['en', 'tr'],
        defaultLocale: 'en',
        initialVersion: '1.0.1',
      },
    });
    siteId = created.id;
    expect(created.status).toBe('setup');
    expect(created.capabilities).toEqual({ edit: true, publish: true, manage: true });
    expect(created.currentVersion).toBe('1.0.1');
    const versions = await owner.api.call('listPortalVersions', { params: { siteId } });
    expect(versions.items.map((v) => [v.name, v.status])).toEqual([
      ['next', 'next'],
      ['1.0.1', 'current'],
    ]);
    const spaces = await owner.api.call('listSpaces', {});
    expect(spaces.items.some((s) => s.id === created.contentSpaceId)).toBe(true);

    const updated = await owner.api.call('updatePortalSite', {
      params: { siteId },
      body: {
        settings: {
          revalidateUrl: `${site.base}/api/revalidate`,
          previewUrl: 'http://localhost:4221/api/preview',
        },
      },
    });
    expect(updated.settings.revalidateUrl).toContain('/api/revalidate');
    const { token, tokenHint } = await owner.api.call('rotatePortalToken', { params: { siteId } });
    expect(token.endsWith(tokenHint)).toBe(true);
    reader = new Client(app);
    reader.bearer = token;
  });

  it('rejects duplicate slugs and hides the module from members without portal rights', async () => {
    const dup = await owner.raw('POST', '/api/v1/portal/sites', {
      name: 'x',
      slug: 'milva-portal',
      locales: ['en'],
      defaultLocale: 'en',
    });
    expect(dup.status).toBe(409);
    const { person } = await join(app, owner, 'elif@milvasoft.com', 'member');
    const list = await person.api.call('listPortalSites', {});
    expect(list.items).toEqual([]);
    expect(list.capabilities.edit).toBe(false);
    expect((await person.raw('GET', `/api/v1/portal/sites/${siteId}`)).status).toBe(403);
  });
});

describe('docs, translations and publishing', () => {
  let categoryGroup: string;
  let quickStartId: string;
  let trQuickStartId: string;

  it('builds a tree with categories and page nodes in the Portal space', async () => {
    const cat = await owner.api.call('createPortalDoc', {
      params: { siteId },
      body: {
        kind: 'category',
        version: '1.0.1',
        locale: 'en',
        title: 'Milvaion Scheduler',
        slug: 'open-source-libs/milvaion',
      },
    });
    categoryGroup = cat.groupId;
    expect(cat.categorySlug).toBe('category/milvaion-scheduler');
    const doc = await owner.api.call('createPortalDoc', {
      params: { siteId },
      body: {
        version: '1.0.1',
        locale: 'en',
        parentGroupId: categoryGroup,
        title: 'Quick Start',
        markdown: md(
          'Quick Start',
          ':::tip Docker\nYou need **Docker**.\n:::\n\n## Step 1: Start the Stack\n\n```bash title="run.sh"\ndocker compose up\n```',
        ),
      },
    });
    quickStartId = doc.id;
    expect(doc.slug).toBe('open-source-libs/milvaion/quick-start');
    expect(doc.status).toBe('draft');
    expect(doc.path).toEqual([{ groupId: categoryGroup, title: 'Milvaion Scheduler' }]);
    const [node] = await app.deps.db.select().from(nodes).where(eq(nodes.id, doc.nodeId));
    expect(node?.type).toBe('page');

    await owner.api.call('createPortalDoc', {
      params: { siteId },
      body: {
        version: '1.0.1',
        locale: 'en',
        title: 'Welcome',
        slug: 'welcome',
        position: 1,
        markdown: md('Welcome', 'Hello'),
      },
    });
    const tree = await owner.api.call('getPortalDocTree', {
      params: { siteId },
      query: { version: '1.0.1', locale: 'tr' },
    });
    expect(tree.items.map((i) => [i.title, i.translation])).toEqual([
      ['Welcome', 'missing'],
      ['Milvaion Scheduler', 'missing'],
      ['Quick Start', 'missing'],
    ]);
  });

  it('translates, autosaves with baseRev and detects conflicts', async () => {
    const tr = await owner.api.call('createPortalDoc', {
      params: { siteId },
      body: {
        version: '1.0.1',
        locale: 'tr',
        translationOf: quickStartId,
        title: 'Hızlı Başlangıç',
        copySource: true,
      },
    });
    trQuickStartId = tr.id;
    expect(tr.slug).toBe('open-source-libs/milvaion/quick-start');
    expect(tr.translation).toBe('current');
    const saved = await owner.api.call('updatePortalDoc', {
      params: { docId: tr.id },
      body: { baseRev: tr.rev, markdown: md('Hızlı Başlangıç', 'Docker gerekir.') },
    });
    expect(saved.rev).toBe(tr.rev + 1);
    const stale = await owner.raw('PATCH', `/api/v1/portal/docs/${tr.id}`, {
      baseRev: tr.rev,
      title: 'x',
    });
    expect(stale.status).toBe(409);
    expect((stale.body as { code: string }).code).toBe('portal_doc_conflict');
  });

  it('publishes the queue, freezes markdown and calls the signed revalidate webhook', async () => {
    const changes = await owner.api.call('listPortalChanges', { params: { siteId } });
    expect(changes.items.length).toBeGreaterThanOrEqual(5); // 3 en, 1 tr, home, navigation
    const preview = await owner.api.call('previewPortalPublish', { params: { siteId }, body: {} });
    expect(preview.paths).toContain('/docs/1.0.1/open-source-libs/milvaion/quick-start');
    expect(preview.paths).toContain('/tr/docs/1.0.1/open-source-libs/milvaion/quick-start');
    // The preview changed nothing.
    expect((await owner.api.call('listPortalChanges', { params: { siteId } })).items).toHaveLength(
      changes.items.length,
    );

    const published = await owner.api.call('publishPortal', {
      params: { siteId },
      body: { note: 'İlk yayın' },
    });
    expect(published.number).toBe(1);
    expect(published.pathCount).toBeGreaterThan(5); // navigation in the first publish: every page
    expect(published.status).toBe('done');
    expect(published.jobs[0]?.status).toBe('done');
    expect(site.hits).toHaveLength(1);
    const hit = site.hits[0]!;
    expect(hit.payload.site).toBe('milva-portal');
    expect(hit.payload.publish).toBe(1);
    expect(hit.payload.tags).toContain('portal:all');
    expect((await owner.api.call('listPortalChanges', { params: { siteId } })).items).toEqual([]);

    const doc = await owner.api.call('getPortalDoc', { params: { docId: quickStartId } });
    expect(doc.status).toBe('published');
    const mdOut = await owner.api.call('getPortalDocMarkdown', { params: { docId: quickStartId } });
    expect(mdOut.markdown).toContain(':::tip[Docker]');
    expect(mdOut.markdown).toContain('```bash title="run.sh"');
  });

  it('serves published snapshots through the public API with the content token', async () => {
    expect((await new Client(app).raw('GET', '/api/v1/public/portal/site')).status).toBe(401);
    const pubSite = await reader.api.call('portalPublicSite', {});
    expect(pubSite.versions.map((v) => v.name)).toEqual(['1.0.1']);
    expect(pubSite.preview).toBe(false);

    const sidebar = await reader.api.call('portalPublicSidebar', {
      query: { version: '1.0.1', locale: 'en' },
    });
    expect(sidebar.items).toEqual([
      { kind: 'doc', label: 'Welcome', slug: 'welcome', docSlug: 'welcome' },
      {
        kind: 'category',
        label: 'Milvaion Scheduler',
        slug: 'category/milvaion-scheduler',
        collapsed: true,
        items: [
          {
            kind: 'doc',
            label: 'Quick Start',
            slug: 'open-source-libs/milvaion/quick-start',
            docSlug: 'open-source-libs/milvaion/quick-start',
          },
        ],
      },
    ]);
    const page = await reader.api.call('portalPublicPage', {
      query: { version: '1.0.1', locale: 'en', slug: 'open-source-libs/milvaion/quick-start' },
    });
    expect(page.kind).toBe('doc');
    if (page.kind !== 'doc') return;
    expect(page.headings.map((h) => h.id)).toEqual(['quick-start', 'step-1-start-the-stack']);
    expect(page.previous).toEqual({
      title: 'Milvaion Scheduler',
      slug: 'category/milvaion-scheduler',
    });
    expect(page.alternates.map((a) => a.locale)).toEqual(['en', 'tr']);

    const tr = await reader.api.call('portalPublicPage', {
      query: { version: '1.0.1', locale: 'tr', slug: 'open-source-libs/milvaion/quick-start' },
    });
    expect(tr.kind === 'doc' && tr.contentLocale).toBe('tr');
    // Untranslated page in Turkish: English content, URL kept (design 11.11).
    const welcomeTr = await reader.api.call('portalPublicPage', {
      query: { version: '1.0.1', locale: 'tr', slug: 'welcome' },
    });
    expect(welcomeTr.kind === 'doc' && [welcomeTr.contentLocale, welcomeTr.translation]).toEqual([
      'en',
      'missing',
    ]);

    const category = await reader.api.call('portalPublicPage', {
      query: { version: '1.0.1', locale: 'en', slug: 'category/milvaion-scheduler' },
    });
    expect(category.kind === 'category' && category.items.map((i) => i.title)).toEqual([
      'Quick Start',
    ]);

    const paths = await reader.api.call('portalPublicPaths', {});
    const list = paths.items.map((p) => p.path);
    expect(list).toEqual(
      expect.arrayContaining([
        '/',
        '/tr',
        '/docs/1.0.1/welcome',
        '/tr/docs/1.0.1/welcome',
        '/docs/1.0.1/category/milvaion-scheduler',
      ]),
    );
    expect(
      (await reader.raw('GET', '/api/v1/public/portal/page?version=next&locale=en&slug=welcome'))
        .status,
    ).toBe(404);
  });

  it('searches published docs with prefix matching and highlighted snippets', async () => {
    const res = await reader.api.call('portalPublicSearch', { query: { q: 'dock', locale: 'en' } });
    expect(res.items[0]).toMatchObject({
      kind: 'doc',
      title: 'Quick Start',
      path: '/docs/1.0.1/open-source-libs/milvaion/quick-start',
      section: 'Milvaion Scheduler',
    });
    expect(res.items[0]?.snippet).toContain('<mark>');
    const tr = await reader.api.call('portalPublicSearch', {
      query: { q: 'docker', locale: 'tr' },
    });
    expect(tr.items[0]?.path).toBe('/tr/docs/1.0.1/open-source-libs/milvaion/quick-start');
  });

  it('finds pages from the words of a mistyped URL (404 suggestions, design 11.12)', async () => {
    // /docs/1.0.1/milvaion/quickstart → "milvaion quickstart": joined words match the slug.
    const joined = await reader.api.call('portalPublicSearch', {
      query: { q: 'milvaion quickstart', locale: 'en' },
    });
    expect(joined.items[0]?.title).toBe('Quick Start');
    // Any word is enough; pages with every word rank first.
    const any = await reader.api.call('portalPublicSearch', {
      query: { q: 'docker nosuchword', locale: 'en' },
    });
    expect(any.items[0]?.title).toBe('Quick Start');
  });

  it('marks the translation outdated when the source changes, and adds a 301 on slug change', async () => {
    const before = await owner.api.call('getPortalDoc', { params: { docId: quickStartId } });
    await owner.api.call('updatePortalDoc', {
      params: { docId: quickStartId },
      body: {
        baseRev: before.rev,
        slug: 'open-source-libs/milvaion/getting-started',
        markdown: md('Quick Start', 'Changed'),
      },
    });
    const tr = await owner.api.call('getPortalDoc', { params: { docId: trQuickStartId } });
    expect(tr.translation).toBe('outdated');
    expect(tr.slug).toBe('open-source-libs/milvaion/getting-started');

    const pub = await owner.api.call('publishPortal', { params: { siteId }, body: {} });
    expect(pub.items.map((i) => i.locale).sort()).toEqual(['en', 'tr']);
    const redirect = await reader.api.call('portalPublicRedirect', {
      query: { path: '/docs/1.0.1/open-source-libs/milvaion/quick-start' },
    });
    expect(redirect).toEqual({
      to: '/docs/1.0.1/open-source-libs/milvaion/getting-started',
      code: 301,
    });
    const redirects = await owner.api.call('listPortalRedirects', { params: { siteId } });
    expect(redirects.items.filter((r) => r.auto)).toHaveLength(2);
    const trPage = await reader.api.call('portalPublicPage', {
      query: { version: '1.0.1', locale: 'tr', slug: 'open-source-libs/milvaion/getting-started' },
    });
    expect(trPage.kind === 'doc' && trPage.translation).toBe('outdated');
  });

  it('reverts a publish as a new publish', async () => {
    const list = await owner.api.call('listPortalPublishes', { params: { siteId }, query: {} });
    const second = list.items[0]!;
    const reverted = await owner.api.call('revertPortalPublish', {
      params: { publishId: second.id },
      body: {},
    });
    expect(reverted.revertOf).toBe(second.number);
    const page = await reader.api.call('portalPublicPage', {
      query: { version: '1.0.1', locale: 'en', slug: 'open-source-libs/milvaion/quick-start' },
    });
    expect(page.kind === 'doc' && page.markdown).toContain('Step 1');
    const doc = await owner.api.call('getPortalDoc', { params: { docId: quickStartId } });
    expect(doc.status).toBe('changed'); // the draft keeps the newer text
    const again = await owner.api.call('getPortalPublish', { params: { publishId: second.id } });
    expect(again.revertedBy).toBe(reverted.number);
  });

  it('retries a failed revalidation and marks it failed after the last attempt', async () => {
    const doc = await owner.api.call('getPortalDoc', { params: { docId: quickStartId } });
    await owner.api.call('updatePortalDoc', {
      params: { docId: quickStartId },
      body: { baseRev: doc.rev, title: 'Quick Start!' },
    });
    site.fail.next = 10;
    const pub = await owner.api.call('publishPortal', { params: { siteId }, body: {} });
    const job = pub.jobs[0]!;
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(1);
    for (let i = 0; i < 3; i++) {
      await runRevalidateJob(
        { db: app.deps.db, env: app.env, logger: app.deps.logger },
        job.id,
      ).catch(() => undefined);
    }
    const [row] = await app.deps.db
      .select()
      .from(portalPublishJobs)
      .where(eq(portalPublishJobs.id, job.id));
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(4);
    const failed = await owner.api.call('getPortalPublish', { params: { publishId: pub.id } });
    expect(failed.status).toBe('failed');
    site.fail.next = 0;
    const retried = await owner.api.call('retryPortalPublishJob', { params: { jobId: job.id } });
    expect(retried.status).toBe('done');
    expect(
      (await owner.api.call('getPortalPublish', { params: { publishId: pub.id } })).status,
    ).toBe('done');
  });

  it('deletes a published doc on the next publish (404 afterwards)', async () => {
    const tree = await owner.api.call('getPortalDocTree', {
      params: { siteId },
      query: { version: '1.0.1', locale: 'en' },
    });
    const welcome = tree.items.find((i) => i.slug === 'welcome')!;
    await owner.api.call('deletePortalDoc', { params: { docId: welcome.id! } });
    const changes = await owner.api.call('listPortalChanges', { params: { siteId } });
    expect(changes.items.find((c) => c.id === welcome.id)?.action).toBe('remove');
    await owner.api.call('publishPortal', {
      params: { siteId },
      body: { keys: [`doc:${welcome.id}`] },
    });
    expect(
      (await reader.raw('GET', '/api/v1/public/portal/page?version=1.0.1&locale=en&slug=welcome'))
        .status,
    ).toBe(404);
    // Deleting a category with docs is refused.
    const cat = tree.items.find((i) => i.kind === 'category')!;
    expect((await owner.raw('DELETE', `/api/v1/portal/docs/${cat.id}`)).status).toBe(409);
  });
});

describe('blog, home, navigation and versions', () => {
  it('schedules a post: invisible until its time, then revalidated', async () => {
    const author = await owner.api.call('createPortalAuthor', {
      params: { siteId },
      body: { key: 'bugrakosen', name: 'Ahmet Buğra Kösen', title: 'Software Developer' },
    });
    const post = await owner.api.call('createPortalPost', {
      params: { siteId },
      body: {
        locale: 'en',
        title: 'Milvaion 1.4',
        slug: 'milvaion-1-4',
        authorIds: [author.id],
        tags: ['milvaion', 'workflows'],
        markdown: 'Intro text.\n\n<!-- truncate -->\n\n## Workflows\n\nMore.',
      },
    });
    const later = new Date(Date.now() + 3600_000).toISOString();
    await owner.api.call('updatePortalPost', {
      params: { postId: post.id },
      body: { scheduledAt: later, baseRev: post.rev },
    });
    const changes = await owner.api.call('listPortalChanges', { params: { siteId } });
    expect(changes.items.find((c) => c.id === post.id)?.action).toBe('schedule');
    const preview = await owner.api.call('previewPortalPublish', {
      params: { siteId },
      body: { keys: [`post:${post.id}`] },
    });
    expect(preview.scheduled[0]?.paths).toContain('/blog/milvaion-1-4');
    const pub = await owner.api.call('publishPortal', {
      params: { siteId },
      body: { keys: [`post:${post.id}`] },
    });
    expect(pub.items[0]?.action).toBe('schedule');
    expect(pub.jobs.map((j) => j.status)).toEqual(['queued']);
    expect((await reader.api.call('portalPublicPosts', { query: { locale: 'en' } })).items).toEqual(
      [],
    );

    // Time passes: the post is visible from its time on.
    await app.deps.db.execute(
      `update portal_posts set visible_at = now() - interval '1 minute' where id = '${post.id}'`,
    );
    const posts = await reader.api.call('portalPublicPosts', { query: { locale: 'en' } });
    expect(posts.items[0]).toMatchObject({
      slug: 'milvaion-1-4',
      truncated: true,
      authors: [{ key: 'bugrakosen' }],
    });
    expect(posts.items[0]?.excerpt.trim()).toBe('Intro text.');
    const trPosts = await reader.api.call('portalPublicPosts', { query: { locale: 'tr' } });
    expect(trPosts.items[0]?.contentLocale).toBe('en');
    const one = await reader.api.call('portalPublicPost', {
      query: { locale: 'en', slug: 'milvaion-1-4' },
    });
    expect(one.headings.map((h) => h.text)).toEqual(['Workflows']);
    const tags = await reader.api.call('portalPublicTags', { query: { locale: 'en' } });
    expect(tags.items).toEqual([
      { tag: 'milvaion', count: 1 },
      { tag: 'workflows', count: 1 },
    ]);
  });

  it('keeps system navbar items and publishes home and navigation', async () => {
    const nav = await owner.api.call('getPortalNavigation', { params: { siteId } });
    const withoutLocale = {
      ...nav.draft,
      navbar: {
        ...nav.draft.navbar,
        items: nav.draft.navbar.items.filter((i) => i.kind !== 'localeDropdown'),
      },
    };
    expect(
      (await owner.raw('PUT', `/api/v1/portal/sites/${siteId}/navigation`, withoutLocale)).status,
    ).toBe(422);
    const github = {
      ...nav.draft,
      navbar: {
        ...nav.draft.navbar,
        items: [
          ...nav.draft.navbar.items,
          {
            id: 'github',
            kind: 'link' as const,
            position: 'right' as const,
            label: { en: 'GitHub' },
            href: 'https://github.com/Milvasoft',
            hidden: false,
          },
        ],
      },
    };
    const saved = await owner.api.call('updatePortalNavigation', {
      params: { siteId },
      body: github,
    });
    expect(saved.changed).toBe(true);
    const home = await owner.api.call('getPortalHome', { params: { siteId } });
    await owner.api.call('updatePortalHome', {
      params: { siteId },
      body: {
        sections: [
          {
            ...home.draft.sections[0]!,
            title: { en: 'Welcome To Milva Portal', tr: "Milva Portal'a Hoş Geldiniz" },
          },
        ],
      },
    });
    const hitsBefore = site.hits.length;
    const pub = await owner.api.call('publishPortal', {
      params: { siteId },
      body: { keys: ['home:site', 'navigation:site'] },
    });
    expect(pub.pathCount).toBeGreaterThan(5);
    expect(site.hits[hitsBefore]?.payload.tags).toContain('portal:all');
    const pubSite = await reader.api.call('portalPublicSite', {});
    expect(pubSite.navigation.navbar.items.some((i) => i.id === 'github')).toBe(true);
    expect(pubSite.home.sections[0]?.title.tr).toBe("Milva Portal'a Hoş Geldiniz");
  });

  it('freezes next into a new current release that is published at once', async () => {
    await owner.api.call('createPortalDoc', {
      params: { siteId },
      body: {
        version: 'next',
        locale: 'en',
        title: 'Workflows',
        slug: 'workflows',
        markdown: md('Workflows', 'A graph of jobs.'),
      },
    });
    const diff = await owner.api.call('diffPortalVersions', {
      params: { siteId },
      query: { from: 'next', to: '1.0.1' },
    });
    expect(diff.added.map((d) => d.slug)).toEqual(['workflows']);
    expect(
      (await owner.raw('POST', `/api/v1/portal/sites/${siteId}/versions`, { name: '1.0.0' }))
        .status,
    ).toBe(400);
    const v = await owner.api.call('freezePortalVersion', {
      params: { siteId },
      body: { name: '1.1.0', makeCurrent: true },
    });
    expect(v.status).toBe('current');
    const versions = await owner.api.call('listPortalVersions', { params: { siteId } });
    expect(versions.items.map((x) => [x.name, x.status])).toEqual([
      ['next', 'next'],
      ['1.1.0', 'current'],
      ['1.0.1', 'archived'],
    ]);
    const page = await reader.api.call('portalPublicPage', {
      query: { version: '1.1.0', locale: 'en', slug: 'workflows' },
    });
    expect(page.kind === 'doc' && page.title).toBe('Workflows');
  });

  it('opens a signed preview that shows drafts and next', async () => {
    const link = await owner.api.call('createPortalPreview', {
      params: { siteId },
      body: { path: '/docs/next/workflows' },
    });
    const token = new URL(link.url).searchParams.get('token')!;
    const res = await reader.raw('GET', '/api/v1/public/portal/site', undefined, {
      'X-Portal-Preview': token,
    });
    expect((res.body as { preview: boolean; versions: { name: string }[] }).preview).toBe(true);
    expect((res.body as { versions: { name: string }[] }).versions.map((x) => x.name)).toContain(
      'next',
    );
    const bad = await reader.raw('GET', '/api/v1/public/portal/site', undefined, {
      'X-Portal-Preview': `${token}x`,
    });
    expect((bad.body as { preview: boolean }).preview).toBe(false);
  });

  it('uploads media to a permanent path and refuses to delete media in use', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    );
    const { media, uploadPath } = await owner.api.call('createPortalMedia', {
      params: { siteId },
      body: { fileName: 'logo.png', mime: 'image/png', size: png.length, folder: 'img' },
    });
    expect(media.path).toBe('/media/img/logo.png');
    const put = await owner.fetch(`http://localhost:3000${uploadPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect(put.status).toBe(200);
    const listed = await owner.api.call('listPortalMedia', { params: { siteId }, query: {} });
    expect(listed.items[0]).toMatchObject({ status: 'ready', width: 1, height: 1 });
    const file = await reader.fetch(
      'http://localhost:3000/api/v1/public/portal/media/img/logo.png',
    );
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(png);

    const nav = await owner.api.call('getPortalNavigation', { params: { siteId } });
    await owner.api.call('updatePortalNavigation', {
      params: { siteId },
      body: {
        ...nav.draft,
        navbar: {
          ...nav.draft.navbar,
          logo: { src: '/media/img/logo.png', srcDark: null, alt: 'Logo' },
        },
      },
    });
    expect((await owner.raw('DELETE', `/api/v1/portal/media/${media.id}`)).status).toBe(409);
  });

  it('shows the overview numbers and writes the audit log', async () => {
    const o = await owner.api.call('getPortalOverview', { params: { siteId } });
    expect(o.publishedUrlCount).toBeGreaterThan(5);
    expect(o.pending.count).toBeGreaterThan(0);
    expect(o.translations[0]?.locale).toBe('tr');
    expect(o.recentPublishes.length).toBeGreaterThan(3);
    const rows = await app.deps.db.execute<{ action: string }>(
      `select action from audit_logs where action like 'portal.%'`,
    );
    const actions = new Set(rows.rows.map((r) => r.action));
    expect([...actions]).toEqual(
      expect.arrayContaining([
        'portal.site.create',
        'portal.publish',
        'portal.revert',
        'portal.version.freeze',
      ]),
    );
  });

  it('keeps Hub-only nodes (mentions, embeds) out of published markdown', async () => {
    const doc = await owner.api.call('createPortalDoc', {
      params: { siteId },
      body: {
        version: '1.1.0',
        locale: 'en',
        title: 'Internal',
        slug: 'internal',
        markdown: [
          'Ask [@Elif](mention:user:u-1) here.',
          '',
          '::embed{node="n-1" type="board"}',
        ].join('\n'),
      },
    });
    await owner.api.call('publishPortal', {
      params: { siteId },
      body: { keys: [`doc:${doc.id}`] },
    });
    const page = await reader.api.call('portalPublicPage', {
      query: { version: '1.1.0', locale: 'en', slug: 'internal' },
    });
    expect(page.kind === 'doc' && page.markdown.trim()).toBe('Ask Elif here.');
  });

  it('serves nothing and skips revalidation while the org has the module switched off', async () => {
    const setModule = (on: boolean) =>
      app.deps.db.execute(
        `update organizations set settings = jsonb_set(settings, '{modules}', '{"portal": ${on}}'::jsonb)`,
      );
    const [siteRow] = await app.deps.db
      .select()
      .from(portalSites)
      .where(eq(portalSites.id, siteId));
    const [job] = await app.deps.db
      .insert(portalPublishJobs)
      .values({ orgId: siteRow!.orgId, siteId, scope: 'test', tags: ['portal:all'], paths: ['/'] })
      .returning();
    await setModule(false);
    try {
      // The central module guard (MODULE_OF_ENDPOINT) answers before the portal's own check.
      expect((await reader.raw('GET', '/api/v1/public/portal/site')).status).toBe(403);
      const hits = site.hits.length;
      await runRevalidateJob({ db: app.deps.db, env: app.env, logger: app.deps.logger }, job!.id);
      expect(site.hits.length).toBe(hits);
      const [after] = await app.deps.db
        .select()
        .from(portalPublishJobs)
        .where(eq(portalPublishJobs.id, job!.id));
      expect([after?.status, after?.error]).toEqual(['failed', 'module_disabled']);
    } finally {
      await setModule(true);
    }
    expect((await reader.raw('GET', '/api/v1/public/portal/site')).status).toBe(200);
  });
});
