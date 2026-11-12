import { paths } from '@crewhall/shared';
import { type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { signOut } from '@/lib/auth/auth';

/** Where the identity provider sends the browser back after its own sign-out. */
export function postLogoutUrl(): string {
  return `${window.location.origin}${paths.login()}`;
}

/**
 * Signs out of Crewhall and, when the session came from an IdP that wants it (RP-initiated
 * logout), of the IdP too. The target must be asked for before the session ends.
 * Returns true when the browser is leaving for the IdP; otherwise the caller goes to /login.
 */
export async function signOutWithSso(qc: QueryClient): Promise<boolean> {
  let target: string | null = null;
  try {
    target = (await api.call('getSsoLogoutTarget', { query: { postLogoutUrl: postLogoutUrl() } }))
      .url;
  } catch {
    // Older server or no session: a plain sign-out is enough.
  }
  await signOut();
  qc.clear();
  if (target) {
    window.location.assign(target);
    return true;
  }
  return false;
}
