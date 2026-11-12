import { ProviderError } from '../types';
import type { Http } from './http';

/**
 * Azure Pipelines and the Library (variable groups), Azure DevOps only. Everything runs on the
 * connection's own token, so Azure decides what this person may do. A secret's value never
 * comes back from Azure and never leaves this file in a response.
 */

const API = '7.0';
const APPROVALS_API = '7.0-preview.1';
const LOG_LINES = 500;
const seg = encodeURIComponent;

interface RawBuild {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  sourceBranch?: string;
  reason?: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  requestedFor?: { displayName?: string };
  definition?: { id: number; name: string };
  _links?: { web?: { href?: string } };
}

export interface BuildView {
  id: number;
  number: string;
  status: string;
  result: string | null;
  branch: string;
  requestedBy: string;
  reason: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  url: string | null;
  definitionId: number | null;
  definitionName: string;
}

const branchOf = (ref: string | undefined) => (ref ?? '').replace(/^refs\/heads\//, '');

function view(b: RawBuild): BuildView {
  return {
    id: b.id,
    number: b.buildNumber,
    status: b.status,
    result: b.result ?? null,
    branch: branchOf(b.sourceBranch),
    requestedBy: b.requestedFor?.displayName ?? '',
    reason: b.reason ?? '',
    queuedAt: b.queueTime ?? null,
    startedAt: b.startTime ?? null,
    finishedAt: b.finishTime ?? null,
    url: b._links?.web?.href ?? null,
    definitionId: b.definition?.id ?? null,
    definitionName: b.definition?.name ?? '',
  };
}

interface RawVariable {
  value?: string | null;
  isSecret?: boolean;
  isReadOnly?: boolean;
}

interface RawGroup {
  id: number;
  name: string;
  description?: string;
  type: string;
  variables: Record<string, RawVariable>;
  modifiedOn?: string;
  modifiedBy?: { displayName?: string };
  providerData?: unknown;
  variableGroupProjectReferences?: unknown;
}

function groupView(g: RawGroup) {
  return {
    id: g.id,
    name: g.name,
    description: g.description ?? '',
    /** Key Vault groups mirror another system and cannot be edited here. */
    editable: g.type === 'Vsts',
    modifiedOn: g.modifiedOn ?? null,
    modifiedBy: g.modifiedBy?.displayName ?? '',
    variables: Object.entries(g.variables)
      .map(([name, v]) => ({
        name,
        secret: !!v.isSecret,
        value: v.isSecret ? null : (v.value ?? ''),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export type GroupView = ReturnType<typeof groupView>;

export class AzureOps {
  constructor(private readonly http: Http) {}

  private project(project: string) {
    return `/${seg(project)}`;
  }

  // ---- pipelines ----

  async pipelines(project: string) {
    const r = await this.http.request<{
      value: {
        id: number;
        name: string;
        path?: string;
        queueStatus?: string;
        latestBuild?: RawBuild;
      }[];
    }>('GET', `${this.project(project)}/_apis/build/definitions`, {
      query: { 'api-version': API, $top: 300, includeLatestBuilds: 'true' },
    });
    return r.value
      .map((d) => ({
        id: d.id,
        name: d.name,
        folder: (d.path ?? '\\').replace(/^\\/, ''),
        paused: d.queueStatus !== undefined && d.queueStatus !== 'enabled',
        latest: d.latestBuild ? view(d.latestBuild) : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async builds(
    project: string,
    filter: { definitionId?: number; active?: boolean; top?: number } = {},
  ) {
    const r = await this.http.request<{ value: RawBuild[] }>(
      'GET',
      `${this.project(project)}/_apis/build/builds`,
      {
        query: {
          'api-version': API,
          $top: filter.top ?? 20,
          queryOrder: 'queueTimeDescending',
          definitions: filter.definitionId,
          statusFilter: filter.active ? 'inProgress,notStarted,cancelling' : undefined,
        },
      },
    );
    return r.value.map(view);
  }

  async run(project: string, definitionId: number, branch: string) {
    const b = await this.http.request<RawBuild>(
      'POST',
      `${this.project(project)}/_apis/build/builds`,
      {
        query: { 'api-version': API },
        body: {
          definition: { id: definitionId },
          ...(branch
            ? { sourceBranch: branch.startsWith('refs/') ? branch : `refs/heads/${branch}` }
            : {}),
        },
      },
    );
    return view(b);
  }

  async cancel(project: string, buildId: number) {
    await this.http.request('PATCH', `${this.project(project)}/_apis/build/builds/${buildId}`, {
      query: { 'api-version': API },
      body: { status: 'cancelling' },
    });
  }

  async retryStage(project: string, buildId: number, stage: string) {
    await this.http.request(
      'PATCH',
      `${this.project(project)}/_apis/build/builds/${buildId}/stages/${seg(stage)}`,
      {
        query: { 'api-version': API },
        body: { state: 'retry', forceRetryAllJobs: false },
      },
    );
  }

  /** Stages, their jobs and each job's steps, in order. */
  async timeline(project: string, buildId: number) {
    const r = await this.http.request<{
      records?: {
        id: string;
        parentId?: string | null;
        type: string;
        name: string;
        identifier?: string;
        state?: string;
        result?: string | null;
        order?: number;
        startTime?: string | null;
        finishTime?: string | null;
        log?: { id: number };
      }[];
    } | null>('GET', `${this.project(project)}/_apis/build/builds/${buildId}/timeline`, {
      query: { 'api-version': API },
    });
    const records = (r?.records ?? []).map((x) => ({
      id: x.id,
      parentId: x.parentId ?? null,
      type: x.type,
      name: x.name,
      identifier: x.identifier ?? null,
      state: x.state ?? 'pending',
      result: x.result ?? null,
      order: x.order ?? 0,
      startedAt: x.startTime ?? null,
      finishedAt: x.finishTime ?? null,
      logId: x.log?.id ?? null,
    }));
    const childrenOf = (id: string) =>
      records.filter((x) => x.parentId === id).sort((a, b) => a.order - b.order);
    return records
      .filter((x) => x.type === 'Stage')
      .sort((a, b) => a.order - b.order)
      .map((stage) => ({
        ...stage,
        // A stage's jobs hang off phases, which mean nothing to the reader.
        jobs: childrenOf(stage.id)
          .flatMap((phase) => (phase.type === 'Phase' ? childrenOf(phase.id) : [phase]))
          .map((job) => ({ ...job, steps: childrenOf(job.id) })),
      }));
  }

  /** The end of a step's log: the part that says why it failed. */
  async log(project: string, buildId: number, logId: number) {
    const r = await this.http.request<{ value: string[] }>(
      'GET',
      `${this.project(project)}/_apis/build/builds/${buildId}/logs/${logId}`,
      { query: { 'api-version': API } },
    );
    return { lines: r.value.slice(-LOG_LINES), truncated: r.value.length > LOG_LINES };
  }

  async approvals(project: string) {
    const r = await this.http.request<{
      value: {
        id: string;
        createdOn?: string;
        instructions?: string;
        pipeline?: { id?: string; name?: string; owner?: { id?: number; name?: string } };
      }[];
    }>('GET', `${this.project(project)}/_apis/pipelines/approvals`, {
      query: { 'api-version': APPROVALS_API, state: 'pending', $expand: 'steps' },
    });
    return r.value.map((a) => ({
      id: a.id,
      createdOn: a.createdOn ?? null,
      instructions: a.instructions ?? '',
      pipeline: a.pipeline?.name ?? '',
      run: a.pipeline?.owner?.name ?? '',
      buildId: a.pipeline?.owner?.id ?? null,
    }));
  }

  async decide(
    project: string,
    approvalId: string,
    status: 'approved' | 'rejected',
    comment: string,
  ) {
    await this.http.request('PATCH', `${this.project(project)}/_apis/pipelines/approvals`, {
      query: { 'api-version': APPROVALS_API },
      body: [{ approvalId, status, comment }],
    });
  }

  // ---- library ----

  async groups(project: string) {
    const r = await this.http.request<{ value: RawGroup[] }>(
      'GET',
      `${this.project(project)}/_apis/distributedtask/variablegroups`,
      { query: { 'api-version': API, queryOrder: 'IdDescending', $top: 200 } },
    );
    return r.value.map(groupView).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async rawGroup(project: string, id: number) {
    const r = await this.http.request<{ value: RawGroup[] } | RawGroup>(
      'GET',
      `${this.project(project)}/_apis/distributedtask/variablegroups/${id}`,
      { query: { 'api-version': API } },
    );
    if (!r || !('variables' in r)) throw new ProviderError('not_found');
    if (r.type !== 'Vsts') throw new ProviderError('library_read_only');
    return r;
  }

  /** Reads, changes one variable, writes back. Azure keeps a secret sent with a null value. */
  private async write(project: string, id: number, change: (g: RawGroup) => void) {
    const g = await this.rawGroup(project, id);
    change(g);
    const saved = await this.http.request<RawGroup>(
      'PUT',
      `/_apis/distributedtask/variablegroups/${id}`,
      {
        query: { 'api-version': API },
        body: {
          name: g.name,
          description: g.description,
          type: g.type,
          variables: g.variables,
          providerData: g.providerData,
          variableGroupProjectReferences: g.variableGroupProjectReferences,
        },
      },
    );
    return groupView(saved);
  }

  setVariable(project: string, id: number, name: string, value: string, secret: boolean) {
    return this.write(project, id, (g) => {
      const current = g.variables[name];
      // Secret stays secret: Azure cannot turn one back into plain text with its value intact.
      if (current?.isSecret && !secret) throw new ProviderError('library_secret_stays');
      g.variables[name] = { value, isSecret: secret };
    });
  }

  removeVariable(project: string, id: number, name: string) {
    return this.write(project, id, (g) => {
      if (!(name in g.variables)) throw new ProviderError('not_found');
      delete g.variables[name];
    });
  }
}
