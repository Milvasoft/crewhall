import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { pushDevices, users, type DbOrTx } from '@crewhall/db';
import { CALL_RING_SECONDS, type VoipPush } from '@crewhall/shared';
import type { Env } from '../../env';
import { declineUrl } from '../meet/voip';
import { apnsConfig, ApnsTransientError, sendVoipTo, type ApnsEnvironment } from './apns';

/**
 * Operators' check of the APNs setup (`crewhall voip-test`): a made-up call rings the person's
 * iPhones (or one raw token) through CallKit; `end` ends a test call that is still showing.
 * The call does not exist, so answering it in the app finds nothing and declining is refused.
 */
export async function sendTestVoip(
  env: Env,
  db: DbOrTx,
  input: { email?: string | undefined; token?: string | undefined; end?: string | undefined },
) {
  const cfg = apnsConfig(env);
  if (!cfg) {
    throw new Error('APNs is not set up: APNS_KEY_P8 or _PATH, _KEY_ID, _TEAM_ID, _BUNDLE_ID');
  }
  const tokens: {
    token: string;
    userId: string | null;
    orgId: string | null;
    apnsEnvironment: ApnsEnvironment | null;
  }[] = [];
  if (input.token) {
    tokens.push({ token: input.token, userId: null, orgId: null, apnsEnvironment: null });
  }
  if (input.email) {
    const rows = await db
      .select({
        token: pushDevices.expoToken,
        userId: pushDevices.userId,
        orgId: pushDevices.orgId,
        apnsEnvironment: pushDevices.apnsEnvironment,
      })
      .from(pushDevices)
      .innerJoin(users, eq(users.id, pushDevices.userId))
      .where(
        and(
          eq(users.email, input.email.toLowerCase()),
          eq(pushDevices.provider, 'voip'),
          isNull(pushDevices.disabledAt),
        ),
      );
    tokens.push(...rows);
  }
  if (!tokens.length)
    throw new Error('no VoIP device: give --email of a person with one, or --token');
  const callId = input.end ?? randomUUID();
  const expiresAt = new Date(Date.now() + CALL_RING_SECONDS * 1000);
  const out: { token: string; result: string }[] = [];
  for (const t of tokens) {
    const payload: VoipPush = input.end
      ? { type: 'meet.call_end', callId, notificationId: null }
      : {
          type: 'meet.call',
          callId,
          notificationId: null,
          callerId: null,
          callerName: 'Crewhall',
          callerImageUrl: null,
          video: false,
          invite: false,
          title: 'Crewhall test araması',
          body: 'VoIP push denemesi',
          conversationId: null,
          url: '/',
          expiresAt: expiresAt.toISOString(),
          declineUrl: declineUrl(env, {
            callId,
            userId: t.userId ?? randomUUID(),
            orgId: t.orgId ?? randomUUID(),
          }),
        };
    const sent = await sendVoipTo(cfg, t, payload, expiresAt).catch((err: unknown) => {
      if (err instanceof ApnsTransientError) {
        return { result: { ok: false as const, reason: err.message }, environment: null };
      }
      throw err;
    });
    const result = sent.result;
    // Tokens are not secrets, but the start is enough to tell devices apart.
    out.push({
      token: `${t.token.slice(0, 8)}…`,
      result: result.ok ? `ok (${sent.environment})` : result.reason,
    });
  }
  return { callId, results: out };
}
