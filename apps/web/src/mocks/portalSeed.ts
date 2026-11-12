import { markdownToDoc } from '@crewhall/editor';
import {
  type PortalHome,
  type PortalImportReport,
  type PortalNavigation,
  type PortalPublishItem,
  type PortalPublishJob,
  type PortalRichDoc,
  type PortalSeo,
  type PortalSiteSettings,
} from '@crewhall/shared';
import { type z } from 'zod';
import { USER } from './seed';

/**
 * Portal CMS sample (design 10) for the Milvasoft org: the "Milva Portal" site with versions
 * next / 1.0.1 / 1.0.0, an en doc tree with partial tr translations, blog posts, home page,
 * navigation, media, publish history and an import report. Seeded on first use (portal.ts).
 */

type PublishItem = z.infer<typeof PortalPublishItem>;

export interface MockPortalSite {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  status: 'live' | 'setup';
  locales: string[];
  defaultLocale: string;
  settings: PortalSiteSettings;
  contentSpaceId: string;
  tokenHint: string | null;
  lastRevalidateTest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MockPortalVersion {
  id: string;
  siteId: string;
  name: string;
  label: string;
  status: 'next' | 'current' | 'archived';
  showInPicker: boolean;
  frozenAt: string | null;
  createdAt: string;
}

export interface MockPublished {
  rev: number;
  slug: string;
  at: string;
  byId: string | null;
}

export interface MockPortalDoc {
  id: string;
  siteId: string;
  groupId: string;
  kind: 'doc' | 'category';
  version: string;
  locale: string;
  nodeId: string;
  parentGroupId: string | null;
  title: string;
  slug: string;
  description: string | null;
  sidebarLabel: string | null;
  position: number;
  unlisted: boolean;
  categoryLink: 'none' | 'generated-index' | 'doc';
  categorySlug: string | null;
  frontMatter: Record<string, unknown>;
  seo: PortalSeo;
  content: PortalRichDoc;
  rev: number;
  published: MockPublished | null;
  /** Translations: source rev when last marked current; null for the source language. */
  sourceRevMarked: number | null;
  /** Hub page it was sent from ("Portal'a gönder"). */
  sourceNodeId?: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedById: string | null;
}

export interface MockPortalAuthor {
  id: string;
  siteId: string;
  key: string;
  name: string;
  title: string | null;
  url: string | null;
  imageUrl: string | null;
  userId: string | null;
}

export interface MockPortalPost {
  id: string;
  siteId: string;
  groupId: string;
  locale: string;
  nodeId: string;
  slug: string;
  title: string;
  description: string | null;
  cover: string | null;
  authorIds: string[];
  tags: string[];
  date: string | null;
  scheduledAt: string | null;
  frontMatter: Record<string, unknown>;
  seo: PortalSeo;
  content: PortalRichDoc;
  rev: number;
  published: MockPublished | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedById: string | null;
}

export interface MockPortalSingleton<T> {
  siteId: string;
  draft: T;
  published: T | null;
  updatedAt: string | null;
  updatedById: string | null;
}

export interface MockPortalMedia {
  id: string;
  siteId: string;
  path: string;
  fileName: string;
  mime: string | null;
  size: number;
  width: number | null;
  height: number | null;
  alt: Record<string, string>;
  status: 'pending' | 'ready';
  usage: {
    kind: 'doc' | 'post' | 'home' | 'navigation' | 'settings';
    id: string | null;
    title: string;
    locale: string | null;
  }[];
  createdAt: string;
  createdById: string | null;
}

export interface MockPortalRedirect {
  id: string;
  siteId: string;
  fromPath: string;
  toPath: string;
  code: 301 | 308;
  auto: boolean;
  createdAt: string;
}

export interface MockPortalPublish {
  id: string;
  siteId: string;
  number: number;
  note: string | null;
  actorId: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'partial';
  items: PublishItem[];
  jobs: PortalPublishJob[];
  titles: string[];
  pathCount: number;
  durationMs: number | null;
  revertOf: number | null;
  revertedBy: number | null;
  createdAt: string;
  /** Mock only: reads of a fresh publish, so jobs finish on the next poll. */
  reads: number;
}

export interface PortalState {
  sites: MockPortalSite[];
  versions: MockPortalVersion[];
  docs: MockPortalDoc[];
  authors: MockPortalAuthor[];
  posts: MockPortalPost[];
  homes: MockPortalSingleton<PortalHome>[];
  navigations: MockPortalSingleton<PortalNavigation>[];
  media: MockPortalMedia[];
  redirects: MockPortalRedirect[];
  publishes: MockPortalPublish[];
  imports: (Omit<PortalImportReport, 'actor'> & { siteId: string; actorId: string | null })[];
}

// ---- ids and time ----

const pid = (n: number) =>
  `0190f0a0-0000-7000-8000-${(0x50000 + n).toString(16).padStart(12, '0')}`;

export const PORTAL_SITE = { milva: pid(1), milvaion: pid(2) } as const;
export const PORTAL_SITE_SLUG = { milva: 'milvasoft-portal', milvaion: 'milvaion-docs' } as const;
const CONTENT_SPACE = pid(3);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** Today at hh:mm (local), at least a minute in the past. */
function today(h: number, m: number): string {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime() < Date.now() ? d.toISOString() : ago(5 * MIN);
}
function yesterday(h: number, m: number): string {
  const d = new Date(Date.now() - DAY);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}
/** In `days` days at hh:mm (local). */
function inDays(days: number, h: number, m: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export function md(markdown: string): PortalRichDoc {
  return markdownToDoc(markdown).doc as PortalRichDoc;
}

let counter = 100;
const next = () => pid(counter++);

// ---- doc tree ----

interface DocSpec {
  seg: string;
  title: string;
  kind?: 'doc' | 'category';
  label?: string;
  description?: string;
  body?: string;
  tr?: { title: string; body?: string; outdated?: boolean };
  children?: DocSpec[];
  /** Only in some versions. */
  versions?: string[];
  changedIn?: { version: string; byId: string; at: string; body: string };
  draftIn?: { version: string; byId: string; at: string };
  removedIn?: string;
}

const QUICK_START_EN = `Get Milvaion running locally and execute your first job in **under 10 minutes**.

## Prerequisites

- **Docker Desktop** (v20.10+) with Docker Compose
- **Web browser** for the dashboard and built-in Open Api Rest Client
- (Optional) **curl** or a REST client (Postman, Insomnia)

\`\`\`bash
docker --version
# Docker version 24.0.0 or higher
docker compose version
# Docker Compose version v2.20.0 or higher
\`\`\`

## Step 1: Start the Stack

Create a file named \`docker-compose.yml\` or download it directly from GitHub. The stack starts PostgreSQL, Redis, RabbitMQ and the dashboard.
`;

const QUICK_START_TR = `Milvaion'u yerelde çalıştırın ve ilk işinizi **10 dakikadan kısa sürede** yürütün.

## Ön koşullar

- Docker Compose ile **Docker Desktop** (v20.10+)
- Panel ve yerleşik Open Api Rest istemcisi için **web tarayıcısı**

## Adım 1: Yığını başlatın

\`docker-compose.yml\` adlı bir dosya oluşturun.
`;

const CACHING_EN = `## What is Caching?

Caching is a temporary storage mechanism that allows websites to load information faster. Milvasoft.Caching.Redis wraps StackExchange.Redis and adds typed get/set, bulk operations and UTC-aware expirations.

## Usage

Add necessary components to service collection.

Since 8.1, connection retries are configured with ConnectRetry and failed commands are logged through IMilvaLogger instead of throwing.

Now you can use \`IRedisCacheService\` interface for caching operations.
`;

const CACHING_TR = `## Önbellekleme nedir?

Önbellekleme, web sitelerinin bilgiyi daha hızlı yüklemesini sağlayan geçici bir depolama mekanizmasıdır. Önbellekleme işlemleri için bazı çözümlerden yararlanıyoruz.

## Kullanım

Gerekli bileşenleri servis koleksiyonuna ekleyin.

Artık önbellekleme işlemleri için \`IRedisCacheService\` arayüzünü kullanabilirsiniz.
`;

const p = (text: string) => `${text}\n`;

const TREE: DocSpec[] = [
  {
    seg: 'welcome',
    title: 'Welcome to Milva Docs!',
    description: 'Start here: what Milvasoft builds and where to find it.',
    body: p(
      'You can get information about Milva and access documents created by Milvasoft on the portal.\n\n![Portal layout](/media/docs/sitemap.png)',
    ),
    tr: {
      title: 'Milva Dokümanlarına Hoş Geldiniz',
      body: p(
        "Portalda Milva hakkında bilgi alabilir ve Milvasoft'un hazırladığı dokümanlara ulaşabilirsiniz.",
      ),
    },
  },
  {
    seg: 'open-source-libs',
    title: 'Our Open Source Libraries',
    kind: 'category',
    tr: { title: 'Açık Kaynak Kütüphanelerimiz' },
    children: [
      {
        seg: 'milvaion',
        title: 'Milvaion Scheduler',
        kind: 'category',
        description: 'A distributed job scheduler for .NET.',
        tr: { title: 'Milvaion Zamanlayıcı' },
        children: [
          {
            seg: 'documentation-guide',
            title: 'Documentation Guide',
            body: p('How these pages are organised.'),
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'introduction',
            title: 'Introduction',
            body: p('Milvaion schedules and runs background jobs on any number of workers.'),
            tr: {
              title: 'Giriş',
              body: p(
                'Milvaion arka plan işlerini istediğiniz sayıda worker üzerinde zamanlar ve çalıştırır.',
              ),
            },
          },
          {
            seg: 'built-in-workers',
            title: 'Built-in Workers',
            kind: 'category',
            versions: ['next', '1.0.1'],
            children: [
              {
                seg: 'http-worker',
                title: 'HTTP Worker',
                body: p('Calls an HTTP endpoint on schedule.'),
              },
              {
                seg: 'sql-worker',
                title: 'SQL Worker',
                body: p('Runs SQL scripts against PostgreSQL or SQL Server.'),
              },
            ],
          },
          {
            seg: 'quick-start',
            title: 'Quick Start',
            label: 'Quick Start',
            description: 'Get Milvaion up and running in minutes.',
            body: QUICK_START_EN,
            tr: { title: 'Hızlı Başlangıç', body: QUICK_START_TR, outdated: true },
            changedIn: {
              version: '1.0.1',
              byId: USER.elif,
              at: today(9, 40),
              body: `${QUICK_START_EN}\n## Step 2: Open the Dashboard\n\nBrowse to http://localhost:5000 and sign in with the default account.\n`,
            },
          },
          {
            seg: 'core-concepts',
            title: 'Core Concepts',
            body: p('Jobs, triggers, workers and occurrences.'),
            tr: {
              title: 'Temel Kavramlar',
              body: p("İşler, tetikleyiciler, worker'lar ve çalışmalar."),
            },
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'your-first-worker',
            title: 'Your First Worker',
            body: p('Create a worker project and register a job.'),
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'implementing-jobs',
            title: 'Implementing Jobs',
            body: p('Implement IAsyncJob and return a result.'),
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'configuration',
            title: 'Configuration',
            body: p('Every option of the scheduler and the workers.'),
          },
          {
            seg: 'deployment',
            title: 'Deployment',
            body: p('Run Milvaion on Docker Swarm or Kubernetes.'),
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'reliability',
            title: 'Reliability',
            body: p('Retries, dead letters and idempotency.'),
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'alerting-system',
            title: 'Alerting System',
            body: p('Get notified before your users notice.'),
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'workflows',
            title: 'Workflows',
            body: p('A workflow is a directed graph of jobs.'),
            versions: ['next'],
            draftIn: { version: 'next', byId: USER.elif, at: today(9, 12) },
          },
          {
            seg: 'dashboard-screenshots',
            title: 'Dashboard Screenshots',
            body: p('Screenshots of the dashboard.'),
            versions: ['next', '1.0.1'],
            removedIn: 'next',
          },
        ],
      },
      {
        seg: 'milvasoft-helpers',
        title: 'Milvasoft Helpers',
        kind: 'category',
        tr: { title: 'Milvasoft Helpers' },
        children: [
          {
            seg: 'caching-redis',
            title: 'Caching.Redis',
            body: CACHING_EN,
            tr: { title: 'Caching.Redis', body: CACHING_TR, outdated: true },
            versions: ['next', '1.0.1'],
          },
          {
            seg: 'data-access-efcore',
            title: 'Data Access EF Core',
            body: p('Repository and unit of work helpers for EF Core.'),
            tr: {
              title: 'Data Access EF Core',
              body: p('EF Core için repository ve unit of work yardımcıları.'),
            },
          },
          {
            seg: 'encryption',
            title: 'Encryption',
            body: p('AES helpers with key rotation.'),
            tr: { title: 'Şifreleme', body: p('Anahtar döndürmeli AES yardımcıları.') },
          },
          {
            seg: 'multi-tenancy',
            title: 'Multi Tenancy',
            body: p('Tenant resolution and per-tenant databases.'),
            tr: {
              title: 'Çok Kiracılılık',
              body: p('Kiracı çözümleme ve kiracı başına veritabanı.'),
            },
            versions: ['next', '1.0.1'],
            changedIn: {
              version: '1.0.1',
              byId: USER.can,
              at: yesterday(15, 20),
              body: p('Tenant resolution, per-tenant databases and tenant-aware caching.'),
            },
          },
          {
            seg: 'localization',
            title: 'Localization',
            body: p('Resource based localization.'),
            versions: ['next', '1.0.1'],
          },
        ],
      },
      {
        seg: 'ops-framework',
        title: 'Ops Framework',
        kind: 'category',
        versions: ['next', '1.0.1'],
        children: [
          {
            seg: 'getting-started',
            title: 'Getting Started',
            body: p('Install the Ops Framework templates.'),
          },
          { seg: 'ops-table', title: 'Ops Table', body: p('Server side tables with filters.') },
          {
            seg: 'ops-table-quick-start',
            title: 'Ops Table Quick Start',
            body: p('Build your first table in five minutes.'),
            versions: ['next'],
            draftIn: { version: 'next', byId: USER.selin, at: yesterday(11, 5) },
          },
        ],
      },
    ],
  },
  {
    seg: 'tech-white-papers',
    title: 'Tech White Papers',
    kind: 'category',
    versions: ['next', '1.0.1'],
    children: [
      {
        seg: 'microservices',
        title: 'Microservice Architecture',
        body: p('When to split and when not to.'),
      },
      {
        seg: 'event-sourcing',
        title: 'Event Sourcing',
        body: p('Storing state as a sequence of events.'),
      },
      { seg: 'cqrs', title: 'CQRS', body: p('Separate reads from writes.') },
    ],
  },
];

function buildDocs(siteId: string): MockPortalDoc[] {
  const out: MockPortalDoc[] = [];
  const published = (rev: number, slug: string, at: string, byId: string | null) => ({
    rev,
    slug,
    at,
    byId,
  });
  for (const version of ['next', '1.0.1', '1.0.0']) {
    const walk = (specs: DocSpec[], parent: { groupId: string; slug: string } | null) => {
      specs.forEach((spec, i) => {
        if (spec.versions && !spec.versions.includes(version)) return;
        const slug = parent ? `${parent.slug}/${spec.seg}` : spec.seg;
        const groupId = next();
        const kind = spec.kind ?? 'doc';
        const created =
          version === '1.0.0' ? '2025-11-12T09:00:00.000Z' : '2026-03-03T08:12:00.000Z';
        const pubAt = version === '1.0.0' ? '2025-11-12T10:00:00.000Z' : '2026-03-03T09:00:00.000Z';
        const draft = spec.draftIn?.version === version ? spec.draftIn : null;
        const changed = spec.changedIn?.version === version ? spec.changedIn : null;
        const body = changed ? changed.body : (spec.body ?? '');
        const base: MockPortalDoc = {
          id: next(),
          siteId,
          groupId,
          kind,
          version,
          locale: 'en',
          nodeId: next(),
          parentGroupId: parent?.groupId ?? null,
          title: spec.title,
          slug,
          description: spec.description ?? null,
          sidebarLabel: spec.label ?? null,
          position: (i + 1) * 10,
          unlisted: false,
          categoryLink: kind === 'category' ? 'generated-index' : 'none',
          categorySlug: kind === 'category' ? `category/${spec.seg}` : null,
          frontMatter: {},
          seo: {},
          content: md(body),
          rev: changed ? 4 : 2,
          published: draft ? null : published(2, slug, pubAt, USER.bugra),
          sourceRevMarked: null,
          deletedAt: spec.removedIn === version ? ago(2 * DAY) : null,
          createdAt: draft?.at ?? created,
          updatedAt:
            draft?.at ?? changed?.at ?? (spec.removedIn === version ? ago(2 * DAY) : pubAt),
          updatedById: draft?.byId ?? changed?.byId ?? USER.bugra,
        };
        out.push(base);
        const tr = spec.tr;
        const hasTr =
          tr &&
          (version === '1.0.1' ||
            (version === 'next' && kind === 'category') ||
            (version === '1.0.0' && spec.seg === 'welcome'));
        if (tr && hasTr) {
          out.push({
            ...base,
            id: next(),
            nodeId: next(),
            locale: 'tr',
            title: tr.title,
            description: null,
            sidebarLabel: null,
            content: md(tr.body ?? ''),
            rev: 2,
            published: published(2, slug, '2026-08-03T09:00:00.000Z', USER.can),
            sourceRevMarked: tr.outdated ? base.rev - 2 : base.rev,
            deletedAt: null,
            updatedAt: '2026-08-03T09:00:00.000Z',
            updatedById: USER.can,
          });
        }
        if (spec.children) walk(spec.children, { groupId, slug });
      });
    };
    // 1.0.0 is the small first release.
    walk(
      version === '1.0.0'
        ? TREE.filter((s) => s.seg === 'welcome' || s.seg === 'open-source-libs')
        : TREE,
      null,
    );
  }
  // Outdated caching translation: the English source changed after the Turkish update.
  const cachingEn = out.find(
    (d) => d.version === '1.0.1' && d.locale === 'en' && d.slug.endsWith('caching-redis'),
  );
  if (cachingEn) {
    cachingEn.rev = 3;
    cachingEn.published = {
      ...cachingEn.published!,
      rev: 3,
      at: '2026-10-12T10:00:00.000Z',
      byId: USER.can,
    };
    cachingEn.updatedAt = '2026-10-12T10:00:00.000Z';
    cachingEn.updatedById = USER.can;
  }
  return out;
}

// ---- blog ----

interface PostSpec {
  slug: string;
  title: string;
  date: string | null;
  authors: ('bugra' | 'ali')[];
  tags: string[];
  body: string;
  description?: string;
  cover?: string;
  scheduled?: string;
  draft?: boolean;
  tr?: string;
}

const POST_BODY = (lead: string) => `${lead}

<!-- truncate -->

## Details

${lead} The rest of the post walks through the setup step by step.

\`\`\`csharp
services.AddMilvaion(options => options.UseRabbitMq());
\`\`\`
`;

const POSTS: PostSpec[] = [
  {
    slug: 'milvaion-1-4-workflows',
    title: 'Milvaion 1.4: Workflows and Alert Rules',
    date: null,
    authors: ['bugra'],
    tags: ['dotnet', 'milvaion', 'job-scheduler', 'workflows'],
    description:
      "Workflows, alert rules and a faster dashboard: what's new in Milvaion 1.4 and how to upgrade.",
    cover: '/media/blog/milvaion-1-4-cover.png',
    scheduled: inDays(3, 10, 0),
    body: POST_BODY(
      'Milvaion 1.4 is out. Two features dominated the issue tracker this summer: chaining jobs into workflows and getting notified when something goes wrong before your users notice.',
    ),
  },
  {
    slug: 'portal-to-crewhall',
    title: 'How We Moved the Portal to Crewhall',
    date: null,
    authors: ['bugra'],
    tags: ['crewhall', 'docusaurus'],
    draft: true,
    body: POST_BODY('Our documentation portal used to be a Docusaurus repository.'),
  },
  {
    slug: 'milvaion-mcp-server',
    title: 'Asking Your Scheduler Questions: The Milvaion MCP Server',
    date: '2026-07-20T09:00:00.000Z',
    authors: ['bugra'],
    tags: ['milvaion', 'mcp', 'ai'],
    body: POST_BODY('Milvaion now speaks the Model Context Protocol.'),
    tr: 'Zamanlayıcınıza soru sorun: Milvaion MCP sunucusu',
  },
  {
    slug: 'milvaion-hangfire-quartz-monitoring',
    title: 'Monitoring Hangfire and Quartz.NET Without Changing Them',
    date: '2026-07-20T08:00:00.000Z',
    authors: ['bugra'],
    tags: ['milvaion', 'hangfire', 'quartz'],
    body: POST_BODY('You can watch existing schedulers from the Milvaion dashboard.'),
  },
  {
    slug: 'milvaion-distributed-job-scheduler',
    title: 'Why I Wrote a Distributed Job Scheduler',
    date: '2026-07-19T09:00:00.000Z',
    authors: ['bugra'],
    tags: ['milvaion', 'dotnet'],
    body: POST_BODY('Every project I worked on had a background job problem.'),
    tr: 'Neden dağıtık bir iş zamanlayıcı yazdım',
  },
  {
    slug: 'units-dotnet',
    title: 'UnitsNet',
    date: '2025-01-03T09:00:00.000Z',
    authors: ['bugra'],
    tags: ['dotnet'],
    body: POST_BODY('Units of measurement without the bugs.'),
  },
  {
    slug: 'expo-notifications',
    title: 'Adding Custom Sounds to Notifications in Expo',
    date: '2024-11-05T09:00:00.000Z',
    authors: ['ali'],
    tags: ['expo', 'react-native'],
    body: POST_BODY('Custom notification sounds need a config plugin.'),
  },
  {
    slug: 'apache-ignite',
    title: 'Apache Ignite',
    date: '2024-10-27T09:00:00.000Z',
    authors: ['bugra'],
    tags: ['cache', 'distributed'],
    body: POST_BODY('An in-memory computing platform.'),
  },
  {
    slug: 'mutation-testing',
    title: 'Mutation Testing',
    date: '2024-10-01T09:00:00.000Z',
    authors: ['bugra'],
    tags: ['testing', 'dotnet'],
    body: POST_BODY('Who tests the tests?'),
    tr: 'Mutasyon testi',
  },
  {
    slug: 'project-history',
    title: 'The History of Our Projects',
    date: '2024-09-10T09:00:00.000Z',
    authors: ['bugra'],
    tags: ['milvasoft'],
    cover: '/media/blog/project-history_1.png',
    body: POST_BODY('How Milvasoft started.'),
  },
];

function buildPosts(siteId: string, authors: Record<'bugra' | 'ali', string>): MockPortalPost[] {
  const out: MockPortalPost[] = [];
  for (const spec of POSTS) {
    const groupId = next();
    const at = spec.date ?? today(8, 55);
    const base: MockPortalPost = {
      id: next(),
      siteId,
      groupId,
      locale: 'en',
      nodeId: next(),
      slug: spec.slug,
      title: spec.title,
      description: spec.description ?? null,
      cover: spec.cover ?? null,
      authorIds: spec.authors.map((a) => authors[a]),
      tags: spec.tags,
      date: spec.date,
      scheduledAt: spec.scheduled ?? null,
      frontMatter: {},
      seo: {},
      content: md(spec.body),
      rev: 2,
      published:
        spec.scheduled || spec.draft ? null : { rev: 2, slug: spec.slug, at, byId: USER.bugra },
      deletedAt: null,
      createdAt: at,
      updatedAt: spec.draft ? yesterday(18, 30) : at,
      updatedById: USER.bugra,
    };
    out.push(base);
    if (spec.tr) {
      out.push({
        ...base,
        id: next(),
        nodeId: next(),
        locale: 'tr',
        title: spec.tr,
        description: null,
        content: md(POST_BODY('Bu yazının Türkçesi.')),
      });
    }
  }
  return out;
}

// ---- home and navigation ----

function homeDraft(): PortalHome {
  return {
    sections: [
      {
        id: 'hero',
        type: 'hero',
        hidden: false,
        title: { en: 'Welcome To Milva Portal', tr: "Milva Portal'a Hoş Geldiniz" },
        badge: { en: 'Version {version}', tr: 'Sürüm {version}' },
        description: {
          en: 'You can get information about Milva and access documents created by Milvasoft on the portal. Good reading...',
          tr: "Portalda Milva hakkında bilgi alabilir, Milvasoft'un hazırladığı dokümanlara ulaşabilirsiniz. İyi okumalar...",
        },
        image: '/media/img/milva.gif',
        imageDark: null,
      },
      {
        id: 'about',
        type: 'about',
        hidden: false,
        title: { en: 'Who We Are', tr: 'Biz Kimiz' },
        description: {
          en: 'We are Milvasoft, a passionate team dedicated to building innovative software solutions.',
          tr: 'Biz Milvasoft, yenilikçi yazılım çözümleri üreten tutkulu bir ekibiz.',
        },
      },
      {
        id: 'video',
        type: 'video',
        hidden: false,
        title: { en: 'Milvasoft Intro', tr: 'Milvasoft Tanıtım' },
        videoId: '_AexNc-2ztQ',
      },
      {
        id: 'features',
        type: 'features',
        hidden: false,
        title: { en: 'What Can Be Done on the Portal', tr: 'Portalda Neler Yapılabilir' },
        items: {
          en: [
            'Explore open-source projects',
            'Learn a lot from useful articles',
            'Follow the release notes',
          ],
          tr: [
            'Açık kaynak projeleri keşfedin',
            'Faydalı yazılardan çok şey öğrenin',
            'Sürüm notlarını takip edin',
          ],
        },
        image: '/media/img/working.svg',
      },
      {
        id: 'technologies',
        type: 'technologies',
        hidden: false,
        title: { en: 'TECHNOLOGIES', tr: 'TEKNOLOJİLER' },
        images: ['/media/img/dotnet.png', '/media/img/k8s.png'],
      },
      {
        id: 'community',
        type: 'community',
        hidden: false,
        title: { en: 'Where the Portal Will Go?', tr: 'Portal nereye gidecek?' },
        description: {
          en: 'More libraries, more papers and a place to ask questions.',
          tr: 'Daha çok kütüphane, daha çok yazı ve soru sorabileceğiniz bir yer.',
        },
        image: '/media/img/we.svg',
      },
      {
        id: 'projects',
        type: 'projects',
        hidden: false,
        title: { en: 'Open Source Projects', tr: 'Açık Kaynak Projeler' },
        projects: [
          {
            name: 'Milvaion',
            image: null,
            url: 'https://github.com/Milvasoft/milvaion',
            description: { en: 'Distributed job scheduler', tr: 'Dağıtık iş zamanlayıcı' },
            badges: [],
          },
          {
            name: 'Milvasoft Helpers',
            image: null,
            url: 'https://github.com/Milvasoft/Milvasoft',
            description: { en: 'Helper libraries for .NET', tr: '.NET yardımcı kütüphaneleri' },
            badges: [],
          },
        ],
      },
    ],
  };
}

function navigationDraft(welcomeGroupId: string): PortalNavigation {
  return {
    navbar: {
      title: { en: 'Milva Portal' },
      logo: { src: '/media/img/logo.svg', srcDark: null, alt: 'Milva Portal' },
      items: [
        {
          id: 'docs',
          kind: 'docs',
          position: 'left',
          label: { en: 'Docs', tr: 'Dokümanlar' },
          hidden: false,
        },
        {
          id: 'blog',
          kind: 'blog',
          position: 'left',
          label: { en: 'Blog' },
          href: '/blog',
          hidden: false,
        },
        {
          id: 'github',
          kind: 'link',
          position: 'right',
          label: { en: 'GitHub' },
          href: 'https://github.com/Milvasoft',
          hidden: false,
        },
        {
          id: 'locale',
          kind: 'localeDropdown',
          position: 'right',
          label: { en: 'Language', tr: 'Dil' },
          hidden: false,
        },
        {
          id: 'version',
          kind: 'versionDropdown',
          position: 'right',
          label: { en: 'Version', tr: 'Versiyon' },
          hidden: false,
        },
      ],
    },
    footer: {
      style: 'dark',
      columns: [
        {
          id: 'docs',
          title: { en: 'Docs', tr: 'Dokümanlar' },
          items: [
            { id: 'welcome', label: { en: 'Docs', tr: 'Dokümanlar' }, docGroupId: welcomeGroupId },
          ],
        },
        {
          id: 'contact',
          title: { en: 'Contact', tr: 'İletişim' },
          items: [
            {
              id: 'so',
              label: { en: 'Stack Overflow' },
              href: 'https://stackoverflow.com/questions/tagged/milvasoft',
            },
            { id: 'gh', label: { en: 'Github' }, href: 'https://github.com/Milvasoft' },
          ],
        },
        {
          id: 'more',
          title: { en: 'More', tr: 'Daha fazla' },
          items: [{ id: 'blog', label: { en: 'Blog' }, href: '/blog' }],
        },
      ],
      copyright: { en: 'Copyright © {year} Milvasoft', tr: 'Telif hakkı © {year} Milvasoft' },
    },
  };
}

// ---- media ----

function buildMedia(
  siteId: string,
  refs: { welcomeEn: string; welcomeTr: string; posts: Record<string, string> },
): MockPortalMedia[] {
  const m = (
    path: string,
    mime: string,
    size: number,
    wh: [number, number] | null,
    usage: MockPortalMedia['usage'],
    alt: Record<string, string> = {},
  ): MockPortalMedia => ({
    id: next(),
    siteId,
    path,
    fileName: path.split('/').pop() ?? path,
    mime,
    size,
    width: wh?.[0] ?? null,
    height: wh?.[1] ?? null,
    alt,
    status: 'ready',
    usage,
    createdAt: '2026-03-03T08:12:00.000Z',
    createdById: USER.bugra,
  });
  const home = (title: string) => ({ kind: 'home' as const, id: null, title, locale: null });
  return [
    m(
      '/media/img/milva.gif',
      'image/gif',
      412_000,
      [480, 480],
      [home('Hero'), { kind: 'settings', id: null, title: 'Favicon', locale: null }],
    ),
    m(
      '/media/img/logo.svg',
      'image/svg+xml',
      3_200,
      [64, 64],
      [
        { kind: 'navigation', id: null, title: 'Navbar', locale: null },
        { kind: 'navigation', id: null, title: 'Footer', locale: null },
      ],
    ),
    m(
      '/media/docs/sitemap.png',
      'image/png',
      186_400,
      [1440, 900],
      [
        { kind: 'doc', id: refs.welcomeEn, title: 'Welcome to Milva Docs!', locale: 'en' },
        {
          kind: 'doc',
          id: refs.welcomeTr,
          title: 'Milva Dokümanlarına Hoş Geldiniz',
          locale: 'tr',
        },
      ],
      {
        en: 'Portal layout: category bar, language, version',
        tr: 'Portal düzeni: kategori çubuğu, dil, versiyon',
      },
    ),
    m(
      '/media/img/milva-social-card.png',
      'image/png',
      98_000,
      [1200, 630],
      [{ kind: 'settings', id: null, title: 'SEO', locale: null }],
    ),
    m('/media/img/working.svg', 'image/svg+xml', 24_000, [600, 400], [home('Features')]),
    m('/media/img/we.svg', 'image/svg+xml', 21_000, [600, 400], [home('Community')]),
    m(
      '/media/blog/project-history_1.png',
      'image/png',
      240_000,
      [1200, 800],
      [
        {
          kind: 'post',
          id: refs.posts['project-history'] ?? null,
          title: 'The History of Our Projects',
          locale: 'en',
        },
      ],
    ),
    m(
      '/media/blog/milvaion-1-4-cover.png',
      'image/png',
      310_000,
      [1600, 640],
      [
        {
          kind: 'post',
          id: refs.posts['milvaion-1-4-workflows'] ?? null,
          title: 'Milvaion 1.4: Workflows and Alert Rules',
          locale: 'en',
        },
      ],
    ),
    m('/media/img/dotnet.png', 'image/png', 12_000, [256, 256], [home('Technologies')], {
      en: '.NET',
    }),
    m('/media/img/k8s.png', 'image/png', 14_000, [256, 256], [home('Technologies')], { en: 'k8s' }),
    m('/media/blog/mutation-x.png', 'image/png', 88_000, [1000, 600], []),
    m('/media/files/milva-sunum-2026.pdf', 'application/pdf', 2_400_000, null, []),
  ];
}

// ---- publishes ----

function job(
  paths: string[],
  at: string,
  ms: number,
  extra: Partial<PortalPublishJob> = {},
): PortalPublishJob {
  return {
    id: next(),
    status: 'done',
    runAt: at,
    attempts: 1,
    paths,
    tags: [],
    httpStatus: 200,
    error: null,
    startedAt: at,
    finishedAt: new Date(new Date(at).getTime() + ms).toISOString(),
    durationMs: ms,
    ...extra,
  };
}

function item(
  kind: PublishItem['kind'],
  id: string | null,
  title: string,
  locale: string | null,
  version: string | null = null,
): PublishItem {
  return { kind, id, title, version, locale, action: 'update', rev: 2, scheduledAt: null };
}

function buildPublishes(siteId: string, docs: MockPortalDoc[]): MockPortalPublish[] {
  const doc = (version: string, locale: string, end: string) =>
    docs.find((d) => d.version === version && d.locale === locale && d.slug.endsWith(end));
  const welcomeEn = doc('1.0.1', 'en', 'welcome');
  const cachingTr = doc('1.0.1', 'tr', 'caching-redis');
  const config = doc('1.0.1', 'en', 'milvaion/configuration');
  const pub = (
    n: number,
    at: string,
    actorId: string,
    items: PublishItem[],
    jobs: PortalPublishJob[],
    extra: Partial<MockPortalPublish> = {},
  ): MockPortalPublish => ({
    id: next(),
    siteId,
    number: n,
    note: null,
    actorId,
    status: 'done',
    items,
    jobs,
    titles: items.map((i) => i.title),
    pathCount: jobs.reduce((a, j) => a + j.paths.length, 0),
    durationMs: jobs.reduce((a, j) => Math.max(a, j.durationMs ?? 0), 0),
    revertOf: null,
    revertedBy: null,
    createdAt: at,
    reads: 99,
    ...extra,
  });
  const d12 = '2026-10-12T09:10:00.000Z';
  return [
    pub(
      122,
      d12,
      USER.selin,
      [item('doc', welcomeEn?.id ?? null, 'Welcome to Milva Docs!', 'en', '1.0.1')],
      [job(['/docs/1.0.1/welcome', '/tr/docs/1.0.1/welcome'], d12, 2100)],
      { revertedBy: 123, note: 'Welcome görseli güncellendi' },
    ),
    pub(
      123,
      '2026-10-12T11:30:00.000Z',
      USER.bugra,
      [item('doc', welcomeEn?.id ?? null, 'Welcome to Milva Docs!', 'en', '1.0.1')],
      [job(['/docs/1.0.1/welcome', '/tr/docs/1.0.1/welcome'], '2026-10-12T11:30:00.000Z', 2000)],
      { revertOf: 122 },
    ),
    pub(
      124,
      '2026-10-14T10:00:00.000Z',
      USER.elif,
      [item('doc', config?.id ?? null, 'Configuration', 'en', '1.0.1')],
      [
        job(
          ['/docs/1.0.1/open-source-libs/milvaion/configuration'],
          '2026-10-14T10:00:00.000Z',
          1400,
        ),
        job(['/sitemap.xml'], '2026-10-14T10:00:00.000Z', 0, {
          status: 'failed',
          attempts: 3,
          httpStatus: 504,
          error: 'Gateway Timeout',
          durationMs: 30000,
        }),
      ],
      { status: 'partial', note: 'Yama 1.0.1' },
    ),
    pub(
      125,
      '2026-10-15T11:02:00.000Z',
      USER.elif,
      [item('post', null, 'MCP Server', 'en'), item('post', null, 'MCP Server', 'tr')],
      [
        job(
          ['/blog/milvaion-mcp-server', '/blog', '/blog/rss.xml'],
          '2026-10-15T11:02:00.000Z',
          2300,
        ),
        job(['/tr/blog/milvaion-mcp-server'], '2026-10-15T11:02:00.000Z', 2600, { attempts: 2 }),
      ],
    ),
    pub(
      126,
      '2026-10-16T14:00:00.000Z',
      USER.bugra,
      [item('navigation', null, 'Menü: GitHub linki', null)],
      [
        job(
          ['/', '/docs/1.0.1/welcome', '/blog', '/sitemap.xml'],
          '2026-10-16T14:00:00.000Z',
          48000,
        ),
      ],
      { pathCount: 418 },
    ),
    pub(
      127,
      yesterday(17, 5),
      USER.zeynep,
      [item('home', null, 'Ana sayfa · Biz Kimiz', 'tr')],
      [job(['/tr'], yesterday(17, 5), 1900)],
    ),
    pub(
      128,
      today(9, 30),
      USER.can,
      [item('doc', welcomeEn?.id ?? null, 'Welcome to Milva Docs!', 'en', '1.0.1')],
      [job(['/docs/1.0.1/welcome'], today(9, 30), 1700)],
    ),
    pub(
      129,
      today(9, 38),
      USER.can,
      [item('doc', cachingTr?.id ?? null, 'Caching.Redis', 'tr', '1.0.1')],
      [
        job(
          ['/tr/docs/1.0.1/open-source-libs/milvasoft-helpers/caching-redis', '/sitemap.xml'],
          today(9, 38),
          2800,
          { durationMs: 2800 },
        ),
      ],
      { note: 'Türkçe çeviri düzeltmesi' },
    ),
  ];
}

// ---- state ----

export function seedPortal(): PortalState {
  counter = 100;
  const settings = (over: Partial<PortalSiteSettings>): PortalSiteSettings => ({
    title: 'Milva Portal',
    tagline: 'Milvasoft documentation and blog',
    url: 'https://portal.milvasoft.com',
    revalidateUrl: 'https://portal.milvasoft.com/api/revalidate',
    previewUrl: 'https://portal.milvasoft.com/api/preview',
    timezone: 'Europe/Istanbul',
    titleTemplate: '{page} | {site}',
    logo: { src: '/media/img/logo.svg', srcDark: null, alt: 'Milva Portal' },
    favicon: '/media/img/milva.gif',
    socialImage: '/media/img/milva-social-card.png',
    nextPublic: false,
    showUntranslatedNotice: true,
    prism: { light: 'github', dark: 'dracula' },
    ...over,
  });
  const sites: MockPortalSite[] = [
    {
      id: PORTAL_SITE.milva,
      slug: PORTAL_SITE_SLUG.milva,
      name: 'Milva Portal',
      domain: 'portal.milvasoft.com',
      status: 'live',
      locales: ['en', 'tr'],
      defaultLocale: 'en',
      settings: settings({}),
      contentSpaceId: CONTENT_SPACE,
      tokenHint: '3c1e',
      lastRevalidateTest: null,
      createdAt: '2026-03-03T08:00:00.000Z',
      updatedAt: '2026-10-16T14:00:00.000Z',
    },
    {
      id: PORTAL_SITE.milvaion,
      slug: PORTAL_SITE_SLUG.milvaion,
      name: 'Milvaion Docs',
      domain: 'docs.milvaion.dev',
      status: 'setup',
      locales: ['en'],
      defaultLocale: 'en',
      settings: settings({
        title: 'Milvaion',
        tagline: null,
        url: null,
        revalidateUrl: null,
        previewUrl: null,
        socialImage: null,
        favicon: null,
        logo: { src: null, srcDark: null, alt: 'Milvaion' },
      }),
      contentSpaceId: CONTENT_SPACE,
      tokenHint: null,
      lastRevalidateTest: null,
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-01T08:00:00.000Z',
    },
  ];
  const v = (
    siteId: string,
    name: string,
    status: MockPortalVersion['status'],
    frozenAt: string | null,
  ): MockPortalVersion => ({
    id: next(),
    siteId,
    name,
    label: name === 'next' ? 'next' : name,
    status,
    showInPicker: status !== 'next',
    frozenAt,
    createdAt: frozenAt ?? '2026-03-03T08:00:00.000Z',
  });
  const versions = [
    v(PORTAL_SITE.milva, 'next', 'next', null),
    v(PORTAL_SITE.milva, '1.0.1', 'current', '2026-03-03T08:00:00.000Z'),
    v(PORTAL_SITE.milva, '1.0.0', 'archived', '2025-11-12T09:00:00.000Z'),
    v(PORTAL_SITE.milvaion, 'next', 'next', null),
    v(PORTAL_SITE.milvaion, '1.0.0', 'current', '2026-10-01T08:00:00.000Z'),
  ];
  const docs = buildDocs(PORTAL_SITE.milva);
  const authors: MockPortalAuthor[] = [
    {
      id: next(),
      siteId: PORTAL_SITE.milva,
      key: 'bugrakosen',
      name: 'Ahmet Buğra Kösen',
      title: 'Software Developer',
      url: 'https://github.com/bugrakosen',
      imageUrl: null,
      userId: USER.bugra,
    },
    {
      id: next(),
      siteId: PORTAL_SITE.milva,
      key: 'aliburhankeskin',
      name: 'Ali Burhan Keskin',
      title: 'Mobile Developer',
      url: 'https://github.com/aliburhankeskin',
      imageUrl: null,
      userId: null,
    },
  ];
  const posts = buildPosts(PORTAL_SITE.milva, { bugra: authors[0]!.id, ali: authors[1]!.id });
  const welcome = (locale: string) =>
    docs.find((d) => d.version === '1.0.1' && d.locale === locale && d.slug === 'welcome');
  const homePublished = homeDraft();
  const homeDraftChanged = homeDraft();
  const hero = homeDraftChanged.sections[0]!;
  hero.description = {
    ...hero.description,
    tr: "Milva hakkında bilgi alın ve Milvasoft'un açık kaynak projelerine ait dokümanlara tek yerden ulaşın.",
  };
  const nav = navigationDraft(welcome('en')!.groupId);
  const postIds = Object.fromEntries(
    posts.filter((x) => x.locale === 'en').map((x) => [x.slug, x.id]),
  );
  return {
    sites,
    versions,
    docs,
    authors,
    posts,
    homes: [
      {
        siteId: PORTAL_SITE.milva,
        draft: homeDraftChanged,
        published: homePublished,
        updatedAt: yesterday(17, 40),
        updatedById: USER.zeynep,
      },
      {
        siteId: PORTAL_SITE.milvaion,
        draft: { sections: [] },
        published: null,
        updatedAt: null,
        updatedById: null,
      },
    ],
    navigations: [
      {
        siteId: PORTAL_SITE.milva,
        draft: nav,
        published: structuredClone(nav),
        updatedAt: '2026-10-16T14:00:00.000Z',
        updatedById: USER.bugra,
      },
    ],
    media: buildMedia(PORTAL_SITE.milva, {
      welcomeEn: welcome('en')!.id,
      welcomeTr: welcome('tr')!.id,
      posts: postIds,
    }),
    redirects: [
      {
        id: next(),
        siteId: PORTAL_SITE.milva,
        fromPath: '/docs/1.0.1/open-source-libs/milvaion/getting-started',
        toPath: '/docs/1.0.1/open-source-libs/milvaion/quick-start',
        code: 301,
        auto: true,
        createdAt: '2026-09-02T10:00:00.000Z',
      },
      {
        id: next(),
        siteId: PORTAL_SITE.milva,
        fromPath: '/docs/intro',
        toPath: '/docs/1.0.1/welcome',
        code: 301,
        auto: false,
        createdAt: '2026-03-03T09:00:00.000Z',
      },
      {
        id: next(),
        siteId: PORTAL_SITE.milva,
        fromPath: '/github',
        toPath: 'https://github.com/Milvasoft',
        code: 308,
        auto: false,
        createdAt: '2026-03-03T09:00:00.000Z',
      },
    ],
    publishes: buildPublishes(PORTAL_SITE.milva, docs),
    imports: [buildImport(docs, postIds)],
  };
}

function buildImport(
  docs: MockPortalDoc[],
  postIds: Record<string, string>,
): PortalState['imports'][number] {
  const find = (end: string, locale = 'en') =>
    docs.find((d) => d.version === '1.0.1' && d.locale === locale && d.slug.endsWith(end))?.id ??
    null;
  return {
    id: next(),
    siteId: PORTAL_SITE.milva,
    source: 'Milvasoft/milva-portal · master · 4f2c9e1',
    startedAt: '2026-03-03T08:12:00.000Z',
    finishedAt: '2026-03-03T08:13:48.000Z',
    durationMs: 108_000,
    actorId: USER.bugra,
    counts: {
      files: 412,
      docs: 208,
      categories: 23,
      translations: 44,
      posts: 16,
      authors: 2,
      media: 64,
      mediaBytes: 38 * 1024 * 1024,
      warnings: 6,
      skipped: 14,
    },
    urls: { expected: 418, matched: 418, missing: [] },
    entries: [
      {
        type: 'translation',
        source: 'i18n/tr/…/milvasoft-helpers/*.md (15)',
        action: 'Content identical to English; marked as not translated',
        targetKind: 'doc',
        targetId: find('milvasoft-helpers/localization'),
      },
      {
        type: 'mdx',
        source: 'milvaion/13-dashboard-screenshots.md',
        action: 'Imported React component turned into an image gallery; check it',
        targetKind: 'doc',
        targetId: find('dashboard-screenshots'),
      },
      {
        type: 'link',
        source: '3 files link to /docs/next/…',
        action: 'No target; link removed, text kept',
        targetKind: 'doc',
        targetId: find('milvaion/configuration'),
      },
      {
        type: 'image',
        source: 'miro.medium.com/…T-BmjLrO1QWNPKkUSiNfKg.png',
        action: 'Downloaded to Media for the expo-notifications post',
        targetKind: 'post',
        targetId: postIds['expo-notifications'] ?? null,
      },
      {
        type: 'setting',
        source: 'docusaurus.config.js › editUrl',
        action: 'Pointed at the template repository; "Edit this page" link turned off',
        targetKind: null,
        targetId: null,
      },
      {
        type: 'home',
        source: 'homepageContent.json › hero.version',
        action: '"Version 1.0.0" was typed by hand; {version} suggested',
        targetKind: null,
        targetId: null,
      },
      {
        type: 'skipped',
        source: 'ops-framework/ops-table/components/*.tsx (12)',
        action: 'Code files, not documents',
        targetKind: null,
        targetId: null,
      },
    ],
  };
}
