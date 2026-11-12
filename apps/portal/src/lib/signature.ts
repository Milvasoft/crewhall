import { createHmac, timingSafeEqual } from 'node:crypto';
import { PortalRevalidatePayload } from '@crewhall/shared';

/** Calls older or newer than this are rejected (replay protection). */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export const SIGNATURE_HEADER = 'x-portal-signature';

export function sign(secret: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

export type VerifyResult =
  { ok: true; payload: PortalRevalidatePayload } | { ok: false; status: 400 | 401; reason: string };

/**
 * Verifies a Hub revalidate call: HMAC-SHA256 of the raw body (timing-safe compare), a valid
 * payload, and a timestamp within ±5 minutes of `now`.
 */
export function verifyRevalidate(
  secret: string,
  rawBody: string,
  signature: string | null,
  now: number = Date.now(),
): VerifyResult {
  if (!signature) return { ok: false, status: 401, reason: 'missing signature' };
  const expected = Buffer.from(sign(secret, rawBody), 'utf8');
  const given = Buffer.from(signature.trim(), 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, status: 401, reason: 'bad signature' };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }
  const parsed = PortalRevalidatePayload.safeParse(json);
  if (!parsed.success) return { ok: false, status: 400, reason: 'invalid payload' };
  if (Math.abs(now - parsed.data.ts) > MAX_SKEW_MS) {
    return { ok: false, status: 401, reason: 'stale timestamp' };
  }
  return { ok: true, payload: parsed.data };
}
