import { describe, expect, it } from 'vitest';
import { AzureOps } from '../src/providers/azure-ops';
import { Http, type FetchLike } from '../src/providers/http';

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

function fake(route: (call: Call) => unknown | Response) {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = route(call);
    return out instanceof Response ? out : new Response(JSON.stringify(out ?? {}), { status: 200 });
  }) as unknown as FetchLike;
  const http = new Http(
    'https://dev.azure.com/org',
    async () => 'Basic x',
    f,
    async () => undefined,
  );
  return { ops: new AzureOps(http), calls };
}

const build = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  buildNumber: `2026.${id}`,
  status: 'completed',
  result: 'succeeded',
  sourceBranch: 'refs/heads/main',
  queueTime: '2026-11-10T10:00:00Z',
  requestedFor: { displayName: 'Ali' },
  definition: { id: 7, name: 'CI' },
  _links: { web: { href: 'https://dev.azure.com/org/Web/_build/results?buildId=1' } },
  ...over,
});

describe('pipelines', () => {
  it('lists definitions by name with their latest run in plain terms', async () => {
    const { ops, calls } = fake(() => ({
      value: [
        { id: 2, name: 'Zeta', path: '\\', queueStatus: 'paused' },
        { id: 1, name: 'Alfa', path: '\\ops\\deploy', latestBuild: build(9) },
      ],
    }));
    const list = await ops.pipelines('Web App');
    expect(calls[0]!.url.pathname).toBe('/org/Web%20App/_apis/build/definitions');
    expect(calls[0]!.url.searchParams.get('includeLatestBuilds')).toBe('true');
    expect(list.map((p) => p.name)).toEqual(['Alfa', 'Zeta']);
    expect(list[0]).toMatchObject({ folder: 'ops\\deploy', paused: false });
    expect(list[0]!.latest).toMatchObject({
      id: 9,
      branch: 'main',
      requestedBy: 'Ali',
      result: 'succeeded',
    });
    expect(list[1]).toMatchObject({ paused: true, latest: null });
  });

  it('asks only for what is running when told to', async () => {
    const { ops, calls } = fake(() => ({
      value: [build(1, { status: 'inProgress', result: undefined })],
    }));
    const [run] = await ops.builds('Web', { active: true, top: 30 });
    expect(calls[0]!.url.searchParams.get('statusFilter')).toBe('inProgress,notStarted,cancelling');
    expect(calls[0]!.url.searchParams.get('$top')).toBe('30');
    expect(calls[0]!.url.searchParams.has('definitions')).toBe(false);
    expect(run).toMatchObject({ status: 'inProgress', result: null });
  });

  it('filters runs by pipeline', async () => {
    const { ops, calls } = fake(() => ({ value: [] }));
    await ops.builds('Web', { definitionId: 7 });
    expect(calls[0]!.url.searchParams.get('definitions')).toBe('7');
    expect(calls[0]!.url.searchParams.has('statusFilter')).toBe(false);
  });

  it('starts a run on a branch, spelled the way Azure wants it', async () => {
    const { ops, calls } = fake(() => build(3, { status: 'notStarted', result: undefined }));
    const run = await ops.run('Web', 7, 'feature/x');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/org/Web/_apis/build/builds');
    expect(calls[0]!.body).toEqual({ definition: { id: 7 }, sourceBranch: 'refs/heads/feature/x' });
    expect(run.id).toBe(3);
  });

  it('leaves a full ref alone and an empty branch to the pipeline', async () => {
    const { ops, calls } = fake(() => build(3));
    await ops.run('Web', 7, 'refs/tags/v1');
    await ops.run('Web', 7, '');
    expect(calls[0]!.body).toEqual({ definition: { id: 7 }, sourceBranch: 'refs/tags/v1' });
    expect(calls[1]!.body).toEqual({ definition: { id: 7 } });
  });

  it('cancels a run', async () => {
    const { ops, calls } = fake(() => ({}));
    await ops.cancel('Web', 12);
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { status: 'cancelling' } });
    expect(calls[0]!.url.pathname).toBe('/org/Web/_apis/build/builds/12');
  });

  it('retries only what failed in a stage', async () => {
    const { ops, calls } = fake(() => ({}));
    await ops.retryStage('Web', 12, 'Deploy Prod');
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe('/org/Web/_apis/build/builds/12/stages/Deploy%20Prod');
    expect(calls[0]!.body).toEqual({ state: 'retry', forceRetryAllJobs: false });
  });

  it('builds the stage, job and step tree, skipping phases', async () => {
    const rec = (id: string, parentId: string | null, type: string, order: number, extra = {}) => ({
      id,
      parentId,
      type,
      name: id,
      order,
      state: 'completed',
      result: 'succeeded',
      ...extra,
    });
    const { ops } = fake(() => ({
      records: [
        rec('step2', 'job1', 'Task', 2),
        rec('step1', 'job1', 'Task', 1, { result: 'failed', log: { id: 44 } }),
        rec('job1', 'phase1', 'Job', 1, { log: { id: 40 } }),
        rec('phase1', 'stageB', 'Phase', 1),
        rec('stageB', null, 'Stage', 2, { identifier: 'Deploy', result: 'failed' }),
        rec('stageA', null, 'Stage', 1, { identifier: 'Build' }),
      ],
    }));
    const stages = await ops.timeline('Web', 5);
    expect(stages.map((s) => s.name)).toEqual(['stageA', 'stageB']);
    expect(stages[0]!.jobs).toEqual([]);
    expect(stages[1]).toMatchObject({ identifier: 'Deploy', result: 'failed' });
    expect(stages[1]!.jobs.map((j) => j.name)).toEqual(['job1']);
    expect(stages[1]!.jobs[0]!.steps.map((s) => s.name)).toEqual(['step1', 'step2']);
    expect(stages[1]!.jobs[0]!.steps[0]!.logId).toBe(44);
  });

  it('has nothing to show for a run without a timeline', async () => {
    const { ops } = fake(() => null);
    await expect(ops.timeline('Web', 5)).resolves.toEqual([]);
  });

  it('keeps the end of a long log and says so', async () => {
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`);
    const { ops, calls } = fake(() => ({ value: lines }));
    const log = await ops.log('Web', 5, 44);
    expect(calls[0]!.url.pathname).toBe('/org/Web/_apis/build/builds/5/logs/44');
    expect(log.truncated).toBe(true);
    expect(log.lines).toHaveLength(500);
    expect(log.lines.at(-1)).toBe('line 599');
    const short = fake(() => ({ value: ['a'] }));
    await expect(short.ops.log('Web', 5, 44)).resolves.toEqual({ lines: ['a'], truncated: false });
  });

  it('lists pending approvals and sends a decision', async () => {
    const { ops, calls } = fake((c) =>
      c.method === 'GET'
        ? {
            value: [
              {
                id: 'a1',
                instructions: 'Üretime çıkış',
                pipeline: { name: 'CD', owner: { id: 9, name: '2026.9' } },
              },
            ],
          }
        : {},
    );
    const list = await ops.approvals('Web');
    expect(calls[0]!.url.searchParams.get('state')).toBe('pending');
    expect(list).toEqual([
      {
        id: 'a1',
        createdOn: null,
        instructions: 'Üretime çıkış',
        pipeline: 'CD',
        run: '2026.9',
        buildId: 9,
      },
    ]);
    await ops.decide('Web', 'a1', 'rejected', 'hayır');
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      body: [{ approvalId: 'a1', status: 'rejected', comment: 'hayır' }],
    });
  });
});

const group = (over: Record<string, unknown> = {}) => ({
  id: 4,
  name: 'prod',
  description: 'd',
  type: 'Vsts',
  variables: {
    URL: { value: 'https://x', isSecret: false },
    KEY: { value: null, isSecret: true },
  },
  providerData: null,
  variableGroupProjectReferences: [{ name: 'prod', projectReference: { id: 'p' } }],
  ...over,
});

describe('library', () => {
  /** Answers GET with `current` and PUT with what was sent, like Azure. */
  const library = (current = group()) =>
    fake((c) => {
      if (c.method === 'PUT') return { id: 4, ...(c.body as object) };
      return current;
    });

  it('lists groups by name and never gives a secret a value', async () => {
    const { ops } = fake(() => ({
      value: [
        group({
          name: 'zeta',
          // Even if a server sent one back, it does not leave here.
          variables: { KEY: { value: 'gizli-deger', isSecret: true }, A: { value: 'x' } },
        }),
        group({ id: 5, name: 'alfa', type: 'AzureKeyVault', variables: {} }),
      ],
    }));
    const list = await ops.groups('Web');
    expect(list.map((g) => g.name)).toEqual(['alfa', 'zeta']);
    expect(list[0]!.editable).toBe(false);
    expect(list[1]!.editable).toBe(true);
    expect(list[1]!.variables).toEqual([
      { name: 'A', secret: false, value: 'x' },
      { name: 'KEY', secret: true, value: null },
    ]);
    expect(JSON.stringify(list)).not.toContain('gizli-deger');
  });

  it('changes one variable and sends the rest back as it found them', async () => {
    const { ops, calls } = library();
    const out = await ops.setVariable('Web', 4, 'URL', 'https://y', false);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url.pathname).toBe('/org/_apis/distributedtask/variablegroups/4');
    expect(put.body).toMatchObject({
      name: 'prod',
      type: 'Vsts',
      description: 'd',
      variableGroupProjectReferences: [{ name: 'prod' }],
      variables: {
        URL: { value: 'https://y', isSecret: false },
        KEY: { value: null, isSecret: true },
      },
    });
    expect(out.variables.find((v) => v.name === 'URL')!.value).toBe('https://y');
  });

  it('writes a new secret and does not hand its value back', async () => {
    const { ops, calls } = library();
    const out = await ops.setVariable('Web', 4, 'TOKEN', 'cok-gizli', true);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect((put.body as { variables: Record<string, unknown> }).variables.TOKEN).toEqual({
      value: 'cok-gizli',
      isSecret: true,
    });
    expect(JSON.stringify(out)).not.toContain('cok-gizli');
    expect(out.variables.find((v) => v.name === 'TOKEN')).toEqual({
      name: 'TOKEN',
      secret: true,
      value: null,
    });
  });

  it('replaces a secret, but will not turn one into plain text', async () => {
    const { ops, calls } = library();
    await expect(ops.setVariable('Web', 4, 'KEY', 'yeni', true)).resolves.toBeTruthy();
    await expect(ops.setVariable('Web', 4, 'KEY', 'duz', false)).rejects.toMatchObject({
      code: 'library_secret_stays',
    });
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('removes only the named variable', async () => {
    const { ops, calls } = library();
    await ops.removeVariable('Web', 4, 'URL');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect((put.body as { variables: object }).variables).toEqual({
      KEY: { value: null, isSecret: true },
    });
    await expect(ops.removeVariable('Web', 4, 'YOK')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses to write to a Key Vault group', async () => {
    const { ops, calls } = library(group({ type: 'AzureKeyVault' }));
    await expect(ops.setVariable('Web', 4, 'A', 'b', false)).rejects.toMatchObject({
      code: 'library_read_only',
    });
    await expect(ops.removeVariable('Web', 4, 'URL')).rejects.toMatchObject({
      code: 'library_read_only',
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('says not found when the group is not there', async () => {
    const { ops } = fake(() => ({ value: [] }));
    await expect(ops.setVariable('Web', 4, 'A', 'b', false)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
