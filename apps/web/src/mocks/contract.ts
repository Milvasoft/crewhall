import {
  buildConnectUrl,
  isAllowedMobileRedirect,
  MOBILE_CONNECT_TTL_SECONDS,
  MOBILE_HANDOFF_TTL_SECONDS,
  SPACE_DELETE_RETENTION_DAYS,
  type OrgSpace,
  can,
  canGrantSpaceRole,
  endpoints,
  HTTP_STATUS_BY_CODE,
  type EndpointDef,
  type CoreEndpointName,
  type EndpointName,
  type ErrorCode,
  type Invitation,
  type OrgMember,
  type OrgRole,
  type ResponseOf,
  type Space,
  type UiPrefs,
  type SpaceMember,
} from '@crewhall/shared';
import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import {
  actorOf,
  currentUser,
  memberOf,
  MockApiError,
  myRole,
  orgCtx,
  randomToken,
  requireUser,
  summary,
  type Resolver,
  type Resolvers,
} from './core';
import { db, newId, save } from './db';
import { chatResolvers, gifActiveMock } from './chat';
import { driveResolvers } from './drive';
import { portalResolvers } from './portal';
import { quickResolvers } from './quick';
import { meetResolvers } from './meet';
import { mcpResolvers } from './mcp';
import { federationResolvers } from './federation';
import { pluginsResolvers } from './plugins';
import { boardsResolvers } from './boards';
import { calendarResolvers } from './calendar';
import { bookingResolvers } from './bookings';
import { contactsResolvers } from './contacts';
import { vaultResolvers } from './vault';
import { statsResolvers } from './stats';
import { wikiResolvers } from './wiki';
import { announcementsResolvers } from './announcements';
import { backupResolvers } from './backups';
import { complianceResolvers } from './compliance';
import { stepupResolvers } from './stepup';
import { formsResolvers } from './forms';
import { tablesResolvers } from './tables';
import { automationsResolvers } from './automations';
import { aiResolvers, searchHits } from './ai';
import { officeResolvers } from './office';
import { deliveryResolvers } from './delivery';
import { desktopReleaseResolvers } from './desktopReleases';
import {
  assertModuleEnabled,
  enabledModulesOf,
  identityBootstrapAuth,
  identityResolvers,
} from './identity';
import { mailResolvers } from './mail';
import { mailInboxResolvers } from './mail-inbox';
import { microsoftResolvers } from './microsoft';
import {
  DEFAULT_BRANDING,
  personalSpace,
  type MockSpace,
  type MockState,
  type MockUser,
} from './seed';

/**
 * MSW handlers generated from the endpoints table: bodies and queries are parsed with the
 * contract schemas (422 on failure) and every response is validated against `response`,
 * so the mock cannot drift from packages/shared.
 */

let latency = 250;
export function setMockLatency(ms: number): void {
  latency = ms;
}

// ---- helpers ----

/** Owners/admins always, everyone when the org requires it; TOTP or a passkey satisfies it. */
function uiPrefsOf(s: MockState, userId: string): UiPrefs {
  const fullWidth = s.uiPagesFullWidth?.[userId];
  return {
    navOrder: s.uiPrefs?.[userId] ?? [],
    ...s.uiSidebar?.[userId],
    ...s.uiRail?.[userId],
    ...(fullWidth !== undefined ? { pagesFullWidth: fullWidth } : {}),
    ...(s.uiPagesHideDone?.[userId] ? { pagesHideDone: s.uiPagesHideDone[userId] } : {}),
  };
}

function twoFactorRequired(s: MockState, u: MockUser): boolean {
  const m = memberOf(s, u.id);
  const required = s.org?.settings.requireTwoFactor || m?.role === 'owner' || m?.role === 'admin';
  return Boolean(required) && !u.twoFactorEnabled && u.passkeys.length === 0;
}

function enforceTwoFactor(s: MockState, u: MockUser) {
  if (twoFactorRequired(s, u)) throw new MockApiError('two_factor_required');
}

function requireOrg(s: MockState, action: Parameters<typeof can>[1]) {
  const u = requireUser(s);
  enforceTwoFactor(s, u);
  if (!can(actorOf(s, u), action, { type: 'org', org: orgCtx(s) })) {
    throw new MockApiError('forbidden');
  }
  return u;
}

