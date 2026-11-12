import { eq } from 'drizzle-orm';
import { organizations, users } from '@crewhall/db';
import {
  INTEGRATION_TOKEN_ENDPOINTS,
  type EndpointName,
  type McpVia,
  type OrgSettings,
} from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { AppEnv, AuthSession, AuthUser } from '../../http/types';
import { clientByClientId, stillAllowed, verifyOwnJwt } from '../identity/oidc-provider';
import { integrationOn } from './app';

/**
 * The Outlook add-in and the Teams app sign in with Crewhall's own OIDC provider (their
 * built-in public clients, PKCE) and call the REST API with the access token. The token acts
 * as its person, but only on the endpoints that integration needs, only while the
 * integration is on, and only while the person may still use the client.
 */

const JWT = /^Bearer\s+(eyJ[\w-]*\.[\w-]+\.[\w-]+)$/i;

export const isIntegrationRequest = (c: Context<AppEnv>) =>
  JWT.test(c.req.header('authorization') ?? '');

export interface IntegrationAuth {
  user: AuthUser;
  session: AuthSession;
  via: McpVia;
}

function invalid(c: Context<AppEnv>): never {
  c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
  throw new AppError('unauthenticated');
}

export async function authenticateIntegration(
  deps: Deps,
  c: Context<AppEnv>,
  name: EndpointName,
): Promise<IntegrationAuth> {
  const token = JWT.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  const verified = await verifyOwnJwt(deps, token).catch(() => null);
  if (!verified || verified.typ !== 'at+jwt') invalid(c);
  const payload = verified.payload as {
    sub?: string;
    client_id?: string;
    sid?: string;
    jti?: string;
    exp?: number;
  };
  const client = payload.client_id ? await clientByClientId(deps.db, payload.client_id) : null;
  const integration = client?.integration;
  if (!client || !payload.sub || (integration !== 'outlook' && integration !== 'teams')) invalid(c);

  const [org] = await deps.db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, client.orgId));
  if (!org || !integrationOn(org.settings as OrgSettings, integration)) {
    throw new AppError('integration_disabled', { integration });
  }
  if (!INTEGRATION_TOKEN_ENDPOINTS[integration].includes(name)) {
    throw new AppError('forbidden', { reason: 'integration_token', endpoint: name });
  }
  if (!(await stillAllowed(deps, client, payload.sub))) invalid(c);
  const [user] = await deps.db.select().from(users).where(eq(users.id, payload.sub));
  if (!user) invalid(c);

  const session = {
    // The browser session the person signed in with (trusted IdP MFA still applies).
    id: payload.sid ?? payload.jti ?? client.id,
    token: '',
    userId: user.id,
    // Never "just signed in": re-verification needs a real session.
    createdAt: new Date(0),
    updatedAt: new Date(0),
    expiresAt: new Date((payload.exp ?? Date.now() / 1000 + 60) * 1000),
    ipAddress: null,
    userAgent: c.req.header('user-agent') ?? null,
    activeOrganizationId: client.orgId,
  } as unknown as AuthSession;
  return {
    user: user as unknown as AuthUser,
    session,
    via: { kind: 'oauth', name: client.name, grantId: null, tokenId: null },
  };
}
