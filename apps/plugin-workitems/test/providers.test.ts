import { describe, expect, it } from 'vitest';
import { AzureProvider } from '../src/providers/azure';
import {
  cleanBaseUrl,
  Http,
  isPrivateAddress,
  toBasic,
  type FetchLike,
} from '../src/providers/http';
import { JiraProvider } from '../src/providers/jira';
import { ProviderError, type ExternalItem } from '../src/types';

interface Call {
  method: string;
  url: URL;
  body: unknown;
  contentType: string | undefined;
  auth: string | undefined;
}

type Route = (call: Call) => unknown | Response;

function fake(routes: Route) {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      contentType: headers['Content-Type'],
      auth: headers.Authorization,
    };
    calls.push(call);
    const out = routes(call);
    return out instanceof Response ? out : new Response(JSON.stringify(out ?? {}), { status: 200 });
  }) as unknown as FetchLike;
  return { f, calls };
}

const typesAnswer = {
  value: [
    {
      name: 'Task',
      fields: [
        'System.Title',
        'System.Description',
        'System.State',
        'System.AssignedTo',
        'Microsoft.VSTS.Common.Priority',
        'Microsoft.VSTS.Scheduling.StartDate',
        'Microsoft.VSTS.Scheduling.DueDate',
        'Microsoft.VSTS.Scheduling.Effort',
      ].map((referenceName) => ({ referenceName })),
      states: [
        { name: 'To Do', category: 'Proposed' },
        { name: 'Doing', category: 'InProgress' },
        { name: 'Done', category: 'Completed' },
        { name: 'Removed', category: 'Removed' },
      ],
    },
    {
      name: 'Bug',
      fields: ['System.Title', 'System.State', 'Microsoft.VSTS.TCM.ReproSteps'].map(
        (referenceName) => ({
          referenceName,
        }),
      ),
      states: [{ name: 'New', category: 'Proposed' }],
    },
    { name: 'Old', isDisabled: true, fields: [], states: [] },
  ],
};

const wi = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  rev: 7,
  fields: {
    'System.TeamProject': 'Web',
    'System.WorkItemType': 'Task',
    'System.Title': `T${id}`,
    'System.Description': '<div>Metin</div>',
    'System.State': 'Doing',
    'System.AssignedTo': { uniqueName: 'Ali@X.dev' },
    'Microsoft.VSTS.Common.Priority': 4,
    'Microsoft.VSTS.Scheduling.DueDate': '2026-12-01T00:00:00Z',
    'Microsoft.VSTS.Scheduling.Effort': 3,
    'System.Tags': 'a; b',
    'System.ChangedDate': '2026-11-10T10:00:00Z',
    'System.CommentCount': 2,
    ...over,
  },
});

const NOWAIT = async () => undefined;

function azure(routes: Route) {
  const { f, calls } = fake((c) => {
    if (c.url.pathname.endsWith('/_apis/wit/workitemtypes')) return typesAnswer;
    return routes(c);
  });
  const http = new Http('https://dev.azure.com/org', async () => 'Basic x', f, NOWAIT);
  return { p: new AzureProvider(http, 'https://dev.azure.com/org'), calls };
}