function userById(s: MockState, id: string): MockUser {
  const u = s.users.find((x) => x.id === id);
  if (!u) throw new MockApiError('member_not_found');
  return u;
}

function toSpace(s: MockState, sp: MockSpace, userId: string): Space {
  const role = myRole(s, sp.id, userId);
  return {
    id: sp.id,
    kind: sp.kind,
    name: sp.name,
    slug: sp.slug,
    color: sp.color,
    icon: sp.icon,
    myRole: role ?? 'viewer',
    memberCount: s.spaceMembers.filter((x) => x.spaceId === sp.id).length,
    usedBytes: sp.usedBytes,
    quotaBytes: sp.quotaBytes,
    archivedAt: sp.archivedAt,
    createdAt: sp.createdAt,
    isDefault: Boolean(sp.isDefault),
  };
}

function toOrgSpace(s: MockState, sp: MockSpace, userId: string): OrgSpace {
  const ownerId = s.spaceMembers.find((x) => x.spaceId === sp.id && x.role === 'owner')?.userId;
  const owner = ownerId ? s.users.find((x) => x.id === ownerId) : undefined;
  return {
    ...toSpace(s, sp, userId),
    myRole: myRole(s, sp.id, userId),
    owner: owner ? summary(owner) : null,
  };
}

function findSpace(s: MockState, spaceId: string, userId: string, need: Parameters<typeof can>[1]) {
  const sp = s.spaces.find((x) => x.id === spaceId);
  // Non-members get 404 so existence does not leak.
  if (!sp || myRole(s, sp.id, userId) === null) throw new MockApiError('not_found');
  const u = s.users.find((x) => x.id === userId) as MockUser;
  const ok = can(actorOf(s, u), need, {
    type: 'space',
    org: orgCtx(s),
    myRole: myRole(s, sp.id, userId),
  });
  if (!ok) throw new MockApiError('forbidden');
  return sp;
}

function toMember(s: MockState, m: MockState['members'][number]): OrgMember {
  const u = userById(s, m.userId);
  return {
    user: summary(u),
    role: m.role,
    permissions: m.permissions,
    status: m.status,
    twoFactorEnabled: u.twoFactorEnabled,
    joinedAt: m.joinedAt,
    lastSeenAt: m.lastSeenAt,
    lockedUntil: activeLock(s, u.email),
  };
}

/** Lock end for an e-mail while it is still in the future (1.16). */
export function activeLock(s: MockState, email: string): string | null {
  const until = s.auth.lockedUntil[email];
  return until && new Date(until).getTime() > Date.now() ? until : null;
}

/** base64url(SHA-256(verifier)): RFC 7636 S256. */
async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function toInvitation(s: MockState, i: MockState['invitations'][number]): Invitation {
  return {
    id: i.id,
    email: i.email,
    role: i.role,
    invitedBy: summary(userById(s, i.invitedById)),
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
  };
}

function toSpaceMember(s: MockState, sm: MockState['spaceMembers'][number]): SpaceMember {
  return { user: summary(userById(s, sm.userId)), role: sm.role, addedAt: sm.addedAt };
}

function slugify(name: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  const base = name
    .toLocaleLowerCase('tr')
    .replace(/[çğıİöşü]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 2 ? base : `space-${base}x`;
}

function buildMe(s: MockState, u: MockUser): ResponseOf<'me'> {
  const m = memberOf(s, u.id);
  const personal = s.spaces.find((x) => x.kind === 'personal' && x.ownerUserId === u.id);
  return {
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      imageUrl: u.imageUrl,
      locale: u.locale,
      twoFactorEnabled: u.twoFactorEnabled,
      hasPasskey: u.passkeys.length > 0,
    },
    activeOrgId: m && s.org ? s.org.id : null,
    memberships:
      m && s.org
        ? [
            {
              orgId: s.org.id,
              orgName: s.org.name,
              orgSlug: s.org.slug,
              role: m.role,
              permissions: m.permissions,
            },
          ]
        : [],
    personalSpaceId: personal?.id ?? null,
    twoFactorRequired: twoFactorRequired(s, u),
    modules: enabledModulesOf(s),
    installAdmin: m?.role === 'owner',
  };
}

function inviteUrl(request: Request, token: string): string {
  return new URL(request.url).origin + '/invite/' + token;
}

