import { adfToText, textToAdf, wikiToText } from '../text';
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
import type { Http } from './http';

/**
 * Jira Cloud (REST v3, documents, account ids) and Data Center (REST v2, wiki text, user names).
 * Status is never a field in Jira: a change goes through a workflow transition, and a move the
 * workflow does not allow comes back as `no_transition` for the sync log.
 */

interface Issue {
  key: string;
  fields: Record<string, unknown>;
}

const P1 = /highest|blocker|critical|high|major|urgent/i;
const P3 = /lowest|trivial|minor|low/i;

function priorityOf(name: unknown): Priority | null {
  if (typeof name !== 'string' || !name) return null;
  if (P1.test(name)) return 'p1';
  if (P3.test(name)) return 'p3';
  return 'p2';
}

const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
const seg = encodeURIComponent;
const CATEGORY: Record<string, StatusCategory> = {
  new: 'todo',
  indeterminate: 'doing',
  done: 'done',
};

export function isJiraCloud(baseUrl: string) {
  return /\.(atlassian\.net|jira\.com)$/i.test(new URL(baseUrl).hostname);
}

export class JiraProvider implements Provider {
  readonly kind = 'jira' as const;
  private readonly api: string;
  private customFields: Promise<{ points?: string; start?: string }> | null = null;
  private priorities: Promise<string[]> | null = null;
  private readonly users = new Map<string, string | null>();

  constructor(
    private readonly http: Http,
    private readonly baseUrl: string,
    private readonly cloud = isJiraCloud(baseUrl),
  ) {
    this.api = cloud ? '/rest/api/3' : '/rest/api/2';
  }

  async whoami() {
    const r = await this.http.request<{
      displayName?: string;
      emailAddress?: string;
    }>('GET', `${this.api}/myself`);
    if (!r?.displayName) throw new ProviderError('auth_failed');
    return { name: r.displayName, email: r.emailAddress ?? null };
  }

  async listProjects() {
    const rows: { id: string; key: string; name: string }[] = [];
    if (!this.cloud) {
      return this.http.request<typeof rows>('GET', `${this.api}/project`);
    }
    for (let startAt = 0; ; startAt += 50) {
      const r = await this.http.request<{ values: typeof rows; isLast?: boolean }>(
        'GET',
        `${this.api}/project/search`,
        { query: { startAt, maxResults: 50 } },
      );
      rows.push(...r.values);
      if (r.isLast !== false || !r.values.length) return rows;
    }
  }

  async projectMeta(project: string): Promise<ProjectMeta> {
    const r = await this.http.request<
      {
        name: string;
        subtask?: boolean;
        statuses: { name: string; statusCategory?: { key?: string } }[];
      }[]
    >('GET', `${this.api}/project/${seg(project)}/statuses`);
    const statuses = new Map<string, ProjectMeta['statuses'][number]>();
    for (const t of r) {
      for (const s of t.statuses) {
        const row = statuses.get(s.name) ?? {
          name: s.name,
          category: CATEGORY[s.statusCategory?.key ?? ''] ?? 'doing',
          types: [],
        };
        row.types.push(t.name);
        statuses.set(s.name, row);
      }
    }
    return { types: r.map((t) => t.name).sort(), statuses: [...statuses.values()] };
  }

  /** "Story Points" and "Start date" are custom fields with an id per site. */
  private custom() {
    this.customFields ??= this.http
      .request<{ id: string; name: string }[]>('GET', `${this.api}/field`)
      .then((all) => {
        const byName = (names: RegExp) => all.find((f) => names.test(f.name))?.id;
        return {
          points: byName(/^story points?( estimate)?$/i),
          start: byName(/^start date$/i),
        };
      })
      .catch((err: unknown) => {
        this.customFields = null;
        throw err;
      });
    return this.customFields;
  }

  private fieldList(custom: { points?: string; start?: string }) {
    return [
      'summary',
      'description',
      'status',
      'assignee',
      'priority',
      'duedate',
      'labels',
      'issuetype',
      'project',
      'updated',
      'comment',
      ...(custom.points ? [custom.points] : []),
      ...(custom.start ? [custom.start] : []),
    ].join(',');
  }

