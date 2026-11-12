import { htmlToText, textToHtml } from '../text';
import {
  ProviderError,
  type ExternalComment,
  type ExternalItem,
  type Fields,
  type FieldsPatch,
  type Priority,
  type ProjectMeta,
  type Provider,
  type Scope,
  type StatusCategory,
} from '../types';
import { AzureOps } from './azure-ops';
import type { Http } from './http';

/**
 * Azure DevOps Services and Server 2022+. Which fields a work item has depends on its type and
 * the project's process (Story Points on Agile, Effort on Scrum, Size on CMMI), so every read
 * and write goes through the type's own field list.
 */

const API = '7.0';
const COMMENTS_API = '7.0-preview.3';
const META_TTL_MS = 10 * 60_000;

const F = {
  title: 'System.Title',
  description: 'System.Description',
  repro: 'Microsoft.VSTS.TCM.ReproSteps',
  state: 'System.State',
  assigned: 'System.AssignedTo',
  priority: 'Microsoft.VSTS.Common.Priority',
  tags: 'System.Tags',
  type: 'System.WorkItemType',
  project: 'System.TeamProject',
  changed: 'System.ChangedDate',
  comments: 'System.CommentCount',
  due: ['Microsoft.VSTS.Scheduling.DueDate', 'Microsoft.VSTS.Scheduling.TargetDate'],
  start: ['Microsoft.VSTS.Scheduling.StartDate'],
  points: [
    'Microsoft.VSTS.Scheduling.StoryPoints',
    'Microsoft.VSTS.Scheduling.Effort',
    'Microsoft.VSTS.Scheduling.Size',
  ],
} as const;

interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
}

interface TypeMeta {
  fields: Set<string>;
  states: { name: string; category: StatusCategory }[];
}

const CATEGORY: Record<string, StatusCategory> = {
  Proposed: 'todo',
  InProgress: 'doing',
  Resolved: 'doing',
  Completed: 'done',
  Removed: 'removed',
};

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const seg = encodeURIComponent;
const day = (v: unknown) => (typeof v === 'string' ? v.slice(0, 10) : null);

function priorityOf(v: unknown): Priority | null {
  if (typeof v !== 'number') return null;
  return v <= 1 ? 'p1' : v === 2 ? 'p2' : 'p3';
}

export class AzureProvider implements Provider {
  readonly kind = 'azure' as const;
  private meta = new Map<string, { at: number; types: Map<string, TypeMeta> }>();
  private revs = new Map<string, number>();
  /** Pipelines and the Library, on the same token. */
  readonly ops: AzureOps;

  constructor(
    private readonly http: Http,
    private readonly baseUrl: string,
  ) {
    this.ops = new AzureOps(http);
  }

  async whoami() {
    const r = await this.http.request<{
      authenticatedUser?: {
        providerDisplayName?: string;
        properties?: { Account?: { $value?: string } };
      };
    }>('GET', '/_apis/connectionData');
    const u = r.authenticatedUser;
    if (!u?.providerDisplayName) throw new ProviderError('auth_failed');
    return { name: u.providerDisplayName, email: u.properties?.Account?.$value ?? null };
  }

  async listProjects() {
    const r = await this.http.request<{ value: { id: string; name: string }[] }>(
      'GET',
      '/_apis/projects',
      { query: { $top: 500, 'api-version': API } },
    );
    return r.value.map((p) => ({ id: p.id, key: p.name, name: p.name }));
  }

  private async typeMeta(project: string) {
    const hit = this.meta.get(project);
    if (hit && Date.now() - hit.at < META_TTL_MS) return hit.types;
    const r = await this.http.request<{
      value: {
        name: string;
        isDisabled?: boolean;
        fields?: { referenceName: string }[];
        states?: { name: string; category: string }[];
      }[];
    }>('GET', `/${seg(project)}/_apis/wit/workitemtypes`, { query: { 'api-version': API } });
    const types = new Map<string, TypeMeta>();
    for (const t of r.value) {
      if (t.isDisabled) continue;
      types.set(t.name, {
        fields: new Set((t.fields ?? []).map((f) => f.referenceName)),
        states: (t.states ?? []).map((s) => ({
          name: s.name,
          category: CATEGORY[s.category] ?? 'doing',
        })),
      });
    }
    this.meta.set(project, { at: Date.now(), types });
    return types;
  }

  async projectMeta(project: string): Promise<ProjectMeta> {
    const types = await this.typeMeta(project);
    const statuses = new Map<string, ProjectMeta['statuses'][number]>();
    for (const [type, m] of types) {
      for (const s of m.states) {
        const row = statuses.get(s.name) ?? { name: s.name, category: s.category, types: [] };
        row.types.push(type);
        statuses.set(s.name, row);
      }
    }
    return { types: [...types.keys()].sort(), statuses: [...statuses.values()] };
  }

  private fieldOf(meta: TypeMeta | undefined, names: readonly string[]) {
    return names.find((n) => meta?.fields.has(n));
  }

