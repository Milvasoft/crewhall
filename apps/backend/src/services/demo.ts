import { eq, sql } from 'drizzle-orm';
import { orgMembers, organizations, twoFactors, users } from '@crewhall/db';
import type { Deps } from '../deps';
import { opsDepsFromAppEnv } from '../ops/deps';
import { forgetCompliancePolicy } from './compliance/policy';
import { seedDemo } from './demo-seed';
import { isDemoMode, nextDemoReset } from './demo-flag';
import { addPeer, updateFederation } from './federation/peers';
import { invalidateModules } from './identity/modules';
import { primaryOrg } from './brand';

/**
 * Hourly-reset live demo (roadmap, last item). With DEMO_MODE the worker empties the
 * database and the bucket every hour and seeds the fictional demo company again (demo-seed.ts;
 * never the development seed); visitors sign
 * in with the accounts listed on the sign-in page, 2FA is not enforced and the few
 * settings that could lock others out are refused (demo-flag.ts).
 */

/** demo.reset (hourly): wipe, then seed the sample again. Refuses outside demo mode. */
export async function resetDemo(deps: Deps) {
  if (!isDemoMode()) throw new Error('resetDemo runs only with DEMO_MODE=true');
  const started = Date.now();
  // Every table of the app; migrations (drizzle) and the job queue (pgboss) stay.
  await deps.db.execute(sql`
    do $$ declare names text; begin
      select string_agg(quote_ident(tablename), ', ') into names
        from pg_tables where schemaname = 'public';
      if names is not null then
        execute 'truncate table ' || names || ' restart identity cascade';
      end if;
    end $$;`);
  const store = opsDepsFromAppEnv(deps.env).store;
  if (store) {
    const keys: string[] = [];
    for await (const o of store.list()) keys.push(o.key);
    await store.delete(keys);
  }
  invalidateModules();
  forgetCompliancePolicy();

  await seedDemo(deps);

  // Visitors share these accounts: no second factor to get stuck on, and a small quota.
  await deps.db.delete(twoFactors);
  await deps.db.update(users).set({ twoFactorEnabled: false });
  await deps.db.update(organizations).set({
    settings: sql`${organizations.settings} || ${JSON.stringify({
      publicLinksEnabled: false,
      storageQuotaBytes: 1024 * 1024 * 1024,
      maxFileBytes: 25 * 1024 * 1024,
    })}::jsonb`,
  });
  await linkDemoPeers(deps);
  deps.logger.info({ ms: Date.now() - started }, 'demo reset');
}

/**
 * DEMO_FEDERATION_PEERS (kararlar.md 2026-10-29): federation with the test server comes back
 * after every reset. The key is the same (keys.ts › demoKeyPair) and the new instance id tells
 * the peer to invite us into its shared channels again; addPeer fetches those invites.
 */
async function linkDemoPeers(deps: Deps) {
  const domains = deps.env.DEMO_FEDERATION_PEERS;
  if (domains.length === 0) return;
  const req = { ip: null, userAgent: 'crewhall-demo', locale: 'tr' as const };
  try {
    const org = await primaryOrg(deps.db);
    const [owner] = await deps.db
      .select({ id: orgMembers.userId })
      .from(orgMembers)
      .where(eq(orgMembers.role, 'owner'))
      .limit(1);
    if (!org || !owner) return;
    await updateFederation(
      deps,
      org,
      { enabled: true, allowedDomains: domains, sharedChannels: { enabled: true } },
      owner.id,
      req,
    );
    const fresh = (await primaryOrg(deps.db))!;
    for (const domain of domains) {
      await addPeer(deps, fresh, domain, owner.id, req).catch((err: unknown) =>
        deps.logger.warn({ err, domain }, 'demo federation peer not reachable'),
      );
    }
  } catch (err) {
    deps.logger.error({ err }, 'demo federation setup failed');
  }
}

/** Any number above a few billion; keeps two api replicas from resetting at once. */
const DEMO_LOCK_KEY = 7_412_093_777;

/**
 * Runs the reset at the top of every hour in the api process (it has the auth stack the seed
 * needs), and once at start when the database is still empty. Returns a stop function.
 */
export function startDemoClock(deps: Deps): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const run = async () => {
    try {
      // The open transaction only holds the advisory lock; the reset runs on other connections.
      await deps.db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ ok: boolean }>(
          sql`select pg_try_advisory_xact_lock(${DEMO_LOCK_KEY}) as ok`,
        );
        if (rows[0]?.ok) await resetDemo(deps);
      });
    } catch (err) {
      deps.logger.error({ err }, 'demo reset failed');
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void run().finally(schedule), nextDemoReset().getTime() - Date.now());
  };
  void (async () => {
    const [org] = await deps.db.select({ id: organizations.id }).from(organizations).limit(1);
    if (!org) await run();
    schedule();
  })();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