  private toItem(issue: Issue, custom: { points?: string; start?: string }): ExternalItem {
    const f = issue.fields;
    const status = f.status as { name?: string; statusCategory?: { key?: string } } | undefined;
    const assignee = f.assignee as { emailAddress?: string } | null | undefined;
    const description = this.cloud
      ? adfToText(f.description)
      : wikiToText(typeof f.description === 'string' ? f.description : '');
    const points = custom.points ? f[custom.points] : undefined;
    const fields: Fields = {
      title: String(f.summary ?? ''),
      description,
      status: status?.name ?? '',
      // Jira Cloud may hide e-mail addresses: then it cannot say who it is.
      assignee: assignee ? assignee.emailAddress?.toLowerCase() : null,
      priority:
        f.priority === undefined
          ? undefined
          : priorityOf((f.priority as { name?: string } | null)?.name),
      dueDate: typeof f.duedate === 'string' ? f.duedate : null,
      startDate: custom.start
        ? typeof f[custom.start] === 'string'
          ? (f[custom.start] as string).slice(0, 10)
          : null
        : undefined,
      labels: Array.isArray(f.labels) ? (f.labels as string[]) : [],
      points: custom.points ? (typeof points === 'number' ? Math.round(points) : null) : undefined,
    };
    return {
      id: issue.key,
      key: issue.key,
      url: `${this.baseUrl}/browse/${issue.key}`,
      type: String((f.issuetype as { name?: string } | undefined)?.name ?? ''),
      project: String((f.project as { key?: string } | undefined)?.key ?? issue.key.split('-')[0]),
      updatedAt: new Date(String(f.updated ?? 0)).toISOString(),
      commentCount: Number((f.comment as { total?: number } | undefined)?.total ?? 0),
      removed: false,
      fields,
    };
  }

  private async searchJql(jql: string, limit: number): Promise<ExternalItem[]> {
    const custom = await this.custom();
    const fields = this.fieldList(custom);
    const out: Issue[] = [];
    if (this.cloud) {
      let nextPageToken: string | undefined;
      while (out.length < limit) {
        const r: { issues: Issue[]; nextPageToken?: string } = await this.http.request(
          'GET',
          `${this.api}/search/jql`,
          { query: { jql, fields, maxResults: Math.min(100, limit - out.length), nextPageToken } },
        );
        out.push(...r.issues);
        nextPageToken = r.nextPageToken;
        if (!nextPageToken || !r.issues.length) break;
      }
    } else {
      while (out.length < limit) {
        const r: { issues: Issue[]; total?: number } = await this.http.request(
          'GET',
          `${this.api}/search`,
          {
            query: {
              jql,
              fields,
              startAt: out.length,
              maxResults: Math.min(100, limit - out.length),
            },
          },
        );
        out.push(...r.issues);
        if (!r.issues.length || out.length >= (r.total ?? 0)) break;
      }
    }
    return out.map((i) => this.toItem(i, custom));
  }

  async changedSince(scope: Scope, since: string | null, limit: number) {
    const parts = [`project = ${quote(scope.project)}`];
    if (scope.types.length) parts.push(`issuetype IN (${scope.types.map(quote).join(', ')})`);
    if (scope.filter.trim()) parts.push(`(${scope.filter})`);
    if (since) {
      // A relative time: JQL reads absolute ones in the API user's own time zone.
      const minutes = Math.ceil((Date.now() - Date.parse(since)) / 60_000) + 1;
      parts.push(`updated >= "-${minutes}m"`);
    }
    return this.searchJql(`${parts.join(' AND ')} ORDER BY updated ASC`, limit);
  }

