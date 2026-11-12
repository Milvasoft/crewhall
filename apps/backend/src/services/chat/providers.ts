import { createHmac, timingSafeEqual } from 'node:crypto';
import { resources, type AppLocale } from '@crewhall/i18n';
import type { AlertCard, WebhookProvider } from '@crewhall/shared';
import { fill } from '../../mail/templates';

/**
 * Service integrations on top of incoming webhooks: each service's signature check, which
 * event a request is, and the card it becomes. Requests a channel would not care about
 * (GitHub `ping`, a pull request getting a new commit, an unfinished workflow) are dropped.
 */

export type HeaderOf = (name: string) => string | undefined;

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const hmac = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

/** GitHub: X-Hub-Signature-256; Jira: X-Hub-Signature; Azure DevOps: Basic auth password. */
export function verifySignature(
  provider: WebhookProvider,
  secret: string,
  body: string,
  header: HeaderOf,
): boolean {
  if (provider === 'github') {
    const sig = header('x-hub-signature-256') ?? '';
    return !!sig && safeEqual(sig, hmac(secret, body));
  }
  if (provider === 'jira') {
    const sig = header('x-hub-signature') ?? '';
    return !!sig && safeEqual(sig, hmac(secret, body));
  }
  const auth = header('authorization') ?? '';
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return decoded.includes(':') && safeEqual(password, secret);
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const https = (v: unknown) => (/^https?:\/\//.test(str(v)) ? str(v) : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The event key the integration filters on (see WEBHOOK_PROVIDER_EVENTS). */
export function eventOf(provider: WebhookProvider, json: unknown, header: HeaderOf) {
  if (provider === 'github') return header('x-github-event') ?? '';
  if (provider === 'azure_devops') return str(obj(json).eventType);
  return str(obj(json).webhookEvent);
}

export type ProviderMessage = { text: string; card: AlertCard };

interface CardInput {
  severity: AlertCard['severity'];
  title: string;
  subtitle?: string | null;
  text?: string | null;
  fields?: { label: string; value: string }[];
  url?: string | null;
}

function card(source: string, open: string, c: CardInput): ProviderMessage {
  const title = clip(c.title || source, 300);
  return {
    text: '',
    card: {
      severity: c.severity,
      title,
      subtitle: c.subtitle ? clip(c.subtitle, 300) : null,
      source,
      iconUrl: null,
      text: c.text ? clip(c.text, 4000) : null,
      fields: (c.fields ?? [])
        .filter((f) => f.value)
        .slice(0, 20)
        .map((f) => ({ label: clip(f.label, 100), value: clip(f.value, 1000) })),
      buttons: c.url ? [{ text: open, url: c.url }] : [],
    },
  };
}

/** A GitHub delivery → card, or null when the channel does not need it. */
function github(event: string, json: unknown, locale: AppLocale): ProviderMessage | null {
  const t = resources[locale].email.chat.integrations;
  const o = obj(json);
  const repo = str(obj(o.repository).full_name);
  const actor = str(obj(o.sender).login);
  const action = str(o.action);
  const make = (c: CardInput) =>
    card('GitHub', t.open, {
      ...c,
      fields: [{ label: t.fields.repo, value: repo }, ...(c.fields ?? [])],
    });
  switch (event) {
    case 'push': {
      const commits = Array.isArray(o.commits) ? o.commits : [];
      if (!commits.length) return null;
      const branch = str(o.ref).replace(/^refs\/heads\//, '');
      const lines = commits
        .slice(0, 5)
        .map((c) => `• ${clip(str(obj(c).message).split('\n')[0] ?? '', 120)}`);
      return make({
        severity: 'info',
        title: fill(t.push, {
          actor: str(obj(o.pusher).name) || actor,
          count: String(commits.length),
        }),
        subtitle: `${repo}:${branch}`,
        text: lines.join('\n'),
        fields: [{ label: t.fields.branch, value: branch }],
        url: https(o.compare),
      });
    }
    case 'pull_request': {
      const pr = obj(o.pull_request);
      const merged = pr.merged === true;
      const key =
        action === 'opened' || action === 'ready_for_review'
          ? 'prOpened'
          : action === 'closed'
            ? merged
              ? 'prMerged'
              : 'prClosed'
            : action === 'reopened'
              ? 'prReopened'
              : action === 'review_requested'
                ? 'prReview'
                : null;
      if (!key) return null;
      return make({
        severity: key === 'prMerged' ? 'success' : key === 'prReview' ? 'warning' : 'info',
        title: fill(t[key], { number: String(num(pr.number) ?? ''), title: str(pr.title) }),
        subtitle: `${str(obj(pr.head).ref)} → ${str(obj(pr.base).ref)}`,
        fields: [{ label: t.fields.author, value: str(obj(pr.user).login) || actor }],
        url: https(pr.html_url),
      });
    }
    case 'issues': {
      const issue = obj(o.issue);
      const key =
        action === 'opened'
          ? 'issueOpened'
          : action === 'closed'
            ? 'issueClosed'
            : action === 'reopened'
              ? 'issueReopened'
              : null;
      if (!key) return null;
      return make({
        severity: key === 'issueClosed' ? 'success' : 'info',
        title: fill(t[key], { number: String(num(issue.number) ?? ''), title: str(issue.title) }),
        text: key === 'issueOpened' ? clip(str(issue.body), 600) : null,
        fields: [{ label: t.fields.author, value: actor }],
        url: https(issue.html_url),
      });
    }
    case 'issue_comment': {
      if (action !== 'created') return null;
      const issue = obj(o.issue);
      const comment = obj(o.comment);
      return make({
        severity: 'info',
        title: fill(t.comment, { actor, title: `#${num(issue.number) ?? ''} ${str(issue.title)}` }),
        text: clip(str(comment.body), 600),
        url: https(comment.html_url),
      });
    }
    case 'workflow_run': {
      const run = obj(o.workflow_run);
      if (action !== 'completed') return null;
      const ok = str(run.conclusion) === 'success';
      if (!ok && str(run.conclusion) !== 'failure') return null;
      return make({
        severity: ok ? 'success' : 'critical',
        title: fill(ok ? t.runSuccess : t.runFailure, { name: str(run.name) }),
        subtitle: str(run.head_branch),
        fields: [{ label: t.fields.author, value: actor }],
        url: https(run.html_url),
      });
    }
    case 'release': {
      if (action !== 'published') return null;
      const rel = obj(o.release);
      return make({
        severity: 'success',
        title: fill(t.release, { name: str(rel.name) || str(rel.tag_name) }),
        text: clip(str(rel.body), 600),
        url: https(rel.html_url),
      });
    }
    default:
      return null;
  }
}

/** Azure DevOps already words the event (`message.text`, in the language it is set to). */
function azure(event: string, json: unknown, locale: AppLocale): ProviderMessage | null {
  const t = resources[locale].email.chat.integrations;
  const o = obj(json);
  const res = obj(o.resource);
  const title = str(obj(o.message).text);
  if (!title) return null;
  const detail = str(obj(o.detailedMessage).text);
  const status = str(res.result) || str(res.status);
  const failed = /fail|reject|error|canceled|partiallySucceeded/i.test(status);
  const severity: AlertCard['severity'] = failed
    ? 'critical'
    : event === 'git.pullrequest.merged' || /succeeded|completed/i.test(status)
      ? 'success'
      : 'info';
  const links = obj(res._links);
  const url = https(obj(links.web).href) ?? https(obj(links.html).href) ?? https(res.url);
  const project =
    str(obj(obj(res.repository).project).name) || str(obj(res.fields)['System.TeamProject']);
  return card('Azure DevOps', t.open, {
    severity,
    title,
    text: detail && detail !== title ? detail : null,
    fields: [
      { label: t.fields.project, value: project },
      { label: t.fields.status, value: status },
    ],
    url,
  });
}

/** Jira Cloud and Data Center issue and comment events. */
function jira(event: string, json: unknown, locale: AppLocale): ProviderMessage | null {
  const t = resources[locale].email.chat.integrations;
  const o = obj(json);
  const issue = obj(o.issue);
  const fields = obj(issue.fields);
  const key = str(issue.key);
  if (!key) return null;
  const base = /^(https?:\/\/[^/]+)/.exec(str(issue.self))?.[1];
  const url = base ? `${base}/browse/${key}` : null;
  const actor = str(obj(o.user).displayName) || str(obj(obj(o.comment).author).displayName);
  const summary = str(fields.summary);
  const common = [
    { label: t.fields.status, value: str(obj(fields.status).name) },
    { label: t.fields.assignee, value: str(obj(fields.assignee).displayName) },
    { label: t.fields.priority, value: str(obj(fields.priority).name) },
    { label: t.fields.type, value: str(obj(fields.issuetype).name) },
  ];
  const vars = { key, title: summary, actor };
  switch (event) {
    case 'jira:issue_created':
      return card('Jira', t.open, {
        severity: 'info',
        title: fill(t.jiraCreated, vars),
        text: clip(str(fields.description), 600),
        fields: common,
        url,
      });
    case 'jira:issue_updated': {
      const changes = (
        Array.isArray(obj(o.changelog).items) ? (obj(o.changelog).items as unknown[]) : []
      )
        .map((i) => obj(i))
        .filter((i) => str(i.field))
        .slice(0, 5)
        .map((i) => ({
          label: str(i.field),
          value: `${str(i.fromString) || '—'} → ${str(i.toString) || '—'}`,
        }));
      const done = /done|tamam|closed|resolved/i.test(
        str(obj(obj(fields.status).statusCategory).key),
      );
      return card('Jira', t.open, {
        severity: done ? 'success' : 'info',
        title: fill(t.jiraUpdated, vars),
        subtitle: actor || null,
        fields: changes.length ? changes : common,
        url,
      });
    }
    case 'jira:issue_deleted':
      return card('Jira', t.open, {
        severity: 'warning',
        title: fill(t.jiraDeleted, vars),
        subtitle: actor || null,
        url: null,
      });
    case 'comment_created':
      return card('Jira', t.open, {
        severity: 'info',
        title: fill(t.jiraComment, vars),
        text: clip(str(obj(o.comment).body), 600),
        url,
      });
    default:
      return null;
  }
}

export function providerMessage(
  provider: WebhookProvider,
  event: string,
  json: unknown,
  locale: AppLocale,
): ProviderMessage | null {
  if (provider === 'github') return github(event, json, locale);
  if (provider === 'azure_devops') return azure(event, json, locale);
  return jira(event, json, locale);
}