  private descriptionField(type: string, meta: TypeMeta | undefined) {
    return type === 'Bug' && meta?.fields.has(F.repro) ? F.repro : F.description;
  }

  private async toItem(w: WorkItem): Promise<ExternalItem> {
    const f = w.fields;
    const project = String(f[F.project] ?? '');
    const type = String(f[F.type] ?? '');
    const meta = (await this.typeMeta(project)).get(type);
    const state = String(f[F.state] ?? '');
    const category = meta?.states.find((s) => s.name === state)?.category;
    const read = (names: readonly string[]) => this.fieldOf(meta, names);
    const dueField = read(F.due);
    const startField = read(F.start);
    const pointsField = read(F.points);
    const assigned = f[F.assigned] as { uniqueName?: string } | undefined;
    const fields: Fields = {
      title: String(f[F.title] ?? ''),
      description: htmlToText(String(f[this.descriptionField(type, meta)] ?? '')),
      status: state,
      assignee: assigned ? assigned.uniqueName?.toLowerCase() : null,
      priority: meta?.fields.has(F.priority) ? priorityOf(f[F.priority]) : undefined,
      dueDate: dueField ? day(f[dueField]) : undefined,
      startDate: startField ? day(f[startField]) : undefined,
      labels: String(f[F.tags] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean),
      points: pointsField
        ? typeof f[pointsField] === 'number'
          ? (f[pointsField] as number)
          : null
        : undefined,
    };
    this.revs.set(String(w.id), w.rev);
    return {
      id: String(w.id),
      key: `#${w.id}`,
      url: `${this.baseUrl}/${seg(project)}/_workitems/edit/${w.id}`,
      type,
      project,
      updatedAt: String(f[F.changed] ?? ''),
      commentCount: Number(f[F.comments] ?? 0),
      removed: category === 'removed',
      fields,
    };
  }

