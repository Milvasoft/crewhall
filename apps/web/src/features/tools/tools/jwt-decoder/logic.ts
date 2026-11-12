// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/jwt-decoder/logic.ts. See THIRD_PARTY.md.
/**
 * Decodes (does NOT verify) a JWT locally. Signature verification requires the
 * secret/public key and is intentionally out of scope here, the UI must not
 * imply the token is trusted, only decoded.
 */

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
  raw: { header: string; payload: string };
}

function base64UrlDecode(segment: string): string {
  let b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad === 1) throw new Error('Malformed Base64URL segment.');

  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.trim().split('.');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error('A JWT has 2–3 dot-separated segments.');
  }
  const h = parts[0]!;
  const p = parts[1]!;
  const s = parts[2] ?? '';

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(base64UrlDecode(h));
  } catch {
    throw new Error('Header is not valid Base64URL-encoded JSON.');
  }
  try {
    payload = JSON.parse(base64UrlDecode(p));
  } catch {
    throw new Error('Payload is not valid Base64URL-encoded JSON.');
  }

  return { header, payload, signature: s, raw: { header: h, payload: p } };
}

const TIME_CLAIMS = ['exp', 'iat', 'nbf'] as const;

export interface ClaimRow {
  key: string;
  value: string;
  note?: string;
}

/** Human-friendly claim rows, with time claims rendered as dates + status. */
export function claimRows(payload: Record<string, unknown>, now = Date.now()): ClaimRow[] {
  return Object.entries(payload).map(([key, value]) => {
    if (TIME_CLAIMS.includes(key as (typeof TIME_CLAIMS)[number]) && typeof value === 'number') {
      const date = new Date(value * 1000);
      let note = date.toISOString();
      if (key === 'exp') note += value * 1000 < now ? ' · expired' : ' · valid';
      if (key === 'nbf') note += value * 1000 > now ? ' · not yet valid' : '';
      return { key, value: String(value), note };
    }
    return {
      key,
      value: typeof value === 'object' ? JSON.stringify(value) : String(value),
    };
  });
}

export function isExpired(payload: Record<string, unknown>, now = Date.now()): boolean {
  return typeof payload.exp === 'number' && payload.exp * 1000 < now;
}