describe('Azure DevOps', () => {
  it('builds a scoped WIQL query and reads items in order', async () => {
    const { p, calls } = azure((c) => {
      if (c.url.pathname.endsWith('/wiql')) return { workItems: [{ id: 2 }, { id: 1 }] };
      return { value: [wi(1), wi(2)] };
    });
    const items = await p.changedSince(
      { project: 'Web', types: ["Bug's", 'Task'], filter: "[System.AreaPath] UNDER 'Web\\A'" },
      '2026-11-10T09:00:00Z',
      50,
    );
    const q = (calls[0]!.body as { query: string }).query;
    expect(calls[0]!.url.pathname).toBe('/org/Web/_apis/wit/wiql');
    expect(calls[0]!.url.searchParams.get('timePrecision')).toBe('true');
    expect(q).toContain("IN ('Bug''s', 'Task')");
    expect(q).toContain(">= '2026-11-10T09:00:00Z'");
    expect(q).toContain("([System.AreaPath] UNDER 'Web\\A')");
    expect(items.map((i) => i.id)).toEqual(['2', '1']);
    const f = items[1]!.fields;
    expect(f).toMatchObject({
      description: 'Metin',
      status: 'Doing',
      assignee: 'ali@x.dev',
      priority: 'p3',
      dueDate: '2026-12-01',
      points: 3,
      labels: ['a', 'b'],
    });
    expect(items[1]!.url).toBe('https://dev.azure.com/org/Web/_workitems/edit/1');
    expect(items[1]!.commentCount).toBe(2);
  });

  it('says it cannot speak for fields its type does not have', async () => {
    const { p } = azure(() =>
      wi(5, { 'System.WorkItemType': 'Bug', 'Microsoft.VSTS.TCM.ReproSteps': '<p>Adımlar</p>' }),
    );
    const item = (await p.getItem('5'))!;
    expect(item.fields.description).toBe('Adımlar');
    expect(item.fields.dueDate).toBeUndefined();
    expect(item.fields.points).toBeUndefined();
    expect(item.fields.priority).toBeUndefined();
  });

  it('writes a JSON patch guarded by the revision', async () => {
    const { p, calls } = azure((c) =>
      c.method === 'PATCH' ? wi(1, { 'System.Title': 'Yeni' }) : wi(1),
    );
    const item = (await p.getItem('1'))!;
    const out = await p.updateItem(item, {
      title: 'Yeni',
      description: '- a',
      status: 'Done',
      assignee: null,
      priority: 'p1',
      points: 8,
      dueDate: null,
      labels: ['x', 'y'],
    });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.contentType).toBe('application/json-patch+json');
    const ops = patch.body as { op: string; path: string; value?: unknown }[];
    expect(ops[0]).toEqual({ op: 'test', path: '/rev', value: 7 });
    expect(ops).toContainEqual({ op: 'add', path: '/fields/System.Title', value: 'Yeni' });
    expect(ops).toContainEqual({
      op: 'add',
      path: '/fields/System.Description',
      value: '<ul><li>a</li></ul>',
    });
    expect(ops).toContainEqual({ op: 'add', path: '/fields/System.State', value: 'Done' });
    expect(ops).toContainEqual({ op: 'remove', path: '/fields/System.AssignedTo' });
    expect(ops).toContainEqual({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Common.Priority',
      value: 1,
    });
    expect(ops).toContainEqual({
      op: 'add',
      path: '/fields/Microsoft.VSTS.Scheduling.Effort',
      value: 8,
    });
    expect(ops).toContainEqual({ op: 'remove', path: '/fields/Microsoft.VSTS.Scheduling.DueDate' });
    expect(ops).toContainEqual({ op: 'add', path: '/fields/System.Tags', value: 'x; y' });
    expect(out.fields.title).toBe('Yeni');
  });

  it('reports a concurrent save', async () => {
    const { p } = azure((c) =>
      c.method === 'PATCH' ? new Response('{}', { status: 412 }) : wi(1),
    );
    const item = (await p.getItem('1'))!;
    await expect(p.updateItem(item, { title: 'x' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('creates in the first state, then moves', async () => {
    let state = 'To Do';
    const { p, calls } = azure((c) => {
      if (c.method === 'POST') return wi(9, { 'System.State': state });
      state = 'Doing';
      return wi(9, { 'System.State': state });
    });
    const item = await p.createItem({ project: 'Web', types: [], filter: '' }, 'Task', {
      title: 'Y',
      status: 'Doing',
    });
    expect(calls[1]!.url.pathname).toBe('/org/Web/_apis/wit/workitems/$Task');
    expect(
      (calls[1]!.body as { path: string }[]).some((o) => o.path === '/fields/System.State'),
    ).toBe(false);
    expect(item.fields.status).toBe('Doing');
  });

  it('marks a removed state and groups the statuses of a project', async () => {
    const { p } = azure(() => wi(1, { 'System.State': 'Removed' }));
    expect((await p.getItem('1'))!.removed).toBe(true);
    const meta = await p.projectMeta('Web');
    expect(meta.types).toEqual(['Bug', 'Task']);
    expect(meta.statuses.find((s) => s.name === 'Done')).toMatchObject({
      category: 'done',
      types: ['Task'],
    });
  });

  it('falls back to polling when hooks are not allowed', async () => {
    const { p } = azure((c) => {
      if (c.url.pathname.endsWith('/_apis/projects'))
        return { value: [{ id: 'pid', name: 'Web' }] };
      return new Response('{}', { status: 403 });
    });
    expect(
      await p.createWebhook({ project: 'Web', types: [], filter: '' }, 'https://x/y'),
    ).toBeNull();
  });

  it('subscribes to three events', async () => {
    let n = 0;
    const { p, calls } = azure((c) => {
      if (c.url.pathname.endsWith('/_apis/projects'))
        return { value: [{ id: 'pid', name: 'Web' }] };
      return { id: `h${++n}` };
    });
    expect(await p.createWebhook({ project: 'Web', types: [], filter: '' }, 'https://x/y')).toBe(
      'h1,h2,h3',
    );
    const body = calls.at(-1)!.body as {
      publisherInputs: { projectId: string };
      consumerInputs: { url: string };
    };
    expect(body.publisherInputs.projectId).toBe('pid');
    expect(body.consumerInputs.url).toBe('https://x/y');
  });

  it('reads the id from either webhook shape', () => {
    const { p } = azure(() => ({}));
    expect(p.webhookItems({ resource: { workItemId: 4, id: 99 } })).toEqual(['4']);
    expect(p.webhookItems({ resource: { id: 5 } })).toEqual(['5']);
    expect(p.webhookItems(null)).toEqual([]);
  });

  it('treats the sign-in page of a bad token as an auth failure', async () => {
    const { f } = fake(() => new Response('<html>sign in</html>', { status: 203 }));
    const p = new AzureProvider(
      new Http('https://dev.azure.com/o', async () => 'x', f, NOWAIT),
      'https://dev.azure.com/o',
    );
    await expect(p.whoami()).rejects.toMatchObject({ code: 'auth_failed' });
  });
});

const fieldsAnswer = [
  { id: 'customfield_10016', name: 'Story point estimate' },
  { id: 'customfield_10015', name: 'Start date' },
];

const issue = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: 'Başlık',
    description: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Metin' }] }],
    },
    status: { name: 'In Progress' },
    assignee: { emailAddress: 'Ali@X.dev' },
    priority: { name: 'Highest' },
    duedate: '2026-12-01',
    labels: ['a'],
    issuetype: { name: 'Bug' },
    project: { key: 'ABC' },
    updated: '2026-11-10T10:00:00.000+0300',
    comment: { total: 1 },
    customfield_10016: 5,
    customfield_10015: '2026-11-20',
    ...over,
  },
});

