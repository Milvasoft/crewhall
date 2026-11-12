import { desc, eq } from 'drizzle-orm';
import { mcpClients, type DbOrTx } from '@crewhall/db';
import type { McpClientInfo } from '@crewhall/shared';
import { z } from 'zod';
import { primaryOrg } from '../brand';
import { getPolicy } from './policy';
import { TOKEN_PREFIX, newSecret, randomBase62, sha256 } from './crypto';

export type ClientRow = typeof mcpClients.$inferSelect;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'about:',
  'blob:',
]);

/**
 * Which redirect URIs a client may register (OAuth 2.1, RFC 8252): https anywhere,
 * http only on a loopback address, or a private-use scheme for native apps. Never a
 * fragment, never a script or data URL.
 */
export function redirectUriAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.includes('#')) return false;
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === 'https:') return url.hostname.length > 0;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

const isLoopback = (url: URL) => url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

/**
 * Exact match against the registered list; for loopback http the port may differ
 * (RFC 8252 §7.3: native apps pick a free port at run time).
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(req)) return false;
  return registered.some((r) => {
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return (
      isLoopback(reg) &&
      reg.hostname === req.hostname &&
      reg.pathname === req.pathname &&
      reg.search === req.search &&
      reg.username === req.username &&
      reg.password === req.password
    );
  });
}

export function redirectHost(uri: string): string {
  try {
    const url = new URL(uri);
    return url.host || url.protocol;
  } catch {
    return uri;
  }
}

/** RFC 7591 client metadata we accept; unknown fields are ignored. */
export const RegistrationRequest = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(120).optional(),
  token_endpoint_auth_method: z
    .enum(['none', 'client_secret_post', 'client_secret_basic'])
    .optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(100).optional(),
  client_uri: z.string().max(2000).optional(),
  logo_uri: z.string().max(2000).optional(),
  scope: z.string().max(1000).optional(),
});
export type RegistrationRequest = z.infer<typeof RegistrationRequest>;

export class RegistrationError extends Error {
  constructor(
    readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    readonly description: string,
  ) {
    super(description);
  }
}

/** Dynamic client registration (RFC 7591) into mcp_clients; pending when the org lists clients. */
export async function registerClient(db: DbOrTx, input: RegistrationRequest, ip: string | null) {
  for (const uri of input.redirect_uris) {
    if (!redirectUriAllowed(uri)) {
      throw new RegistrationError('invalid_redirect_uri', `redirect_uri not allowed: ${uri}`);
    }
  }
  const grants = input.grant_types ?? ['authorization_code', 'refresh_token'];
  if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    throw new RegistrationError('invalid_client_metadata', 'unsupported grant_types');
  }
  if ((input.response_types ?? ['code']).some((r) => r !== 'code')) {
    throw new RegistrationError('invalid_client_metadata', 'unsupported response_types');
  }
  const org = await primaryOrg(db);
  const policy = org ? await getPolicy(db, org.id) : null;
  const method = input.token_endpoint_auth_method ?? 'none';
  const secret = method === 'none' ? null : newSecret('mcs_', 48);
  const [row] = await db
    .insert(mcpClients)
    .values({
      orgId: org?.id ?? null,
      clientId: `${TOKEN_PREFIX.client}${randomBase62(24)}`,
      name: input.client_name ?? redirectHost(input.redirect_uris[0]!),
      softwareId: input.software_id ?? null,
      softwareVersion: input.software_version ?? null,
      clientUri: input.client_uri ?? null,
      logoUri: input.logo_uri ?? null,
      redirectUris: input.redirect_uris,
      tokenEndpointAuthMethod: method,
      clientSecretHash: secret ? sha256(secret) : null,
      registration: 'dcr',
      status: policy?.clientMode === 'listed' ? 'pending' : 'allowed',
      registeredIp: ip,
    })
    .returning();
  const client = row!;
  return {
    client,
    response: {
      client_id: client.clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      ...(client.softwareId ? { software_id: client.softwareId } : {}),
      ...(client.softwareVersion ? { software_version: client.softwareVersion } : {}),
    },
  };
}

export async function clientByClientId(db: DbOrTx, clientId: string) {
  const [row] = await db.select().from(mcpClients).where(eq(mcpClients.clientId, clientId));
  return row ?? null;
}

export function toClientInfo(row: ClientRow): McpClientInfo {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    softwareId: row.softwareId,
    softwareVersion: row.softwareVersion,
    redirectUris: row.redirectUris,
    registration: row.registration,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listClients(db: DbOrTx, orgId: string) {
  const rows = await db
    .select()
    .from(mcpClients)
    .where(eq(mcpClients.orgId, orgId))
    .orderBy(desc(mcpClients.createdAt));
  return rows.map(toClientInfo);
}
