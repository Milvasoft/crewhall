import { z } from 'zod';
import { signValue, verifySigned } from '../mcp/crypto';

/**
 * WOPI access tokens: the document server gets one per file and person and sends it back on
 * every WOPI call (query `access_token`). Signed with a key derived from AUTH_SECRET, bound to the
 * file, the person, the org and whether writing was granted. Rights are checked again on every
 * call, so losing access ends the session before the token runs out.
 */

/** One working day: the editor keeps using the same token for the whole session. */
export const WOPI_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

const Grant = z.object({
  n: z.uuid(),
  u: z.uuid(),
  o: z.uuid(),
  w: z.boolean(),
  /**
   * What the token opens: WOPI calls, or the Document Server API's file download and save
   * callback. A token for one never works for another.
   */
  p: z.enum(['wopi', 'file', 'save']).default('wopi'),
});
export type WopiGrant = z.infer<typeof Grant>;
export type WopiGrantInput = z.input<typeof Grant>;

const keyOf = (authSecret: string) => `wopi-access-token:${authSecret}`;

export function issueWopiToken(
  authSecret: string,
  grant: WopiGrantInput,
  ttlMs = WOPI_TOKEN_TTL_MS,
) {
  const expiresAt = Date.now() + ttlMs;
  return {
    token: signValue(keyOf(authSecret), JSON.stringify(grant), ttlMs),
    expiresAt,
  };
}

/** The grant of a valid, unexpired token; null otherwise. */
export function readWopiToken(authSecret: string, token: string): WopiGrant | null {
  const payload = verifySigned(keyOf(authSecret), token);
  if (payload === null) return null;
  try {
    const parsed = Grant.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