  async getItem(id: string) {
    const custom = await this.custom();
    try {
      const i = await this.http.request<Issue>('GET', `${this.api}/issue/${seg(id)}`, {
        query: { fields: this.fieldList(custom) },
      });
      return this.toItem(i, custom);
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'not_found') return null;
      throw err;
    }
  }

  private async priorityName(p: Priority) {
    this.priorities ??= this.http
      .request<{ name: string }[]>('GET', `${this.api}/priority`)
      .then((all) => all.map((x) => x.name));
    const names = await this.priorities;
    return (
      names.find((n) => priorityOf(n) === p && /^(high|medium|low)$/i.test(n)) ??
      names.find((n) => priorityOf(n) === p)
    );
  }

  /** Who an e-mail is here: an account id on Cloud, a user name on Data Center. */
  private async userRef(email: string): Promise<Record<string, string> | null> {
    if (!this.users.has(email)) {
      const r = await this.http.request<
        { accountId?: string; name?: string; emailAddress?: string }[]
      >('GET', `${this.api}/user/search`, {
        query: this.cloud ? { query: email } : { username: email },
      });
      const hit =
        r.find((u) => u.emailAddress?.toLowerCase() === email) ??
        (r.length === 1 ? r[0] : undefined);
      this.users.set(email, (this.cloud ? hit?.accountId : hit?.name) ?? null);
    }
    const id = this.users.get(email);
    if (!id) return null;
    return this.cloud ? { accountId: id } : { name: id };
  }

  private async toJiraFields(patch: FieldsPatch) {
    const custom = await this.custom();
    const out: Record<string, unknown> = {};
    if (patch.title !== undefined) out.summary = patch.title;
    if (patch.description !== undefined) {
      out.description = this.cloud ? textToAdf(patch.description) : patch.description;
    }
    if (patch.dueDate !== undefined) out.duedate = patch.dueDate;
    if (patch.labels !== undefined) out.labels = patch.labels.map((l) => l.replace(/\s+/g, '-'));
    if (patch.priority) {
      const name = await this.priorityName(patch.priority);
      if (name) out.priority = { name };
    }
    if (patch.points !== undefined && custom.points) out[custom.points] = patch.points;
    if (patch.startDate !== undefined && custom.start) out[custom.start] = patch.startDate;
    if (patch.assignee !== undefined) {
      if (patch.assignee === null) out.assignee = this.cloud ? { accountId: null } : { name: null };
      else {
        const ref = await this.userRef(patch.assignee);
        if (ref) out.assignee = ref;
      }
    }
    return out;
  }

  private async transition(key: string, status: string) {
    const r = await this.http.request<{ transitions: { id: string; to: { name: string } }[] }>(
      'GET',
      `${this.api}/issue/${seg(key)}/transitions`,
    );
    const t = r.transitions.find((x) => x.to.name.toLowerCase() === status.toLowerCase());
    if (!t) throw new ProviderError('no_transition', undefined, status);
    await this.http.request('POST', `${this.api}/issue/${seg(key)}/transitions`, {
      body: { transition: { id: t.id } },
    });
  }

  async createItem(scope: Scope, type: string, fields: FieldsPatch) {
    const { status, ...rest } = fields;
    const body = {
      fields: {
        project: { key: scope.project },
        issuetype: { name: type },
        ...(await this.toJiraFields(rest)),
      },
    };
    const r = await this.http.request<{ key: string }>('POST', `${this.api}/issue`, { body });
    if (status) await this.transition(r.key, status).catch(() => undefined);
    const item = await this.getItem(r.key);
    if (!item) throw new ProviderError('not_found');
    return item;
  }

  async updateItem(item: ExternalItem, patch: FieldsPatch) {
    const { status, ...rest } = patch;
    const fields = await this.toJiraFields(rest);
    if (Object.keys(fields).length) {
      await this.http.request('PUT', `${this.api}/issue/${seg(item.id)}`, { body: { fields } });
    }
    if (status !== undefined && status !== item.fields.status) {
      await this.transition(item.id, status);
    }
    const fresh = await this.getItem(item.id);
    if (!fresh) throw new ProviderError('not_found');
    return fresh;
  }

  async listComments(item: ExternalItem): Promise<ExternalComment[]> {
    const out: ExternalComment[] = [];
    for (let startAt = 0; ;) {
      const r = await this.http.request<{
        comments: {
          id: string;
          body: unknown;
          created: string;
          author?: { displayName?: string };
        }[];
        total: number;
      }>('GET', `${this.api}/issue/${seg(item.id)}/comment`, {
        query: { startAt, maxResults: 100 },
      });
      for (const c of r.comments) {
        out.push({
          id: c.id,
          author: c.author?.displayName ?? '',
          text: this.cloud ? adfToText(c.body) : wikiToText(String(c.body ?? '')),
          createdAt: c.created,
        });
      }
      startAt += r.comments.length;
      if (!r.comments.length || startAt >= r.total) return out;
    }
  }

  async addComment(item: ExternalItem, text: string) {
    const r = await this.http.request<{ id: string }>(
      'POST',
      `${this.api}/issue/${seg(item.id)}/comment`,
      { body: { body: this.cloud ? textToAdf(text) : text } },
    );
    return r.id;
  }

  assignedToMe(limit: number) {
    return this.searchJql(
      'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      limit,
    );
  }

  search(text: string, limit: number) {
    return this.searchJql(`text ~ ${quote(text)} ORDER BY updated DESC`, limit);
  }

  async createWebhook(scope: Scope, url: string) {
    try {
      const r = await this.http.request<{ self?: string }>('POST', '/rest/webhooks/1.0/webhook', {
        body: {
          name: `Crewhall ${scope.project}`,
          url,
          events: [
            'jira:issue_created',
            'jira:issue_updated',
            'jira:issue_deleted',
            'comment_created',
          ],
          filters: { 'issue-related-events-section': `project = ${quote(scope.project)}` },
          excludeBody: false,
        },
      });
      return r.self?.split('/').pop() ?? null;
    } catch (err) {
      // Needs a Jira administrator; a normal token keeps working by polling.
      if (
        err instanceof ProviderError &&
        ['forbidden', 'auth_failed', 'not_found'].includes(err.code)
      ) {
        return null;
      }
      throw err;
    }
  }

  async removeWebhook(id: string) {
    await this.http.request('DELETE', `/rest/webhooks/1.0/webhook/${seg(id)}`);
  }

  webhookItems(body: unknown): string[] {
    const key = (body as { issue?: { key?: unknown } } | null)?.issue?.key;
    return typeof key === 'string' ? [key] : [];
  }
}