export function joinOrg(s: MockState, u: MockUser, role: OrgRole, spaceIds: string[]): void {
  const now = new Date().toISOString();
  if (!memberOf(s, u.id)) {
    s.members.push({
      userId: u.id,
      role,
      permissions: [],
      status: 'active',
      joinedAt: now,
      lastSeenAt: now,
    });
  }
  if (!s.spaces.some((x) => x.kind === 'personal' && x.ownerUserId === u.id)) {
    const sp = personalSpace(u.id, s.spaces.length + 1, now);
    sp.id = newId();
    s.spaces.push(sp);
    s.spaceMembers.push({ spaceId: sp.id, userId: u.id, role: 'owner', addedAt: now });
  }
  const defaults =
    role === 'guest' ? [] : s.spaces.filter((x) => x.isDefault && !x.archivedAt).map((x) => x.id);
  for (const spaceId of new Set([...defaults, ...spaceIds])) {
    if (!myRole(s, spaceId, u.id)) {
      s.spaceMembers.push({
        spaceId,
        userId: u.id,
        role: role === 'guest' ? 'viewer' : 'editor',
        addedAt: now,
      });
    }
  }
}

// ---- resolvers, one per endpoint ----

/** Brand image slot → the Branding URL field it fills (H5). */
const BRAND_FIELD = {
  logoLight: 'logoLightUrl',
  logoDark: 'logoDarkUrl',
  mark: 'markUrl',
  favicon: 'faviconUrl',
} as const;

/** Deleted spaces (id → deletedAt); restorable for 30 days. */
const deletedSpaces = new Map<string, string>();

type Phase0Name = Exclude<
  CoreEndpointName,
  keyof typeof driveResolvers | keyof typeof quickResolvers
>;

