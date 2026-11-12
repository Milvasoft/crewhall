import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { orgMembers, organizations, users } from '@crewhall/db';
import type { OrgPermission } from '@crewhall/shared';
import { loadEnv } from '@crewhall/backend/src/env';
import { build } from '@crewhall/backend/src/server';
import { importSite } from '@crewhall/backend/src/services/portal/import';
import { rotateToken } from '@crewhall/backend/src/services/portal/sites';
import { parseDocusaurus } from './parse';
import { compareUrls, normalizeUrl } from './parse/urls';

/**
 * `pnpm portal:import --from ../milva-portal` (doc 17 §9 "Tek seferlik içe aktarma"): reads a
 * Docusaurus checkout and writes it into a portal site of the Hub as drafts, then prints the
 * report (design 10.16). Uses the backend's .env (DATABASE_URL, S3_*). Relative paths are
 * resolved from where pnpm was started.
 */
const HELP = `Usage: pnpm portal:import --from <docusaurus dir> [options]

  --from <dir>            Docusaurus site to import (required)
  --site <slug>           Portal site short name (default: folder name)
  --org <slug>            Organization (default: the first one)
  --as <email>            Acting org admin/owner (default: the first owner)
  --old-urls <file>       Old site paths, one per line (repeatable); compared with the import
  --publish               Publish everything except next and unlisted docs afterwards
  --revalidate-url <url>  Next.js /api/revalidate of the site
  --preview-url <url>     Next.js /api/preview of the site
  --rotate-token          Print a new content token for the Next.js site
  --report <file>         Also write the report as JSON
`;

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    site: { type: 'string' },
    org: { type: 'string' },
    as: { type: 'string' },
    'old-urls': { type: 'string', multiple: true },
    publish: { type: 'boolean', default: false },
    'revalidate-url': { type: 'string' },
    'preview-url': { type: 'string' },
    'rotate-token': { type: 'boolean', default: false },
    report: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || !values.from) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 1);
}

const cwd = process.env.INIT_CWD ?? process.cwd();
const from = path.resolve(cwd, values.from);
const oldUrls = (values['old-urls'] ?? []).flatMap((f) =>
  fs
    .readFileSync(path.resolve(cwd, f), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => normalizeUrl(l.replace(/^https?:\/\/[^/]+/, '') || '/')),
);

const started = Date.now();
process.stdout.write(`Reading ${from}\n`);
const bundle = await parseDocusaurus(from, oldUrls.length ? { oldUrls } : {});
const comparison = oldUrls.length ? compareUrls(bundle.urls, oldUrls) : null;

const env = loadEnv();
const built = await build(env, { jobs: 'inline' });
try {
  const db = built.deps.db;
  const [org] = values.org
    ? await db.select().from(organizations).where(eq(organizations.slug, values.org))
    : await db.select().from(organizations).orderBy(asc(organizations.createdAt)).limit(1);
  if (!org) throw new Error('No organization; run the setup wizard first.');
  const members = await db
    .select({ member: orgMembers, email: users.email })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.organizationId, org.id), inArray(orgMembers.role, ['owner', 'admin'])))
    .orderBy(asc(orgMembers.role));
  const chosen = values.as ? members.find((m) => m.email === values.as) : members[0];
  if (!chosen) throw new Error(`No org admin ${values.as ?? ''} in ${org.slug}`);
  const actor = {
    org,
    actor: {
      userId: chosen.member.userId,
      orgRole: chosen.member.role,
      orgPermissions: chosen.member.permissions as OrgPermission[],
    },
    userId: chosen.member.userId,
  };

  const result = await importSite(built.deps, actor, bundle, {
    siteSlug:
      values.site ??
      path
        .basename(from)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-'),
    ...(comparison
      ? {
          urlComparison: {
            expected: oldUrls.length,
            matched: comparison.matched,
            missing: comparison.missing,
          },
        }
      : {}),
    publish: values.publish,
    ...(values['revalidate-url'] ? { revalidateUrl: values['revalidate-url'] } : {}),
    ...(values['preview-url'] ? { previewUrl: values['preview-url'] } : {}),
  });

  const r = result.report;
  const byType = new Map<string, number>();
  for (const e of r.entries) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const lines = [
    '',
    `Site ${result.created ? 'created' : 'updated'}: ${result.siteId}`,
    `Files read: ${r.counts.files} markdown`,
    `Docs: ${r.counts.docs} (+ ${r.counts.translations} translations, ${r.counts.categories} categories)`,
    `Posts: ${r.counts.posts} · authors ${r.counts.authors}`,
    `Media: ${r.counts.media} files · ${(r.counts.mediaBytes / 1024 / 1024).toFixed(1)} MB`,
    `Report: ${[...byType.entries()].map(([t, n]) => `${t} ${n}`).join(' · ') || 'no warnings'}`,
    comparison
      ? `URLs: ${comparison.matched} / ${oldUrls.length} identical; missing (redirected or gone): ${comparison.missing.join(', ') || 'none'}`
      : `URLs: ${bundle.urls.length} generated (no old sitemap given)`,
    result.publishNumber ? `Published as #${result.publishNumber}` : 'Not published (drafts)',
    `Took ${((Date.now() - started) / 1000).toFixed(1)} s`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  if (values['rotate-token']) {
    const t = await rotateToken(db, actor, result.siteId, {
      ip: null,
      userAgent: 'portal-import',
      locale: null,
    });
    process.stdout.write(`\nPORTAL_CONTENT_TOKEN=${t.token}\n`);
  }
  if (values.report) {
    fs.writeFileSync(path.resolve(cwd, values.report), JSON.stringify(r, null, 2));
  }
} finally {
  await built.close();
}
