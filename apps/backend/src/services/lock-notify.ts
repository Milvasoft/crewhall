import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { orgMembers, users } from '@crewhall/db';
import { resolveLocale } from '@crewhall/i18n';
import { AUTH_LOCK, paths, withQuery } from '@crewhall/shared';
import type { BaseDeps } from '../deps';
import { lockAdminMail, lockMail } from '../mail/templates';
import { audit } from './audit';
import { mailBrandForOrg, mailBrandForUser } from './brand';
import type { LockoutRow } from './lockout';
import { activeMemberships } from './membership';

/**
 * A lock just started: tell the person (with an unlock link that leads to password
 * reset), tell the owners and admins of their orgs, and write `auth.account.locked`.
 * Unknown e-mail addresses only get the audit entry.
 */
export async function notifyLock(
  deps: Pick<BaseDeps, 'db' | 'env' | 'mailer' | 'logger'>,
  row: LockoutRow,
  req: { ip: string | null; userAgent: string | null },
) {
  const { db, env, mailer, logger } = deps;
  const lockedUntil = row.lockedUntil ?? new Date();
  const lastFailedAt = row.lastFailedAt ?? new Date();
  const meta = {
    email: row.email,
    lockedUntil: lockedUntil.toISOString(),
    level: row.lockLevel,
    ip: row.lastFailedIp,
  };
  const [user] = await db
    .select()
    .from(users)
    .where(sql`${users.email} = ${row.email}`);
  if (!user) {
    await audit(db, { orgId: null, actorId: null, action: 'auth.account.locked', meta }, req);
    return;
  }

  const memberships = await activeMemberships(db, user.id);
  if (memberships.length === 0) {
    await audit(
      db,
      {
        orgId: null,
        actorId: user.id,
        action: 'auth.account.locked',
        targetType: 'user',
        targetId: user.id,
        meta,
      },
      req,
    );
  }
  for (const { org } of memberships) {
    await audit(
      db,
      {
        orgId: org.id,
        actorId: user.id,
        action: 'auth.account.locked',
        targetType: 'user',
        targetId: user.id,
        meta,
      },
      req,
    );
  }
  const common = {
    name: user.name,
    failures: AUTH_LOCK.maxFailures,
    lockedUntil,
    lastFailedAt,
    ip: row.lastFailedIp,
  };
  try {
    const brand = await mailBrandForUser(db, env.HUB_URL, user.id);
    const mail = lockMail(brand, {
      ...common,
      locale: resolveLocale(user.locale),
      to: user.email,
      unlockUrl: `${env.HUB_URL}${withQuery(paths.forgotPassword(), { email: user.email })}`,
    });
    const orgId = brand.orgId ?? null;
    if (await mailer.enabledFor(orgId)) {
      await mailer.send({ orgId, to: user.email, fromName: brand.branding.orgName, ...mail });
    }
  } catch (err) {
    logger.warn({ err }, 'lock mail failed');
  }

  for (const { org } of memberships) {
    try {
      if (!(await mailer.enabledFor(org.id))) continue;
      const admins = await db
        .select({ email: users.email, locale: users.locale })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(
          and(
            eq(orgMembers.organizationId, org.id),
            eq(orgMembers.status, 'active'),
            inArray(orgMembers.role, ['owner', 'admin']),
            ne(orgMembers.userId, user.id),
          ),
        );
      if (admins.length === 0) continue;
      const brand = await mailBrandForOrg(db, env.HUB_URL, org.id);
      for (const admin of admins) {
        const mail = lockAdminMail(brand, {
          ...common,
          locale: resolveLocale(admin.locale),
          to: admin.email,
          email: user.email,
          memberUrl: `${env.HUB_URL}${paths.adminMember(user.id)}`,
        });
        await mailer.send({
          orgId: org.id,
          to: admin.email,
          fromName: brand.branding.orgName,
          ...mail,
        });
      }
    } catch (err) {
      logger.warn({ err, orgId: org.id }, 'lock admin mail failed');
    }
  }
}
