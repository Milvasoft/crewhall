import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { organizations, portalPosts } from '@crewhall/db';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';
import { callTool, mcp } from './mcp-helpers';

/** Portal tools over MCP (doc 17 §13): drafts only, publishing through the approval queue. */
describe('MCP portal tools', () => {
  let app: TestApp;
  let owner: Client;
  let orgId: string;
  let siteId: string;
  let token: string;

  const toolNames = async (t: string) => {
    const res = await mcp(app, t, 'tools/list');
    return (res.json.result as { tools: { name: string }[] }).tools.map((x) => x.name);
  };
  const changeKeys = async () =>
    (await owner.api.call('listPortalChanges', { params: { siteId } })).items.map((c) => c.key);

  beforeAll(async () => {
    app = await createTestApp();
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    orgId = setup.orgId;
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
    await owner.api.call('updateMcpPolicy', {
      body: { requestsPerMinute: 600, writesPerMinute: 200 },
    });
    token = (
      await owner.api.call('createMcpToken', {
        body: {
          name: 'Portal',
          scopes: ['hub:read', 'portal:draft', 'portal:publish'],
          spaceIds: null,
          expiresInDays: 30,
        },
      })
    ).value;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('lists the portal tools and the doc tree', async () => {
    expect(await toolNames(token)).toEqual(
      expect.arrayContaining([
        'list_portal_docs',
        'upsert_portal_doc',
        'create_blog_post',
        'request_portal_publish',
      ]),
    );
    const tree = await callTool(app, token, 'list_portal_docs', {});
    expect(tree.isError).toBe(false);
    expect(tree.data.version).toBe('1.0.1');
    expect(tree.data.lang).toBe('en');
    expect(Array.isArray(tree.data.items)).toBe(true);
    expect(tree.data.locales).toEqual(['en', 'tr']);
  });

  it('upserts docs as drafts: same slug opens a revision, another language a translation', async () => {
    const first = await callTool(app, token, 'upsert_portal_doc', {
      lang: 'en',
      slug: 'release-notes-1-5',
      title: 'Milvaion 1.5 Release Notes',
      markdown: '## Highlights\n\n- Workflow retries',
    });
    expect(first.isError).toBe(false);
    expect(first.data).toMatchObject({ status: 'draft', created: true });
    const docId = first.data.doc_id as string;

    const again = await callTool(app, token, 'upsert_portal_doc', {
      lang: 'en',
      slug: 'release-notes-1-5',
      title: 'Milvaion 1.5 Release Notes',
      markdown: '## Highlights\n\n- Workflow retries\n- New dashboard',
    });
    expect(again.data).toMatchObject({ doc_id: docId, created: false });
    expect(again.data.rev as number).toBeGreaterThan(first.data.rev as number);

    const tr = await callTool(app, token, 'upsert_portal_doc', {
      lang: 'tr',
      slug: 'release-notes-1-5',
      title: 'Milvaion 1.5 Sürüm Notları',
      markdown: '## Öne çıkanlar',
    });
    expect(tr.data.created).toBe(true);
    const enDoc = await owner.api.call('getPortalDoc', { params: { docId } });
    const trDoc = await owner.api.call('getPortalDoc', {
      params: { docId: tr.data.doc_id as string },
    });
    expect(trDoc.groupId).toBe(enDoc.groupId);
    const markdown = await owner.api.call('getPortalDocMarkdown', { params: { docId } });
    expect(markdown.markdown).toContain('New dashboard');
    // Drafts only: nothing went live.
    expect(await changeKeys()).toContain(`doc:${docId}`);
  });

  it('publishing always waits for the person, then runs the publish flow', async () => {
    const doc = await callTool(app, token, 'upsert_portal_doc', {
      lang: 'en',
      slug: 'workflows',
      title: 'Workflows',
      markdown: 'Retries',
    });
    const docId = doc.data.doc_id as string;
    const post = await callTool(app, token, 'create_blog_post', {
      lang: 'en',
      title: 'Milvaion 1.5 is out',
      markdown: 'Milvaion 1.5 brings retries.',
    });
    expect(post.data.status).toBe('draft');
    const postId = post.data.post_id as string;

    const pending = await callTool(app, token, 'request_portal_publish', {
      doc_ids: [docId],
      post_ids: [postId],
      note: 'Kullanıcı istedi',
    });
    expect(pending.data.status).toBe('pending_approval');
    expect(await changeKeys()).toEqual(expect.arrayContaining([`doc:${docId}`, `post:${postId}`]));
    const approvalId = pending.data.approval_id as string;
    const detail = await owner.api.call('getMcpApproval', { params: { approvalId } });
    expect(detail.action).toBe('portal.publish');
    expect(detail.items.map((i) => i.label)).toEqual(
      expect.arrayContaining(['Workflows', 'Milvaion 1.5 is out']),
    );

    const approved = await owner.api.call('approveMcpApproval', { params: { approvalId } });
    expect(approved.status).toBe('applied');
    const left = await changeKeys();
    expect(left).not.toContain(`doc:${docId}`);
    expect(left).not.toContain(`post:${postId}`);
    const publishes = await owner.api.call('listPortalPublishes', {
      params: { siteId },
      query: {},
    });
    expect(publishes.items.length).toBeGreaterThan(0);
  });

  it('an edit after the request makes it stale', async () => {
    const doc = await callTool(app, token, 'upsert_portal_doc', {
      lang: 'en',
      slug: 'quick-notes',
      title: 'Quick notes',
      markdown: 'v1',
    });
    const docId = doc.data.doc_id as string;
    const pending = await callTool(app, token, 'request_portal_publish', { doc_ids: [docId] });
    await new Promise((r) => setTimeout(r, 5));
    await owner.api.call('updatePortalDoc', {
      params: { docId },
      body: { markdown: 'v2 by a person' },
    });
    await expect(
      owner.api.call('approveMcpApproval', {
        params: { approvalId: pending.data.approval_id as string },
      }),
    ).rejects.toMatchObject({ code: 'mcp_approval_closed' });
    expect(await changeKeys()).toContain(`doc:${docId}`);
  });

  it('a publish request without changes, or without portal.publish, is refused', async () => {
    const none = await callTool(app, token, 'request_portal_publish', {
      doc_ids: ['00000000-0000-7000-8000-000000000000'],
    });
    expect(none.isError).toBe(true);
    const { person } = await join(app, owner, 'mert@milvasoft.com', 'member');
    const mertToken = (
      await person.api.call('createMcpToken', {
        body: {
          name: 'Mert',
          scopes: ['hub:read', 'portal:draft'],
          spaceIds: null,
          expiresInDays: 7,
        },
      })
    ).value;
    const denied = await callTool(app, mertToken, 'upsert_portal_doc', {
      lang: 'en',
      slug: 'nope',
      title: 'Nope',
      markdown: 'x',
    });
    expect(denied.data.error).toBe('forbidden');
  });

  it('undo removes a blog draft Claude created', async () => {
    const post = await callTool(app, token, 'create_blog_post', {
      lang: 'tr',
      title: 'Geri alınacak',
      markdown: 'taslak',
    });
    expect(post.data).toMatchObject({ status: 'draft' });
    const postId = post.data.post_id as string;
    const activity = await owner.api.call('listMcpActivity', { query: { filter: 'write' } });
    const call = activity.items.find((c) => c.target?.id === postId)!;
    await owner.api.call('undoMcpToolCall', { params: { callNo: call.id } });
    const [row] = await app.deps.db.select().from(portalPosts).where(eq(portalPosts.id, postId));
    // A never-published draft is removed outright; a published one is marked deleted.
    expect(!row || row.deletedAt !== null).toBe(true);
  });

  it('hides the portal tools while the org has the portal off', async () => {
    await app.deps.db.execute(
      sql`update ${organizations} set settings = jsonb_set(settings, '{modules}', '{"portal": false}') where id = ${orgId}`,
    );
    try {
      const names = await toolNames(token);
      expect(names.some((n) => n.includes('portal') || n === 'create_blog_post')).toBe(false);
      const call = await callTool(app, token, 'list_portal_docs', {});
      expect(call.data.error).toBe('unknown_tool');
    } finally {
      await app.deps.db.execute(
        sql`update ${organizations} set settings = settings - 'modules' where id = ${orgId}`,
      );
    }
  });
});
