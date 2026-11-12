import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Collab tokens (doc 17 §3 "Belgeye özel kısa ömürlü jeton (api imzalar)"): the api signs
 * `{ document, user, org, source, exp }` with a key derived from AUTH_SECRET; the collab
 * server verifies it in onAuthenticate and then checks the person's rights itself.
 * The same key signs internal calls from the api to the collab server.
 */

const Payload = z.object({
  v: z.literal(1),
  d: z.string(),
  u: z.uuid(),
  o: z.uuid(),
  src: z.enum(['web', 'mobile', 'mcp', 'api']),
  exp: z.number().int(),
});
export type CollabTokenPayload = z.infer<typeof Payload>;

const key = (secret: string, purpose: string) =>
  createHash('sha256').update(`crewhall:${purpose}:${secret}`).digest();

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function signCollabToken(secret: string, payload: Omit<CollabTokenPayload, 'v'>): string {
  const body = b64(JSON.stringify({ v: 1, ...payload }));
  const sig = createHmac('sha256', key(secret, 'collab-token')).update(body).digest();
  return `${body}.${b64(sig)}`;
}

/** The payload when the signature holds and the token has not expired, else null. */
export function verifyCollabToken(
  secret: string,
  token: string,
  now = Date.now(),
): CollabTokenPayload | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key(secret, 'collab-token')).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = Payload.safeParse(json);
  if (!parsed.success || parsed.data.exp * 1000 < now) return null;
  return parsed.data;
}

/** HMAC of an internal api → collab request body (header `x-crewhall-signature`). */
export function signInternal(secret: string, body: string, at = Date.now()): string {
  const ts = Math.floor(at / 1000);
  const sig = createHmac('sha256', key(secret, 'collab-internal')).update(`${ts}.${body}`).digest();
  return `${ts}.${b64(sig)}`;
}

/** Accepts signatures at most 60 s old. */
export function verifyInternal(secret: string, body: string, header: string | undefined) {
  if (!header) return false;
  const [ts, sig] = header.split('.');
  const seconds = Number(ts);
  if (!sig || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 60) return false;
  const expected = createHmac('sha256', key(secret, 'collab-internal'))
    .update(`${seconds}.${body}`)
    .digest();
  const given = Buffer.from(sig, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
