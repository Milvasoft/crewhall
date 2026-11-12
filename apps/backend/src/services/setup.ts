import { timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { orgMembers, orgThemes, organizations, users, type BrandingData } from '@crewhall/db';
import type { PublicBootstrap, SetupRequest, SetupResult } from '@crewhall/shared';
import { API_LEVEL, capabilitiesFor, DEFAULT_THEME, type OrgSettings } from '@crewhall/shared';
import { createCredentialUser } from '../auth/users';
import type { Deps } from '../deps';
import { AppError } from '../http/errors';
import type { RequestInfo } from '../http/types';
import { smtpTestMail } from '../mail/templates';
import { resolveLocale } from '@crewhall/i18n';
import { PACKAGE_VERSION } from '../version';
import { audit } from './audit';
import { DEFAULT_THEME_DATA, mailBrandForOrg, PRODUCT_BRANDING, primaryOrg } from './brand';
import { demoBootstrap, isDemoMode } from './demo-flag';
import { invitationUrl, issueInvitation, sendInvitationMail } from './invitations';
import { currentTheme } from './org';
import { signInOptions } from './identity/signin';
import { createSharedSpace, ensurePersonalSpace } from './spaces';
import { desktopInfo, updateSources } from './desktop/releases';
import { checkClient, minClientVersion } from './compat';
import { enabledModules } from './identity/modules';
import { gifActive } from './chat/gif';

function tokenMatches(expected: string, given: string | undefined) {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertSetupToken(deps: Deps, given: string | undefined) {
  if (deps.setupToken !== null && !tokenMatches(deps.setupToken, given)) {
    throw new AppError('setup_token_invalid');
  }
}

let running: Promise<SetupResult> | null = null;

/**
 * First-run wizard (design 1.10-1.13). Creates the org, its owner, the first shared
 * spaces and the team invitations in one go; accepted only while no org exists.
 */
export async function runSetup(deps: Deps, input: SetupRequest, req: RequestInfo) {
  assertSetupToken(deps, input.setupToken);
  if (running) throw new AppError('conflict', { reason: 'setup_in_progress' });
  running = doSetup(deps, input, req);
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function doSetup(deps: Deps, input: SetupRequest, req: RequestInfo): Promise<SetupResult> {
  const { db, auth } = deps;
  if (await primaryOrg(db)) throw new AppError('setup_already_done');
  const [slugTaken] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, input.org.slug));
  if (slugTaken) throw new AppError('org_slug_taken');
  const [emailTaken] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`${users.email} = ${input.owner.email}`);
  if (emailTaken) throw new AppError('conflict', { reason: 'email_taken' });

  const owner = await createCredentialUser(auth, {
    email: input.owner.email,
    name: input.owner.name,
    password: input.owner.password,
    locale: input.org.defaultLocale,
  });
  const [ownerRow] = await db.select().from(users).where(eq(users.id, owner.id));
  if (!ownerRow) throw new AppError('internal');

  const branding: BrandingData = {
    ...PRODUCT_BRANDING,
    orgName: input.org.name,
    defaultLocale: input.org.defaultLocale,
  };

  let result: Awaited<ReturnType<typeof createOrgTx>>;
  try {
    result = await db.transaction((tx) => createOrgTx(tx, input, branding, ownerRow, req));
  } catch (err) {
    // Leave no half-made owner behind, so the wizard can be submitted again.
    await db.delete(users).where(eq(users.id, owner.id));
    throw err;
  }

  for (const inv of result.invitations) {
    await sendInvitationMail(deps, result.org, ownerRow, inv.row, inv.token);
  }
  if (await deps.mailer.enabledFor(result.org.id)) {
    try {
      await auth.api.sendVerificationEmail({ body: { email: ownerRow.email } });
    } catch (err) {
      deps.logger.warn({ err }, 'owner verification mail failed');
    }
  }
  deps.logger.info({ orgId: result.org.id, ownerId: owner.id }, 'setup complete');

  return {
    orgId: result.org.id,
    ownerId: owner.id,
    invitations: result.invitations.map((i) => ({
      email: i.row.email,
      url: invitationUrl(deps.env.HUB_URL, i.token),
    })),
  };
}

