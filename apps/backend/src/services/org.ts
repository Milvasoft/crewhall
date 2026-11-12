import { eq } from 'drizzle-orm';
import { orgThemes, organizations, type DbOrTx, type ThemeData } from '@crewhall/db';
import type { OrgTheme, Organization, UpdateBranding, UpdateOrganization } from '@crewhall/shared';
import { DEFAULT_THEME } from '@crewhall/shared';
import { AppError } from '../http/errors';
import type { OrgRow } from '../http/types';
import { latestTheme } from './brand';

export function toOrganization(org: OrgRow): Organization {
  return {
    id: org.id,
    slug: org.slug,
    name: org.name,
    branding: org.branding,
    settings: org.settings,
    createdAt: org.createdAt.toISOString(),
  };
}

export async function updateOrganization(db: DbOrTx, org: OrgRow, input: UpdateOrganization) {
  const [row] = await db
    .update(organizations)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.settings ? { settings: { ...org.settings, ...input.settings } } : {}),
    })
    .where(eq(organizations.id, org.id))
    .returning();
  if (!row) throw new AppError('not_found');
  return row;
}

export async function updateBranding(db: DbOrTx, org: OrgRow, input: UpdateBranding) {
  const branding = { ...org.branding, ...input };
  const [row] = await db
    .update(organizations)
    .set({ branding })
    .where(eq(organizations.id, org.id))
    .returning();
  if (!row) throw new AppError('not_found');
  return row.branding;
}

export function toTheme(version: number, data: ThemeData): OrgTheme {
  return { version, ...data };
}

export async function currentTheme(db: DbOrTx, orgId: string): Promise<OrgTheme> {
  const row = await latestTheme(db, orgId);
  return row ? toTheme(row.version, row.data) : DEFAULT_THEME;
}

export async function publishTheme(
  db: DbOrTx,
  orgId: string,
  actorId: string,
  data: ThemeData,
): Promise<OrgTheme> {
  const current = await latestTheme(db, orgId);
  const version = (current?.version ?? 0) + 1;
  const [row] = await db
    .insert(orgThemes)
    .values({ orgId, version, data, publishedBy: actorId })
    .onConflictDoNothing()
    .returning();
  // A concurrent publish took this version number.
  if (!row) throw new AppError('conflict');
  return toTheme(row.version, row.data);
}

/** The published theme as CSS variables, for clients that prefer `/api/theme.css`. */
export function themeCss(theme: OrgTheme): string {
  const radius = { sm: '6px', md: '10px', lg: '14px' }[theme.radius];
  const block = (m: OrgTheme['light']) =>
    `--ch-bg:${m.bg};--ch-surface:${m.surface};--ch-accent:${m.accent};--ch-radius:${radius};`;
  return [
    `:root{${block(theme.light)}}`,
    `:root[data-theme="dark"]{${block(theme.dark)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${block(theme.dark)}}}`,
  ].join('\n');
}
