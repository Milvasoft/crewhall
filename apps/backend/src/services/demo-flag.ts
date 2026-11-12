import type { PublicBootstrap } from '@crewhall/shared';
import { DEMO_PASSWORD, DEMO_USERS } from './demo-data';

/**
 * Live demo switch (DEMO_MODE, roadmap "Saatlik sıfırlanan canlı demo"). Kept in its own
 * tiny module so low-level checks (2FA policy, router guard, auth routes) can read it
 * without importing the demo seed.
 */
let demo = false;

export function setDemoMode(on: boolean) {
  demo = on;
}

export function isDemoMode() {
  return demo;
}

/**
 * Org endpoints that could lock other visitors out until the next reset (security policy,
 * SSO, member status, backups). The rest of the product stays fully usable.
 */
export const DEMO_BLOCKED_ENDPOINTS: ReadonlySet<string> = new Set([
  'updateSecurityPolicy',
  'createIdentityProvider',
  'updateIdentityProvider',
  'deleteIdentityProvider',
  'updateMember',
  'updateBackupSettings',
  'startBackup',
  // Federation with the test server is set up by the reset (DEMO_FEDERATION_PEERS).
  'updateFederation',
  'removeFederationPeer',
]);

/** better-auth paths that change the shared demo accounts' credentials. */
export const DEMO_BLOCKED_AUTH_PATHS = [
  '/api/auth/change-password',
  '/api/auth/change-email',
  '/api/auth/delete-user',
  '/api/auth/two-factor/enable',
  '/api/auth/two-factor/disable',
  '/api/auth/update-user',
];

/** Sample accounts shown on the sign-in page; one per role. */
export const DEMO_ACCOUNTS = DEMO_USERS.filter(
  (u, i, all) => all.findIndex((x) => x.role === u.role) === i,
).map((u) => ({ email: u.email, password: DEMO_PASSWORD, name: u.name, role: u.role }));

/** Next reset: the top of the next hour (the api's demo clock, services/demo.ts). */
export function nextDemoReset(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

export function demoBootstrap(now = new Date()): NonNullable<PublicBootstrap['demo']> {
  return { resetAt: nextDemoReset(now).toISOString(), accounts: DEMO_ACCOUNTS };
}