async function createOrgTx(
  tx: Parameters<Parameters<Deps['db']['transaction']>[0]>[0],
  input: SetupRequest,
  branding: BrandingData,
  owner: typeof users.$inferSelect,
  req: RequestInfo,
) {
  // Serialize concurrent wizards across processes too.
  await tx.execute(sql`select pg_advisory_xact_lock(7412093552)`);
  const [already] = await tx.select({ id: organizations.id }).from(organizations).limit(1);
  if (already) throw new AppError('setup_already_done');

  const [org] = await tx
    .insert(organizations)
    .values({
      slug: input.org.slug,
      name: input.org.name,
      branding,
      settings: {
        requireTwoFactor: false,
        defaultLocale: input.org.defaultLocale,
        membersCanCreateSpaces: true,
        publicLinksEnabled: true,
      },
    })
    .returning();
  if (!org) throw new AppError('internal');
  await tx.insert(orgThemes).values({ orgId: org.id, version: 1, data: DEFAULT_THEME_DATA });
  await tx.insert(orgMembers).values({
    organizationId: org.id,
    userId: owner.id,
    role: 'owner',
    status: 'active',
    joinedAt: new Date(),
  });
  await ensurePersonalSpace(tx, org.id, owner);

  const wanted = input.spaces ?? [{ name: input.org.name, color: 's1' as const, isDefault: true }];
  for (const s of wanted) {
    await createSharedSpace(tx, org.id, owner.id, s);
  }

  const seen = new Set([owner.email.toLowerCase()]);
  const invites: Awaited<ReturnType<typeof issueInvitation>>[] = [];
  for (const inv of input.invitations ?? []) {
    const email = inv.email.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    invites.push(
      await issueInvitation(tx, org, owner, { email, role: inv.role, spaceIds: [] }, req),
    );
  }

  await audit(
    tx,
    {
      orgId: org.id,
      actorId: owner.id,
      action: 'setup.complete',
      targetType: 'org',
      targetId: org.id,
      meta: { spaces: wanted.length, invitations: invites.length },
    },
    req,
  );
  return { org, invitations: invites };
}

export async function smtpTest(
  deps: Deps,
  to: string,
  setupToken: string | undefined,
  acceptLanguage: string | null,
) {
  assertSetupToken(deps, setupToken);
  if (await primaryOrg(deps.db)) throw new AppError('setup_already_done');
  if (!deps.mailer.enabled) throw new AppError('bad_request', { reason: 'smtp_not_configured' });
  const brand = await mailBrandForOrg(deps.db, deps.env.HUB_URL, null);
  const mail = smtpTestMail(brand, resolveLocale(acceptLanguage), to);
  try {
    await deps.mailer.send({ orgId: null, to, ...mail });
  } catch (err) {
    deps.logger.warn({ err }, 'smtp test failed');
    throw new AppError('bad_request', {
      reason: 'smtp_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let checksCache: { at: number; storage: boolean; smtp: boolean } | null = null;

async function storageReachable(endpoint: string | undefined) {
  if (!endpoint) return false;
  try {
    await fetch(endpoint, { method: 'GET', signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/** `client` is the X-Crewhall-Client header; its verdict comes back as clientStatus. */
export async function bootstrap(deps: Deps, client?: string | null): Promise<PublicBootstrap> {
  const org = await primaryOrg(deps.db);
  const gifOn = org ? await gifActive(deps.db, org.id) : false;
  const base: PublicBootstrap = {
    branding: org?.branding ?? PRODUCT_BRANDING,
    theme: org ? await currentTheme(deps.db, org.id) : DEFAULT_THEME,
    needsSetup: !org,
    auth: {
      passkey: true,
      signupOpen: deps.env.SIGNUP_OPEN,
      emailEnabled: org ? await deps.mailer.enabledFor(org.id) : deps.mailer.enabled,
    },
    server: {
      version: deps.env.APP_VERSION ?? PACKAGE_VERSION,
      minMobileVersion: deps.env.MIN_MOBILE_VERSION ?? null,
      apiLevel: API_LEVEL,
      // chat.gif only for an org with GIFs on (its own GIPHY key).
      capabilities: capabilitiesFor(
        enabledModules(org?.settings as OrgSettings | undefined),
      ).filter((c) => c !== 'chat.gif' || gifOn),
      minClientVersion: minClientVersion(deps.env),
    },
  };
  const check = checkClient(deps.env, client);
  if (check) base.clientStatus = check.status;
  const desktop = await desktopInfo(updateSources(deps));
  if (desktop) base.desktop = desktop;
  if (org) {
    return {
      ...base,
      auth: { ...base.auth, ...(await signInOptions(deps.db, org.id)) },
      ...(isDemoMode() ? { demo: demoBootstrap() } : {}),
    };
  }

  if (!checksCache || Date.now() - checksCache.at > 30_000) {
    const [storage, smtp] = await Promise.all([
      deps.storage ? deps.storage.ping() : storageReachable(deps.env.S3_ENDPOINT),
      deps.mailer.enabled ? deps.mailer.verify() : Promise.resolve(false),
    ]);
    checksCache = { at: Date.now(), storage, smtp };
  }
  return {
    ...base,
    setup: {
      tokenRequired: deps.setupToken !== null,
      checks: { database: true, storage: checksCache.storage, smtp: checksCache.smtp },
    },
  };
}
