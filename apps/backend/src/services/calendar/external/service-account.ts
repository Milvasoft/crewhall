import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import { AppError } from '../../../http/errors';
import { calendarFetch, ProviderError } from './http';

/**
 * Org-wide Google access without anyone connecting: a Workspace service account with
 * domain-wide delegation signs a JWT for the person (`sub`) it acts as and trades it for an
 * access token (RFC 7523). Used by the Workspace directory sync (as the admin) and by
 * domain-wide calendar sync (as each person).
 */

const KeyFile = z.object({
  type: z.literal('service_account'),
  client_email: z.email(),
  private_key: z.string().includes('PRIVATE KEY'),
  token_uri: z.url().optional(),
});

export interface ServiceAccountKey {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/** The JSON key file Google Cloud gives for a service account; validation_failed otherwise. */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = null;
  }
  const key = KeyFile.safeParse(raw);
  if (!key.success) {
    throw new AppError('validation_failed', {
      field: 'serviceAccountKey',
      reason: 'service_account_key_invalid',
    });
  }
  return {
    clientEmail: key.data.client_email,
    privateKey: key.data.private_key,
    tokenUri: key.data.token_uri ?? 'https://oauth2.googleapis.com/token',
  };
}

const cache = new Map<string, { token: string; until: number }>();

/** Tests start from an empty token cache. */
export function clearServiceAccountTokens() {
  cache.clear();
}

/** An access token for `scope` acting as `subject`; cached until a minute before it expires. */
export async function serviceAccountToken(
  key: ServiceAccountKey,
  scope: string,
  subject: string,
): Promise<string> {
  const cacheKey = `${key.clientEmail}\n${scope}\n${subject.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.until > Date.now()) return hit.token;
  let signer: Awaited<ReturnType<typeof importPKCS8>>;
  try {
    signer = await importPKCS8(key.privateKey, 'RS256');
  } catch {
    throw new ProviderError(400, 'service_account_key_invalid');
  }
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(key.clientEmail)
    .setSubject(subject)
    .setAudience(key.tokenUri)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signer);
  let res: Response;
  try {
    res = await calendarFetch(key.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
  } catch {
    throw new ProviderError(0, 'unreachable');
  }
  const json = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (!res.ok || !json?.access_token) {
    // unauthorized_client: delegation not granted for this scope in the Workspace admin console.
    throw new ProviderError(res.status || 400, json?.error ?? `http_${res.status}`);
  }
  cache.set(cacheKey, {
    token: json.access_token,
    until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000,
  });
  return json.access_token;
}