const phase0: Resolvers<Phase0Name> = {
  searchContent: ({ s, query }) => ({ items: searchHits(s, query.q, query.limit) }),

  bootstrap: ({ s }) => ({
    branding: s.org?.branding ?? DEFAULT_BRANDING,
    theme: s.theme,
    needsSetup: s.needsSetup,
    auth: {
      passkey: true,
      signupOpen: false,
      emailEnabled: s.emailEnabled ?? true,
      ...identityBootstrapAuth(s),
    },
    server: {
      version: '0.0.0-mock',
      minMobileVersion: null,
      // Listed only with GIFs on, as the server does; otherwise left out like before.
      ...(gifActiveMock(s) ? { capabilities: ['chat.gif' as const] } : {}),
    },
    ...(s.needsSetup
      ? {
          setup: {
            tokenRequired: Boolean(s.setupToken),
            checks: { database: true, storage: true, smtp: Boolean(s.emailEnabled) },
          },
        }
      : {}),
  }),

  setup: ({ s, body, request }) => {
    if (!s.needsSetup) throw new MockApiError('setup_already_done');
    if (s.setupToken && body.setupToken !== s.setupToken) {
      throw new MockApiError('setup_token_invalid');
    }
    const now = new Date().toISOString();
    const orgId = newId();
    const owner: MockUser = {
      id: newId(),
      name: body.owner.name,
      email: body.owner.email,
      password: body.owner.password,
      imageUrl: null,
      locale: body.org.defaultLocale,
      twoFactorEnabled: false,
      totpPending: false,
      backupCodes: [],
      passkeys: [],
    };
    s.org = {
      id: orgId,
      slug: body.org.slug,
      name: body.org.name,
      branding: {
        ...DEFAULT_BRANDING,
        orgName: body.org.name,
        defaultLocale: body.org.defaultLocale,
      },
      settings: {
        requireTwoFactor: false,
        defaultLocale: body.org.defaultLocale,
        membersCanCreateSpaces: false,
        publicLinksEnabled: true,
      },
      createdAt: now,
    };
    s.users.push(owner);
    const spaces = body.spaces ?? [{ name: body.org.name, color: 's1' as const, isDefault: true }];
    for (const def of spaces) {
      const sp: MockSpace = {
        id: newId(),
        kind: 'shared',
        ownerUserId: null,
        name: def.name,
        slug: slugify(def.name),
        color: def.color,
        icon: null,
        usedBytes: 0,
        quotaBytes: null,
        archivedAt: null,
        createdAt: now,
        isDefault: def.isDefault,
      };
      s.spaces.push(sp);
      s.spaceMembers.push({ spaceId: sp.id, userId: owner.id, role: 'owner', addedAt: now });
    }
    joinOrg(s, owner, 'owner', []);
    const invitations = (body.invitations ?? []).map((i) => {
      const token = newId();
      s.invitations.push({
        id: newId(),
        token,
        email: i.email,
        role: i.role,
        invitedById: owner.id,
        spaceIds: [],
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        createdAt: now,
      });
      return { email: i.email, url: inviteUrl(request, token) };
    });
    s.needsSetup = false;
    s.setupToken = null;
    return { orgId, ownerId: owner.id, invitations };
  },

  setupSmtpTest: ({ s, body }) => {
    if (s.setupToken && body.setupToken !== s.setupToken) {
      throw new MockApiError('setup_token_invalid');
    }
    return {};
  },

  me: ({ s }) => buildMe(s, requireUser(s)),

  updateMe: ({ s, body }) => {
    const u = requireUser(s);
    if (body.name !== undefined) u.name = body.name;
    if (body.locale !== undefined) u.locale = body.locale;
    return buildMe(s, u);
  },

  getUiPrefs: ({ s }) => uiPrefsOf(s, requireUser(s).id),

  updateUiPrefs: ({ s, body }) => {
    const u = requireUser(s);
    s.uiPrefs ??= {};
    if (body.navOrder) s.uiPrefs[u.id] = [...new Set(body.navOrder)];
    // Each sidebar field is stored whole when sent (backend: services/uiPrefs).
    if (body.sidebarWidths || body.sidebarCollapsed) {
      s.uiSidebar ??= {};
      const prev = s.uiSidebar[u.id] ?? {};
      s.uiSidebar[u.id] = {
        ...prev,
        ...(body.sidebarWidths ? { sidebarWidths: { ...body.sidebarWidths } } : {}),
        ...(body.sidebarCollapsed ? { sidebarCollapsed: [...new Set(body.sidebarCollapsed)] } : {}),
      };
    }
    if (body.pagesHideDone) {
      s.uiPagesHideDone = { ...s.uiPagesHideDone, [u.id]: [...new Set(body.pagesHideDone)] };
    }
    if (body.railOrder || body.railHidden || body.railShortcuts) {
      s.uiRail ??= {};
      s.uiRail[u.id] = {
        ...s.uiRail[u.id],
        ...(body.railOrder ? { railOrder: [...new Set(body.railOrder)] } : {}),
        ...(body.railHidden ? { railHidden: [...new Set(body.railHidden)] } : {}),
        ...(body.railShortcuts ? { railShortcuts: { ...body.railShortcuts } } : {}),
      };
    }
    if (body.pagesFullWidth !== undefined) {
      s.uiPagesFullWidth = { ...s.uiPagesFullWidth, [u.id]: body.pagesFullWidth };
    }
    return uiPrefsOf(s, u.id);
  },

  // H5: the mock keeps the picture as a data URL (no S3, no resizing).
  uploadAvatar: ({ s, body }) => {
    const u = requireUser(s);
    u.imageUrl = body.data.startsWith('data:') ? body.data : `data:image/jpeg;base64,${body.data}`;
    return { imageUrl: u.imageUrl };
  },

  deleteAvatar: ({ s }) => {
    requireUser(s).imageUrl = null;
    return {};
  },

  switchOrg: ({ s, body }) => {
    const u = requireUser(s);
    if (s.org?.id !== body.orgId) throw new MockApiError('not_found');
    return buildMe(s, u);
  },

  listSessions: ({ s }) => {
    const u = requireUser(s);
    return {
      items: s.sessions
        .filter((x) => x.userId === u.id)
        .map((x) => ({ ...x, current: x.id === s.auth.sessionId }))
        .sort((a, b) =>
          a.current ? -1 : b.current ? 1 : b.lastActiveAt.localeCompare(a.lastActiveAt),
        )
        .map(({ userId: _u, ...rest }) => rest),
    };
  },

  revokeSession: ({ s, params }) => {
    const u = requireUser(s);
    if (params.sessionId === s.auth.sessionId) {
      throw new MockApiError('bad_request', 'Use sign-out');
    }
    const before = s.sessions.length;
    s.sessions = s.sessions.filter((x) => !(x.id === params.sessionId && x.userId === u.id));
    if (s.sessions.length === before) throw new MockApiError('not_found');
    return {};
  },

  getOrg: ({ s }) => {
    const u = requireUser(s);
    enforceTwoFactor(s, u);
    if (!s.org) throw new MockApiError('not_found');
    return s.org;
  },

  updateOrg: ({ s, body }) => {
    requireOrg(s, 'org.update_settings');
    const org = s.org!;
    if (body.name) {
      org.name = body.name;
      org.branding.orgName = body.name;
    }
    if (body.settings) org.settings = { ...org.settings, ...body.settings };
    return org;
  },

  updateBranding: ({ s, body }) => {
    requireOrg(s, 'org.update_branding');
    const org = s.org!;
    org.branding = { ...org.branding, ...body };
    if (body.orgName) org.name = body.orgName;
    return org.branding;
  },

  uploadBrandAsset: ({ s, body }) => {
    requireOrg(s, 'org.update_branding');
    const org = s.org!;
    const url = body.data.startsWith('data:') ? body.data : `data:image/png;base64,${body.data}`;
    org.branding = { ...org.branding, [BRAND_FIELD[body.slot]]: url };
    return org.branding;
  },

  deleteBrandAsset: ({ s, params }) => {
    requireOrg(s, 'org.update_branding');
    const org = s.org!;
    const slot = params.slot as keyof typeof BRAND_FIELD;
    if (!BRAND_FIELD[slot]) throw new MockApiError('not_found');
    org.branding = { ...org.branding, [BRAND_FIELD[slot]]: null };
    return org.branding;
  },

  getTheme: ({ s }) => {
    requireOrg(s, 'org.update_branding');
    return s.theme;
  },

  publishTheme: ({ s, body }) => {
    requireOrg(s, 'org.update_branding');
    s.theme = { ...body, version: s.theme.version + 1 };
    return s.theme;
  },

  listMembers: ({ s, query }) => {
    const u = requireUser(s);
    enforceTwoFactor(s, u);
    const q = query.q?.toLocaleLowerCase('tr');
    const items = s.members
      .map((m) => toMember(s, m))
      .filter((m) => (query.role ? m.role === query.role : true))
      .filter((m) => (query.status ? m.status === query.status : true))
      .filter((m) =>
        q ? m.user.name.toLocaleLowerCase('tr').includes(q) || m.user.email.includes(q) : true,
      );
    const start = query.cursor ? Number(query.cursor) : 0;
    const pageItems = items.slice(start, start + query.limit);
    const next = start + query.limit < items.length ? String(start + query.limit) : null;
    return { items: pageItems, nextCursor: next };
  },

  unlockMember: ({ s, params }) => {
    requireOrg(s, 'org.manage_members');
    const m = memberOf(s, params.userId ?? '');
    if (!m) throw new MockApiError('member_not_found');
    const u = userById(s, m.userId);
    delete s.auth.lockedUntil[u.email];
    s.auth.failed[u.email] = 0;
    return toMember(s, m);
  },

  createMobileConnect: ({ s, request }) => {
    const u = requireUser(s);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + MOBILE_CONNECT_TTL_SECONDS * 1000).toISOString();
    s.mobileConnect = [...(s.mobileConnect ?? []), { token, userId: u.id, expiresAt }];
    return { url: buildConnectUrl(new URL(request.url).origin, token), expiresAt };
  },

  getMobileConnect: ({ s, params }) => {
    const ticket = (s.mobileConnect ?? []).find((x) => x.token === params.token);
    // Single use: consumed on read, whatever happens next.
    s.mobileConnect = (s.mobileConnect ?? []).filter((x) => x !== ticket);
    if (!ticket || new Date(ticket.expiresAt).getTime() < Date.now() || !s.org) {
      throw new MockApiError('mobile_connect_invalid');
    }
    const u = userById(s, ticket.userId);
    return { email: u.email, name: u.name, orgName: s.org.name };
  },

  createMobileHandoff: ({ s, body }) => {
    const u = requireUser(s);
    if (!isAllowedMobileRedirect(body.redirectUri)) throw new MockApiError('bad_request');
    const code = randomToken();
    const expiresAt = new Date(Date.now() + MOBILE_HANDOFF_TTL_SECONDS * 1000).toISOString();
    s.mobileHandoff = [
      ...(s.mobileHandoff ?? []),
      {
        code,
        challenge: body.codeChallenge,
        redirectUri: body.redirectUri,
        userId: u.id,
        expiresAt,
      },
    ];
    return { code, expiresAt };
  },

  exchangeMobileHandoff: async ({ s, body }) => {
    const entry = (s.mobileHandoff ?? []).find((x) => x.code === body.code);
    s.mobileHandoff = (s.mobileHandoff ?? []).filter((x) => x !== entry);
    if (
      !entry ||
      new Date(entry.expiresAt).getTime() < Date.now() ||
      (await s256(body.codeVerifier)) !== entry.challenge
    ) {
      throw new MockApiError('mobile_handoff_invalid');
    }
    const now = new Date().toISOString();
    const id = newId();
    s.sessions.push({
      id,
      userId: entry.userId,
      userAgent: 'Crewhall mobile',
      ip: null,
      createdAt: now,
      lastActiveAt: now,
    });
    return { token: id, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  },

  updateMember: ({ s, params, body }) => {
    requireOrg(s, 'org.manage_members');
    const m = memberOf(s, params.userId ?? '');
    if (!m) throw new MockApiError('member_not_found');
    if (m.role === 'owner') throw new MockApiError('cannot_change_owner');
    if (body.role) m.role = body.role;
    if (body.status) m.status = body.status;
    if (body.permissions) m.permissions = body.permissions;
    return toMember(s, m);
  },

  listInvitations: ({ s }) => {
    requireOrg(s, 'org.invite');
    return { items: s.invitations.map((i) => toInvitation(s, i)) };
  },

  createInvitation: ({ s, body, request }) => {
    const u = requireOrg(s, 'org.invite');
    if (body.role === 'admin' && memberOf(s, u.id)?.role !== 'owner') {
      throw new MockApiError('forbidden');
    }
    if (s.users.some((x) => x.email === body.email && memberOf(s, x.id))) {
      throw new MockApiError('conflict', 'Already a member');
    }
    const inv = {
      id: newId(),
      token: newId(),
      email: body.email,
      role: body.role,
      invitedById: u.id,
      spaceIds: body.spaceIds,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    s.invitations = s.invitations.filter((i) => i.email !== body.email);
    s.invitations.push(inv);
    return { ...toInvitation(s, inv), url: inviteUrl(request, inv.token) };
  },

  revokeInvitation: ({ s, params }) => {
    requireOrg(s, 'org.invite');
    s.invitations = s.invitations.filter((i) => i.id !== params.invitationId);
    return {};
  },

  getInvitation: ({ s, params }) => {
    const inv = s.invitations.find((i) => i.token === params.token);
    if (!inv || !s.org) throw new MockApiError('not_found');
    if (new Date(inv.expiresAt).getTime() < Date.now()) {
      throw new MockApiError('invitation_expired');
    }
    const defaults =
      inv.role === 'guest' ? [] : s.spaces.filter((x) => x.isDefault && !x.archivedAt);
    const extra = s.spaces.filter((x) => inv.spaceIds.includes(x.id));
    const spaces = [...new Map([...defaults, ...extra].map((x) => [x.id, x])).values()].map(
      (x) => ({
        id: x.id,
        name: x.name,
        role: inv.role === 'guest' ? ('viewer' as const) : ('editor' as const),
      }),
    );
    return {
      orgName: s.org.name,
      invitedByName: userById(s, inv.invitedById).name,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
      spaces,
      hasAccount: s.users.some((x) => x.email === inv.email),
    };
  },

  acceptInvitation: ({ s, params }) => {
    const u = requireUser(s);
    const inv = s.invitations.find((i) => i.token === params.token);
    if (!inv) throw new MockApiError('not_found');
    if (new Date(inv.expiresAt).getTime() < Date.now()) {
      throw new MockApiError('invitation_expired');
    }
    if (inv.email !== u.email) throw new MockApiError('invitation_email_mismatch');
    joinOrg(s, u, inv.role, inv.spaceIds);
    s.invitations = s.invitations.filter((i) => i.id !== inv.id);
    return buildMe(s, u);
  },

  listOrgSpaces: ({ s, query }) => {
    const u = requireOrg(s, 'org.manage_spaces');
    const archived = query.archived ?? false;
    return {
      items: s.spaces
        .filter((sp) => sp.kind === 'shared')
        .filter((sp) => (archived ? sp.archivedAt !== null : sp.archivedAt === null))
        .map((sp) => toOrgSpace(s, sp, u.id)),
    };
  },

  listSpaces: ({ s, query }) => {
    const u = requireUser(s);
    enforceTwoFactor(s, u);
    const archived = query.archived ?? false;
    const deleted = query.deleted ?? false;
    const items = s.spaces
      .filter((sp) => myRole(s, sp.id, u.id) !== null)
      .filter((sp) =>
        deleted
          ? deletedSpaces.has(sp.id) && myRole(s, sp.id, u.id) === 'owner'
          : !deletedSpaces.has(sp.id),
      )
      .filter((sp) => deleted || (archived ? sp.archivedAt !== null : sp.archivedAt === null))
      .map((sp) => toSpace(s, sp, u.id))
      .sort((a, b) =>
        a.kind === b.kind ? a.createdAt.localeCompare(b.createdAt) : a.kind === 'personal' ? -1 : 1,
      );
    return { items };
  },

  createSpace: ({ s, body }) => {
    const u = requireOrg(s, 'org.create_space');
    const slug = body.slug ?? slugify(body.name);
    if (s.spaces.some((x) => x.slug === slug)) throw new MockApiError('space_slug_taken');
    const now = new Date().toISOString();
    const sp: MockSpace = {
      id: newId(),
      kind: 'shared',
      ownerUserId: null,
      name: body.name,
      slug,
      color: body.color,
      icon: body.icon ?? null,
      usedBytes: 0,
      quotaBytes: null,
      archivedAt: null,
      createdAt: now,
    };
    s.spaces.push(sp);
    s.spaceMembers.push({ spaceId: sp.id, userId: u.id, role: 'owner', addedAt: now });
    for (const m of body.members) {
      if (m.userId !== u.id) {
        s.spaceMembers.push({ spaceId: sp.id, userId: m.userId, role: m.role, addedAt: now });
      }
    }
    return toSpace(s, sp, u.id);
  },

  getSpace: ({ s, params }) => {
    const u = requireUser(s);
    enforceTwoFactor(s, u);
    return toSpace(s, findSpace(s, params.spaceId ?? '', u.id, 'space.view'), u.id);
  },

  updateSpace: ({ s, params, body }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.update_settings');
    if (body.name !== undefined) sp.name = body.name;
    if (body.color !== undefined) sp.color = body.color;
    if (body.icon !== undefined) sp.icon = body.icon;
    if (body.quotaBytes !== undefined) sp.quotaBytes = body.quotaBytes;
    return toSpace(s, sp, u.id);
  },

  archiveSpace: ({ s, params }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.archive');
    if (sp.kind === 'personal') throw new MockApiError('forbidden');
    sp.archivedAt = new Date().toISOString();
    return toSpace(s, sp, u.id);
  },

  // Deleting waits 30 days (design 03); the mock only remembers when.
  deleteSpace: ({ s, params }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.delete');
    if (sp.kind === 'personal') throw new MockApiError('forbidden');
    const now = new Date();
    deletedSpaces.set(sp.id, now.toISOString());
    return {
      ...toSpace(s, sp, u.id),
      deletedAt: now.toISOString(),
      purgeAt: new Date(now.getTime() + SPACE_DELETE_RETENTION_DAYS * 86_400_000).toISOString(),
    };
  },

  restoreSpace: ({ s, params }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.delete');
    deletedSpaces.delete(sp.id);
    return { ...toSpace(s, sp, u.id), deletedAt: null, purgeAt: null };
  },

  listSpaceMembers: ({ s, params }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.view');
    return {
      items: s.spaceMembers.filter((x) => x.spaceId === sp.id).map((x) => toSpaceMember(s, x)),
    };
  },

  addSpaceMember: ({ s, params, body }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.manage_members');
    if (!canGrantSpaceRole(myRole(s, sp.id, u.id), body.role)) throw new MockApiError('forbidden');
    userById(s, body.userId);
    if (myRole(s, sp.id, body.userId)) throw new MockApiError('conflict');
    const sm = {
      spaceId: sp.id,
      userId: body.userId,
      role: body.role,
      addedAt: new Date().toISOString(),
    };
    s.spaceMembers.push(sm);
    return toSpaceMember(s, sm);
  },

  updateSpaceMember: ({ s, params, body }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.manage_members');
    const sm = s.spaceMembers.find((x) => x.spaceId === sp.id && x.userId === params.userId);
    if (!sm) throw new MockApiError('member_not_found');
    if (sm.role === 'owner') throw new MockApiError('cannot_change_owner');
    if (!canGrantSpaceRole(myRole(s, sp.id, u.id), body.role)) throw new MockApiError('forbidden');
    sm.role = body.role;
    return toSpaceMember(s, sm);
  },

  removeSpaceMember: ({ s, params }) => {
    const u = requireUser(s);
    const sp = findSpace(s, params.spaceId ?? '', u.id, 'space.manage_members');
    const sm = s.spaceMembers.find((x) => x.spaceId === sp.id && x.userId === params.userId);
    if (!sm) throw new MockApiError('member_not_found');
    if (sm.role === 'owner') throw new MockApiError('cannot_change_owner');
    s.spaceMembers = s.spaceMembers.filter((x) => x !== sm);
    return {};
  },
};

// Core endpoints must all be mocked (checked by the type above). Module endpoints are optional:
// a module adds its resolvers here with one spread; until then its endpoints answer 501.
const resolvers: Partial<Resolvers<EndpointName>> = {
  ...phase0,
  // Version compatibility: store links for "Uygulamada aç".
  getCompat: ({ s }) => ({
    version: '0.0.0-mock',
    build: '4821',
    commit: 'f00dbabe0123456789abcdef0123456789abcdef',
    apiLevel: 1,
    minClientVersion: { ios: '0.0.0', android: '0.0.0', desktop: '0.0.0' },
    storeUrls: s.storeUrls ?? { ios: null, android: null, desktop: null },
    deprecations: [],
  }),
  ...driveResolvers,
  ...quickResolvers,
  ...meetResolvers,
  ...chatResolvers,
  ...mcpResolvers,
  ...portalResolvers,
  ...boardsResolvers,
  ...vaultResolvers,
  ...statsResolvers,
  ...wikiResolvers,
  ...identityResolvers,
  ...backupResolvers,
  ...complianceResolvers,
  ...stepupResolvers,
  ...federationResolvers,
  ...pluginsResolvers,
  ...formsResolvers,
  ...calendarResolvers,
  ...bookingResolvers,
  ...contactsResolvers,
  ...automationsResolvers,
  ...aiResolvers,
  ...deliveryResolvers,
  ...desktopReleaseResolvers,
  ...announcementsResolvers,
  ...mailResolvers,
  ...mailInboxResolvers,
  ...tablesResolvers,
  ...microsoftResolvers,
  ...officeResolvers,
};

export { currentUser, MockApiError };

// ---- wiring ----

export function errorResponse(code: ErrorCode, message?: string, details?: unknown) {
  return HttpResponse.json(
    { code, message: message ?? code, ...(details !== undefined ? { details } : {}) },
    { status: HTTP_STATUS_BY_CODE[code] },
  );
}

function handlerFor(name: EndpointName): HttpHandler {
  const def = endpoints[name] as EndpointDef;
  const method = def.method.toLowerCase() as 'get' | 'post' | 'patch' | 'put' | 'delete';
  return http[method](`*${def.path}`, async ({ request, params }) => {
    if (latency) await delay(latency);
    const s = db();
    try {
      let body: unknown;
      if (def.body) {
        const raw: unknown = await request.json().catch(() => ({}));
        const parsed = def.body.safeParse(raw);
        if (!parsed.success) {
          return errorResponse('validation_failed', 'Invalid body', parsed.error.issues);
        }
        body = parsed.data;
      }
      let query: unknown;
      if (def.query) {
        const parsed = def.query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!parsed.success) {
          return errorResponse('validation_failed', 'Invalid query', parsed.error.issues);
        }
        query = parsed.data;
      }
      assertModuleEnabled(s, name);
      const resolver = resolvers[name] as Resolver<EndpointName> | undefined;
      if (!resolver) return errorResponse('not_implemented', `Mock for ${name} is not written yet`);
      const out = await resolver({
        params: params as Record<string, string>,
        body: body as never,
        query: query as never,
        s,
        request,
      });
      const checked = def.response.safeParse(out);
      if (!checked.success) {
        console.error(`[mock] ${name} response does not match the contract`, checked.error.issues);
        return errorResponse('internal', 'Mock response drifted from the contract');
      }
      save();
      return HttpResponse.json(checked.data as object);
    } catch (e) {
      save();
      if (e instanceof MockApiError) return errorResponse(e.code, e.message, e.details);
      console.error('[mock]', e);
      return errorResponse('internal');
    }
  });
}

export const contractHandlers: HttpHandler[] = (Object.keys(endpoints) as EndpointName[]).map(
  handlerFor,
);
