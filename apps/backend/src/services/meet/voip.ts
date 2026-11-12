import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { organizations, orgMembers, users, type DbOrTx } from '@crewhall/db';
import { CALL_RING_SECONDS, toCurrentPath, type VoipPush } from '@crewhall/shared';
import { z } from 'zod';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import { liveMember } from '../guests';
import { toActor } from '../membership';
import type { NotificationRow } from '../notifications/notify';
import { declineCall } from './calls';

/**
 * iOS incoming calls through PushKit and CallKit: the VoIP push payloads and the signed decline
 * link they carry. CallKit's "Reddet" may run while the app has no session, so the link itself
 * names the call and the person, signed with a key derived from AUTH_SECRET, and expires shortly
 * after the ring.
 */

const Token = z.object({ c: z.uuid(), u: z.uuid(), o: z.uuid(), exp: z.number().int() });
type Token = z.infer<typeof Token>;

const key = (secret: string) =>
  createHash('sha256').update(`crewhall:call-decline:${secret}`).digest();
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** A ring may be declined until a minute after it stops. */
const DECLINE_GRACE_SECONDS = 60;

export function signDeclineToken(
  secret: string,
  input: { callId: string; userId: string; orgId: string },
  now = Date.now(),
) {
  const exp = Math.floor(now / 1000) + CALL_RING_SECONDS + DECLINE_GRACE_SECONDS;
  const body = b64(JSON.stringify({ c: input.callId, u: input.userId, o: input.orgId, exp }));
  return `${body}.${b64(createHmac('sha256', key(secret)).update(body).digest())}`;
}

export function verifyDeclineToken(secret: string, token: string, now = Date.now()): Token | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', key(secret)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = Token.safeParse(json);
  if (!parsed.success || parsed.data.exp * 1000 < now) return null;
  return parsed.data;
}

export function declineUrl(env: Env, input: { callId: string; userId: string; orgId: string }) {
  const url = new URL(`/api/v1/meet/calls/${input.callId}/decline-signed`, env.API_URL);
  url.searchParams.set('token', signDeclineToken(env.AUTH_SECRET, input));
  return url.toString();
}

/** The ring of `row` (a meet.call notification) for one person's iPhone. */
export function voipRing(
  env: Env,
  row: NotificationRow,
  callId: string,
  text: { title: string; body: string },
  expiresAt: Date,
): VoipPush {
  const p = row.payload;
  return {
    type: 'meet.call',
    callId,
    notificationId: row.id,
    callerId: row.actorId,
    callerName: typeof p.actorName === 'string' ? p.actorName : '',
    callerImageUrl: typeof p.actorImageUrl === 'string' ? p.actorImageUrl : null,
    video: p.video === true,
    invite: p.invite === true,
    title: text.title,
    body: text.body,
    conversationId: row.conversationId,
    url: toCurrentPath(row.url),
    expiresAt: expiresAt.toISOString(),
    declineUrl: declineUrl(env, { callId, userId: row.userId, orgId: row.orgId }),
  };
}

/** CallKit "Reddet" without a session: declines as the person the token names. */
export async function declineSigned(deps: Deps, callId: string, token: string) {
  const t = verifyDeclineToken(deps.env.AUTH_SECRET, token);
  if (!t || t.c !== callId) throw new AppError('forbidden');
  const a = await actorOf(deps.db, t.o, t.u);
  if (!a) throw new AppError('forbidden');
  await declineCall(deps, a, callId, false);
}

async function actorOf(db: DbOrTx, orgId: string, userId: string) {
  const [row] = await db
    .select({ member: orgMembers, org: organizations, name: users.name })
    .from(orgMembers)
    .innerJoin(organizations, eq(organizations.id, orgMembers.organizationId))
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(and(eq(orgMembers.userId, userId), eq(orgMembers.organizationId, orgId), liveMember()));
  if (!row) return null;
  return { org: row.org, actor: toActor(row.member), userId, userName: row.name };
}
