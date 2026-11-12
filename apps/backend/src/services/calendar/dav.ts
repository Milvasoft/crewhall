import { and, eq } from 'drizzle-orm';
import { organizations, orgMembers, users } from '@crewhall/db';
import type { McpScope, ModuleKey } from '@crewhall/shared';
import type { Context } from 'hono';
import type { Deps } from '../../deps';
import { clientIp } from '../../http/client-ip';
import type { AppEnv, OrgRow } from '../../http/types';
import { checkIpAllowlist } from '../identity/guard';
import { isModuleEnabled } from '../identity/modules';
import { toActor } from '../membership';
import { TOKEN_PREFIX } from '../mcp/crypto';
import { effectiveScopes, getPolicy, moduleOn } from '../mcp/policy';
import { resolveBearer, touchPrincipal, type McpPrincipal } from '../mcp/principal';
import { REST_RESOURCE } from '../mcp/rest';
import { escapeXml, type XmlElement } from './xml';

/**
 * Shared pieces of the CalDAV and CardDAV servers: personal-token Basic auth and the WebDAV
 * multistatus answers. Each server keeps its own collections and resources.
 */

export const DAV_NS = {
  D: 'DAV:',
  C: 'urn:ietf:params:xml:ns:caldav',
  CR: 'urn:ietf:params:xml:ns:carddav',
  CS: 'http://calendarserver.org/ns/',
  A: 'http://apple.com/ns/ical/',
} as const;

const PREFIX: Record<string, string> = Object.fromEntries(
  Object.entries(DAV_NS).map(([p, ns]) => [ns, p]),
);

export interface DavAuth {
  org: OrgRow;
  member: typeof orgMembers.$inferSelect;
  user: typeof users.$inferSelect;
  principal: McpPrincipal;
  scopes: McpScope[];
}

export function unauthorized(c: Context<AppEnv>, realm: string) {
  c.header('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
  return c.text('Unauthorized', 401);
}

function bearerOf(c: Context<AppEnv>): string | null {
  const h = c.req.header('authorization') ?? '';
  const basic = /^Basic\s+(\S+)$/i.exec(h);
  if (basic) {
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    return pass.startsWith(TOKEN_PREFIX.pat) ? pass : null;
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(h)?.[1];
  return bearer?.startsWith(TOKEN_PREFIX.pat) ? bearer : null;
}

/**
 * HTTP Basic with a personal API token as the password (the user name is ignored; Bearer works
 * too). The token's expiry, IP list and the org's MCP policy apply, like on the REST API; the
 * module must be on. Returns a Response to send when the request is refused.
 */
export async function authenticateDav(
  deps: Deps,
  c: Context<AppEnv>,
  module: ModuleKey,
  realm: string,
): Promise<DavAuth | Response> {
  const token = bearerOf(c);
  if (!token) return unauthorized(c, realm);
  const ip = clientIp(c);
  const principal = await resolveBearer(deps.db, token, REST_RESOURCE, ip);
  if (!principal || principal.kind !== 'token') return unauthorized(c, realm);
  const [org] = await deps.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, principal.orgId));
  const [member] = await deps.db
    .select()
    .from(orgMembers)
    .where(
      and(eq(orgMembers.organizationId, principal.orgId), eq(orgMembers.userId, principal.userId)),
    );
  const [user] = await deps.db.select().from(users).where(eq(users.id, principal.userId));
  if (!org || !member || member.status !== 'active' || !user) return unauthorized(c, realm);
  if (!moduleOn(org, 'mcp') || !(await isModuleEnabled(deps.db, org.id, module))) {
    return c.text('Forbidden', 403);
  }
  const policy = await getPolicy(deps.db, org.id);
  if (!policy.enabled || !policy.patsEnabled) return c.text('Forbidden', 403);
  await checkIpAllowlist(deps.db, org.id, c.req.method, new URL(c.req.url).pathname, ip);
  await touchPrincipal(deps.db, principal, ip);
  return { org, member, user, principal, scopes: effectiveScopes(policy, principal.scopes) };
}

export const actorOf = (a: DavAuth) => ({
  org: a.org,
  actor: toActor(a.member),
  userId: a.user.id,
  userName: a.user.name,
  userEmail: a.user.email,
});

// ---- multistatus -------------------------------------------------------------------------------

export type PropValue = string | null;
export interface PropResult {
  ok: [string, string, PropValue][];
  missing: [string, string][];
}
export type Getter = (ns: string, name: string) => PropValue | undefined;

export function propXml(ns: string, name: string, value: PropValue, i: number) {
  const p = PREFIX[ns];
  const tag = p ? `${p}:${name}` : `X${i}:${name}`;
  const decl = p ? '' : ` xmlns:X${i}="${escapeXml(ns)}"`;
  return value === null || value === '' ? `<${tag}${decl}/>` : `<${tag}${decl}>${value}</${tag}>`;
}

export function responseXml(href: string, r: PropResult) {
  const parts = [`<D:response><D:href>${escapeXml(href)}</D:href>`];
  if (r.ok.length) {
    parts.push(
      `<D:propstat><D:prop>${r.ok.map(([ns, n, v], i) => propXml(ns, n, v, i)).join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`,
    );
  }
  if (r.missing.length) {
    parts.push(
      `<D:propstat><D:prop>${r.missing.map(([ns, n], i) => propXml(ns, n, null, i + 100)).join('')}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>`,
    );
  }
  parts.push('</D:response>');
  return parts.join('');
}

export const missingXml = (href: string) =>
  `<D:response><D:href>${escapeXml(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;

export function multistatus(c: Context<AppEnv>, responses: string[]) {
  const decl = Object.entries(DAV_NS)
    .map(([p, ns]) => `xmlns:${p}="${ns}"`)
    .join(' ');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    `<D:multistatus ${decl}>` +
    responses.join('') +
    '</D:multistatus>';
  return c.body(body, 207, { 'Content-Type': 'application/xml; charset=utf-8' });
}

/** Requested props (or a default set for allprop / an empty body). */
export function requested(
  body: XmlElement | null,
  defaults: [string, string][],
): [string, string][] {
  const prop = body?.children.find((c) => c.ns === DAV_NS.D && c.name === 'prop');
  if (!prop) return defaults;
  return prop.children.map((p) => [p.ns, p.name]);
}

export function answer(props: [string, string][], get: Getter): PropResult {
  const r: PropResult = { ok: [], missing: [] };
  for (const [ns, name] of props) {
    const v = get(ns, name);
    if (v === undefined) r.missing.push([ns, name]);
    else r.ok.push([ns, name, v]);
  }
  return r;
}

export const hrefXml = (h: string) => `<D:href>${escapeXml(h)}</D:href>`;

export const PRIVILEGES_READ =
  '<D:privilege><D:read/></D:privilege><D:privilege><D:read-current-user-privilege-set/></D:privilege>';
export const PRIVILEGES_WRITE =
  PRIVILEGES_READ +
  '<D:privilege><D:write/></D:privilege><D:privilege><D:write-content/></D:privilege><D:privilege><D:write-properties/></D:privilege><D:privilege><D:bind/></D:privilege><D:privilege><D:unbind/></D:privilege>';

/** If-Match / If-None-Match against the current ETag (null = no resource). */
export function preconditionFails(c: Context<AppEnv>, etag: string | null) {
  const ifMatch = c.req.header('if-match');
  const ifNone = c.req.header('if-none-match');
  if (ifNone === '*' && etag) return true;
  if (ifMatch && (!etag || (ifMatch !== '*' && ifMatch !== etag))) return true;
  return false;
}