function jira(routes: Route, base = 'https://acme.atlassian.net') {
  const { f, calls } = fake((c) => {
    if (c.url.pathname.endsWith('/field')) return fieldsAnswer;
    if (c.url.pathname.endsWith('/priority'))
      return [{ name: 'Highest' }, { name: 'High' }, { name: 'Medium' }, { name: 'Low' }];
    return routes(c);
  });
  const http = new Http(base, async () => 'Basic x', f, NOWAIT);
  return { p: new JiraProvider(http, base), calls };
}

describe('Jira', () => {
  it('searches with a relative time and pages by token on Cloud', async () => {
    let page = 0;
    const { p, calls } = jira(() =>
      page++ === 0
        ? { issues: [issue('ABC-1')], nextPageToken: 'n' }
        : { issues: [issue('ABC-2')] },
    );
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const items = await p.changedSince(
      { project: 'ABC', types: ['Bug'], filter: 'labels = x' },
      since,
      50,
    );
    const search = calls.filter((c) => c.url.pathname.endsWith('/search/jql'));
    expect(search).toHaveLength(2);
    expect(search[1]!.url.searchParams.get('nextPageToken')).toBe('n');
    const jql = search[0]!.url.searchParams.get('jql')!;
    expect(jql).toContain('project = "ABC"');
    expect(jql).toContain('issuetype IN ("Bug")');
    expect(jql).toContain('(labels = x)');
    expect(jql).toMatch(/updated >= "-1[0-2]m"/);
    expect(items[0]).toMatchObject({
      id: 'ABC-1',
      key: 'ABC-1',
      url: 'https://acme.atlassian.net/browse/ABC-1',
      type: 'Bug',
      project: 'ABC',
      commentCount: 1,
    });
    expect(items[0]!.fields).toMatchObject({
      title: 'Başlık',
      description: 'Metin',
      status: 'In Progress',
      assignee: 'ali@x.dev',
      priority: 'p1',
      dueDate: '2026-12-01',
      startDate: '2026-11-20',
      points: 5,
    });
    expect(items[0]!.updatedAt).toBe('2026-11-10T07:00:00.000Z');
  });

  it('cannot say who a hidden assignee is, but knows when there is none', async () => {
    const { p } = jira(() => issue('ABC-1', { assignee: { displayName: 'Gizli' } }));
    expect((await p.getItem('ABC-1'))!.fields.assignee).toBeUndefined();
    const none = jira(() => issue('ABC-1', { assignee: null }));
    expect((await none.p.getItem('ABC-1'))!.fields.assignee).toBeNull();
  });

  it('writes a document on Cloud and moves status by transition', async () => {
    const { p, calls } = jira((c) => {
      if (c.url.pathname.endsWith('/transitions') && c.method === 'GET') {
        return { transitions: [{ id: '31', to: { name: 'Done' } }] };
      }
      if (c.url.pathname.endsWith('/user/search'))
        return [{ accountId: 'acc1', emailAddress: 'ayse@x.dev' }];
      return issue('ABC-1');
    });
    const item = (await p.getItem('ABC-1'))!;
    await p.updateItem(item, {
      description: 'Yeni',
      status: 'Done',
      assignee: 'ayse@x.dev',
      priority: 'p3',
      points: 8,
      labels: ['iki kelime'],
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    const fields = (put.body as { fields: Record<string, unknown> }).fields;
    expect(fields.description).toMatchObject({ type: 'doc', version: 1 });
    expect(fields.assignee).toEqual({ accountId: 'acc1' });
    expect(fields.priority).toEqual({ name: 'Low' });
    expect(fields.customfield_10016).toBe(8);
    expect(fields.labels).toEqual(['iki-kelime']);
    const move = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/transitions'))!;
    expect(move.body).toEqual({ transition: { id: '31' } });
  });

  it('reports a move the workflow forbids', async () => {
    const { p } = jira((c) =>
      c.url.pathname.endsWith('/transitions') ? { transitions: [] } : issue('ABC-1'),
    );
    const item = (await p.getItem('ABC-1'))!;
    await expect(p.updateItem(item, { status: 'Done' })).rejects.toMatchObject({
      code: 'no_transition',
    });
  });

  it('speaks REST v2 and wiki text to Data Center', async () => {
    const { p, calls } = jira((c) => {
      if (c.url.pathname.endsWith('/search'))
        return { issues: [issue('ABC-1', { description: 'h1. B\n* x' })], total: 1 };
      return issue('ABC-1', { description: 'x' });
    }, 'https://jira.acme.com');
    const items = await p.changedSince({ project: 'ABC', types: [], filter: '' }, null, 10);
    expect(calls.at(-1)!.url.pathname).toBe('/rest/api/2/search');
    expect(items[0]!.fields.description).toBe('B\n- x');
    await p.updateItem(items[0]!, { description: 'düz' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect((put.body as { fields: { description: string } }).fields.description).toBe('düz');
  });

  it('keeps polling when only an administrator could add a webhook', async () => {
    const { p } = jira(() => new Response('{}', { status: 403 }));
    expect(
      await p.createWebhook({ project: 'ABC', types: [], filter: '' }, 'https://x'),
    ).toBeNull();
  });

  it('pages comments and reads the webhook key', async () => {
    const { p } = jira(() => ({
      comments: [
        {
          id: '1',
          body: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Y' }] }],
          },
          created: 'c',
          author: { displayName: 'A' },
        },
      ],
      total: 1,
    }));
    expect(await p.listComments({ id: 'ABC-1' } as ExternalItem)).toEqual([
      { id: '1', author: 'A', text: 'Y', createdAt: 'c' },
    ]);
    expect(p.webhookItems({ issue: { key: 'ABC-9' } })).toEqual(['ABC-9']);
    expect(p.webhookItems({})).toEqual([]);
  });
});

describe('http', () => {
  it('waits and retries when throttled', async () => {
    let n = 0;
    const waits: number[] = [];
    const { f } = fake(() =>
      n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : { ok: true },
    );
    const http = new Http(
      'https://x',
      async () => 'a',
      f,
      async (ms) => void waits.push(ms),
    );
    await expect(http.request('GET', '/y')).resolves.toEqual({ ok: true });
    expect(waits).toEqual([3000]);
  });

  it('gives the service words but no token', async () => {
    const { f } = fake(
      () => new Response(JSON.stringify({ errorMessages: ['Alan geçersiz'] }), { status: 400 }),
    );
    const http = new Http('https://x', async () => 'SECRET', f, NOWAIT);
    const err = (await http.request('GET', '/y').catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe('rejected');
    expect(err.message).toBe('Alan geçersiz');
  });

  it('accepts only clean https addresses', () => {
    expect(cleanBaseUrl(' https://dev.azure.com/org/ ', false)).toBe('https://dev.azure.com/org');
    expect(() => cleanBaseUrl('http://x.com', false)).toThrow(ProviderError);
    expect(() => cleanBaseUrl('https://u:p@x.com', false)).toThrow(ProviderError);
    expect(() => cleanBaseUrl('https://x.com/?a=1', false)).toThrow(ProviderError);
    expect(cleanBaseUrl('http://jira.local', true)).toBe('http://jira.local');
  });

  it('knows private addresses, mapped ones too', () => {
    for (const ip of [
      '10.1.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '192.168.1.5',
      '172.20.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '13.107.42.20', '2606:4700::1'])
      expect(isPrivateAddress(ip)).toBe(false);
  });

  it('encodes credentials', () => {
    expect(toBasic('', 'pat')).toBe(`Basic ${Buffer.from(':pat').toString('base64')}`);
  });
});