  private async batch(ids: number[]): Promise<ExternalItem[]> {
    const out: ExternalItem[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const r = await this.http.request<{ value: WorkItem[] }>(
        'POST',
        '/_apis/wit/workitemsbatch',
        {
          query: { 'api-version': API },
          body: { ids: ids.slice(i, i + 200), errorPolicy: 'omit' },
        },
      );
      for (const w of r.value.filter(Boolean)) out.push(await this.toItem(w));
    }
    const order = new Map(ids.map((id, n) => [String(id), n]));
    return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  private async wiql(project: string | null, query: string, limit: number) {
    const r = await this.http.request<{ workItems: { id: number }[] }>(
      'POST',
      `${project ? `/${seg(project)}` : ''}/_apis/wit/wiql`,
      {
        query: { 'api-version': API, timePrecision: 'true', $top: limit },
        body: { query },
      },
    );
    return r.workItems.map((w) => w.id);
  }

  async changedSince(scope: Scope, since: string | null, limit: number) {
    const conditions = [`[${F.project}] = @project`];
    if (scope.types.length) {
      conditions.push(`[${F.type}] IN (${scope.types.map(quote).join(', ')})`);
    }
    if (since) conditions.push(`[${F.changed}] >= ${quote(since)}`);
    if (scope.filter.trim()) conditions.push(`(${scope.filter})`);
    const ids = await this.wiql(
      scope.project,
      `SELECT [System.Id] FROM workitems WHERE ${conditions.join(' AND ')} ORDER BY [${F.changed}] ASC`,
      limit,
    );
    return this.batch(ids);
  }

  async getItem(id: string) {
    try {
      const w = await this.http.request<WorkItem>('GET', `/_apis/wit/workitems/${seg(id)}`, {
        query: { 'api-version': API },
      });
      return await this.toItem(w);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_found') return null;
      throw err;
    }
  }

  private patchOps(type: string, meta: TypeMeta | undefined, patch: FieldsPatch) {
    const ops: { op: string; path: string; value?: unknown }[] = [];
    const set = (field: string | undefined, value: unknown) => {
      if (!field || !meta?.fields.has(field)) return;
      if (value === null || value === undefined)
        ops.push({ op: 'remove', path: `/fields/${field}` });
      else ops.push({ op: 'add', path: `/fields/${field}`, value });
    };
    if (patch.title !== undefined) set(F.title, patch.title);
    if (patch.description !== undefined) {
      set(this.descriptionField(type, meta), textToHtml(patch.description));
    }
    if (patch.status !== undefined) set(F.state, patch.status);
    if (patch.assignee !== undefined) set(F.assigned, patch.assignee);
    if (patch.priority !== undefined) {
      if (patch.priority) set(F.priority, Number(patch.priority.slice(1)));
      // Priority is required on most processes: "none" leaves the service's value alone.
    }
    if (patch.dueDate !== undefined) set(this.fieldOf(meta, F.due), patch.dueDate);
    if (patch.startDate !== undefined) set(this.fieldOf(meta, F.start), patch.startDate);
    if (patch.points !== undefined) set(this.fieldOf(meta, F.points), patch.points);
    // Every type has tags, whether or not its field list says so.
    if (patch.labels !== undefined) {
      ops.push({ op: 'add', path: `/fields/${F.tags}`, value: patch.labels.join('; ') });
    }
    return ops;
  }

  async createItem(scope: Scope, type: string, fields: FieldsPatch) {
    const meta = (await this.typeMeta(scope.project)).get(type);
    if (!meta) throw new ProviderError('unknown_type');
    // A new item starts in its type's first state; the state rules allow nothing else.
    const { status, ...rest } = fields;
    const w = await this.http.request<WorkItem>(
      'POST',
      `/${seg(scope.project)}/_apis/wit/workitems/$${seg(type)}`,
      {
        query: { 'api-version': API },
        body: this.patchOps(type, meta, rest),
        contentType: 'application/json-patch+json',
      },
    );
    const item = await this.toItem(w);
    return status && status !== item.fields.status ? this.updateItem(item, { status }) : item;
  }

  async updateItem(item: ExternalItem, patch: FieldsPatch) {
    const meta = (await this.typeMeta(item.project)).get(item.type);
    const ops = this.patchOps(item.type, meta, patch);
    if (!ops.length) return item;
    const rev = this.revs.get(item.id);
    // Someone saved in between: the service answers 412 and the next run merges again.
    const body = rev !== undefined ? [{ op: 'test', path: '/rev', value: rev }, ...ops] : ops;
    const w = await this.http.request<WorkItem>('PATCH', `/_apis/wit/workitems/${seg(item.id)}`, {
      query: { 'api-version': API },
      body,
      contentType: 'application/json-patch+json',
    });
    return this.toItem(w);
  }

  async listComments(item: ExternalItem): Promise<ExternalComment[]> {
    const r = await this.http.request<{
      comments: {
        id: number;
        text: string;
        createdDate: string;
        createdBy?: { displayName?: string };
      }[];
    }>('GET', `/${seg(item.project)}/_apis/wit/workItems/${seg(item.id)}/comments`, {
      query: { 'api-version': COMMENTS_API, $top: 200, order: 'asc' },
    });
    return r.comments.map((c) => ({
      id: String(c.id),
      author: c.createdBy?.displayName ?? '',
      text: htmlToText(c.text),
      createdAt: c.createdDate,
    }));
  }

  async addComment(item: ExternalItem, text: string) {
    const r = await this.http.request<{ id: number }>(
      'POST',
      `/${seg(item.project)}/_apis/wit/workItems/${seg(item.id)}/comments`,
      { query: { 'api-version': COMMENTS_API }, body: { text: textToHtml(text) } },
    );
    return String(r.id);
  }

  async assignedToMe(limit: number) {
    const ids = await this.wiql(
      null,
      `SELECT [System.Id] FROM workitems WHERE [${F.assigned}] = @Me AND [${F.state}] NOT IN ('Closed','Done','Removed','Completed') ORDER BY [${F.changed}] DESC`,
      limit,
    );
    return this.batch(ids);
  }

  async search(text: string, limit: number) {
    const ids = await this.wiql(
      null,
      `SELECT [System.Id] FROM workitems WHERE [${F.title}] CONTAINS ${quote(text)} ORDER BY [${F.changed}] DESC`,
      limit,
    );
    return this.batch(ids);
  }

  async createWebhook(scope: Scope, url: string) {
    const projects = await this.listProjects();
    const project = projects.find((p) => p.key === scope.project);
    if (!project) return null;
    const ids: string[] = [];
    try {
      for (const eventType of ['workitem.created', 'workitem.updated', 'workitem.deleted']) {
        const r = await this.http.request<{ id: string }>('POST', '/_apis/hooks/subscriptions', {
          query: { 'api-version': API },
          body: {
            publisherId: 'tfs',
            eventType,
            resourceVersion: '1.0',
            consumerId: 'webHooks',
            consumerActionId: 'httpRequest',
            publisherInputs: { projectId: project.id },
            consumerInputs: { url },
          },
        });
        ids.push(r.id);
      }
    } catch (err) {
      await this.removeWebhook(ids.join(',')).catch(() => undefined);
      if (err instanceof ProviderError && ['forbidden', 'auth_failed'].includes(err.code)) {
        return null;
      }
      throw err;
    }
    return ids.join(',');
  }

  async removeWebhook(id: string) {
    for (const one of id.split(',').filter(Boolean)) {
      await this.http.request('DELETE', `/_apis/hooks/subscriptions/${seg(one)}`, {
        query: { 'api-version': API },
      });
    }
  }

  webhookItems(body: unknown): string[] {
    const res = (body as { resource?: { workItemId?: number; id?: number } } | null)?.resource;
    const id = res?.workItemId ?? res?.id;
    return typeof id === 'number' ? [String(id)] : [];
  }
}
