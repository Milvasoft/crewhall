import { asc, desc, eq, sql } from 'drizzle-orm';
import {
  orgMembers,
  orgThemes,
  organizations,
  type BrandingData,
  type DbOrTx,
  type ThemeData,
} from '@crewhall/db';
import { DEFAULT_THEME } from '@crewhall/shared';
import type { MailBrand } from '../mail/templates';

/** Product branding used before the setup wizard has created an org (1.10). */
export const PRODUCT_BRANDING: BrandingData = {
  orgName: 'Crewhall',
  appName: 'Crewhall',
  logoLightUrl: null,
  logoDarkUrl: null,
  markUrl: null,
  faviconUrl: null,
  showPoweredBy: true,
  defaultLocale: 'tr',
};

export const DEFAULT_THEME_DATA: ThemeData = {
  light: DEFAULT_THEME.light,
  dark: DEFAULT_THEME.dark,
  radius: DEFAULT_THEME.radius,
  density: DEFAULT_THEME.density,
  login: DEFAULT_THEME.login,
};

/**
 * The org whose brand public pages show. Single-tenant installs have one org;
 * multi-tenant installs will pick it by host later.
 */
export async function primaryOrg(db: DbOrTx) {
  const [org] = await db
    .select()
    .from(organizations)
    .orderBy(asc(organizations.createdAt))
    .limit(1);
  return org ?? null;
}

export async function latestTheme(db: DbOrTx, orgId: string) {
  const [row] = await db
    .select()
    .from(orgThemes)
    .where(eq(orgThemes.orgId, orgId))
    .orderBy(desc(orgThemes.version))
    .limit(1);
  return row ?? null;
}

/** Brand for mails to a person: their first active org, else the primary org. */
export async function mailBrandForUser(
  db: DbOrTx,
  hubUrl: string,
  userId: string | null,
): Promise<MailBrand> {
  let orgId: string | null = null;
  if (userId) {
    const [m] = await db
      .select({ orgId: orgMembers.organizationId })
      .from(orgMembers)
      .where(sql`${orgMembers.userId} = ${userId} and ${orgMembers.status} = 'active'`)
      .orderBy(asc(orgMembers.createdAt))
      .limit(1);
    orgId = m?.orgId ?? null;
  }
  return mailBrandForOrg(db, hubUrl, orgId);
}

export async function mailBrandForOrg(
  db: DbOrTx,
  hubUrl: string,
  orgId: string | null,
): Promise<MailBrand> {
  const org = orgId
    ? ((await db.select().from(organizations).where(eq(organizations.id, orgId)))[0] ?? null)
    : await primaryOrg(db);
  if (!org) return { branding: PRODUCT_BRANDING, accent: DEFAULT_THEME.light.accent, hubUrl };
  const theme = await latestTheme(db, org.id);
  return {
    orgId: org.id,
    branding: org.branding,
    accent: theme?.data.light.accent ?? DEFAULT_THEME.light.accent,
    hubUrl,
  };
}
