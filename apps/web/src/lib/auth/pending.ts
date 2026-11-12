/**
 * Who is signing in between the password and the 2FA step. better-auth does not return
 * the user on a 2FA redirect, so the email typed on /login is kept for the "who" row.
 * sessionStorage: survives a reload of the 2FA page, cleared with the tab.
 */
const KEY = 'crewhall.pendingIdentity';

export interface PendingIdentity {
  email: string;
  name?: string;
}

export function setPendingIdentity(v: PendingIdentity | null): void {
  try {
    if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* best effort */
  }
}

export function getPendingIdentity(): PendingIdentity | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as PendingIdentity) : null;
  } catch {
    return null;
  }
}
