import { z } from 'zod';
import { Id, Locale, Timestamp } from './common';
import { Branding } from './branding';
import { IntegrationKey } from './microsoft';

export const OrgRole = z.enum(['owner', 'admin', 'member', 'guest']);
export type OrgRole = z.infer<typeof OrgRole>;

export const MemberStatus = z.enum(['active', 'invited', 'suspended']);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** Extra capabilities granted on top of the org role (org_members.permissions). */
export const OrgPermission = z.enum(['portal.edit', 'portal.publish', 'announcements.publish']);
export type OrgPermission = z.infer<typeof OrgPermission>;

/**
 * Modules an organization can turn off (Yönetim › Genel). Drive and quick access are the core and
 * always on. A missing key means enabled. When a module is off, its endpoints answer 403
 * `module_disabled` (enforced centrally from MODULE_OF_ENDPOINT) and clients hide it.
 */
export const MODULE_KEYS = [
  'chat',
  'meet',
  'wiki',
  'boards',
  'drawings',
  'vault',
  'portal',
  'mcp',
  'calendar',
  'contacts',
  'ai',
  'forms',
  'automations',
  'mail',
  /** Developer tools (Too Much Tools); runs in the browser, no endpoints of its own. */
  'tools',
  'tables',
  'office',
] as const;
export const ModuleKey = z.enum(MODULE_KEYS);
export type ModuleKey = z.infer<typeof ModuleKey>;

/**
 * A module split out of another starts as that one was: while its own switch is unset it
 * follows the parent (drawings left boards on 2026-10-29; an org with boards off keeps
 * drawings off until an admin turns them on).
 */
export const MODULE_PARENT: Readonly<Partial<Record<ModuleKey, ModuleKey>>> = {
  drawings: 'boards',
};

/** Effective switch of a module in the org settings: own value, else the parent's, else on. */
export function moduleOn(
  settings: { modules?: Partial<Record<ModuleKey, boolean>> } | null | undefined,
  key: ModuleKey,
): boolean {
  const own = settings?.modules?.[key];
  if (own !== undefined) return own;
  const parent = MODULE_PARENT[key];
  return parent ? moduleOn(settings, parent) : true;
}

export const OrgSettings = z.object({
  requireTwoFactor: z.boolean(),
  defaultLocale: Locale,
  membersCanCreateSpaces: z.boolean(),
  publicLinksEnabled: z.boolean(),
  /** Single file limit in bytes (doc 17 §8); default 5 GB. */
  maxFileBytes: z.number().int().positive().optional(),
  /** Org storage quota in bytes; absent or null = unlimited. */
  storageQuotaBytes: z.number().int().positive().nullable().optional(),
  /** Module switches; absent key = enabled. */
  modules: z.partialRecord(ModuleKey, z.boolean()).optional(),
  /** "Herkes için sil" in chat (H19); absent = allowed (group owners and org admins). */
  chatDeleteForEveryone: z.boolean().optional(),
  /** Preview cards of links in chat messages; absent = on. */
  chatLinkPreviews: z.boolean().optional(),
  /** Federation (roadmap 26): off by default; edited on Yönetim › Güvenlik › Federasyon. */
  federationEnabled: z.boolean().optional(),
  /** Domains allowed to federate (`*.example.com` covers subdomains). */
  federationAllowedDomains: z.array(z.string().max(255)).max(200).optional(),
  /** Remote control of shared screens in meetings ("Denetimi ver"); absent = allowed. */
  meetRemoteControl: z.boolean().optional(),
  /** Days a trashed item stays restorable before the nightly purge; absent = 30 (TRASH_RETENTION_DAYS). */
  trashRetentionDays: z.number().int().min(1).max(3650).optional(),
  /** Microsoft integrations (schemas/microsoft.ts INTEGRATION_KEYS); absent key = off. */
  integrations: z.partialRecord(IntegrationKey, z.boolean()).optional(),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

export const Organization = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  branding: Branding,
  settings: OrgSettings,
  createdAt: Timestamp,
});
export type Organization = z.infer<typeof Organization>;

export const UpdateOrganization = z.object({
  name: z.string().min(1).max(80).optional(),
  settings: OrgSettings.partial().optional(),
});
export type UpdateOrganization = z.infer<typeof UpdateOrganization>;

export const UserSummary = z.object({
  id: Id,
  name: z.string(),
  email: z.email(),
  imageUrl: z.url().nullable(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const OrgMember = z.object({
  user: UserSummary,
  role: OrgRole,
  permissions: z.array(OrgPermission),
  status: MemberStatus,
  twoFactorEnabled: z.boolean(),
  joinedAt: Timestamp.nullable(),
  lastSeenAt: Timestamp.nullable(),
  /** Set while the account is locked after failed sign-ins (1.16); admins can unlock. */
  lockedUntil: Timestamp.nullable().optional(),
  /** Guests: when their access ends (null = no limit). */
  expiresAt: Timestamp.nullable().optional(),
});
export type OrgMember = z.infer<typeof OrgMember>;

export const MemberListQuery = z.object({
  q: z.string().optional(),
  role: OrgRole.optional(),
  status: MemberStatus.optional(),
});

export const UpdateOrgMember = z.object({
  role: OrgRole.exclude(['owner']).optional(),
  status: MemberStatus.exclude(['invited']).optional(),
  permissions: z.array(OrgPermission).optional(),
  /**
   * Guests only: access end (null = no limit). A future date also brings back a guest the
   * hourly job suspended when the previous date passed.
   */
  expiresAt: Timestamp.nullable().optional(),
});
export type UpdateOrgMember = z.infer<typeof UpdateOrgMember>;

export const Invitation = z.object({
  id: Id,
  email: z.email(),
  role: OrgRole.exclude(['owner']),
  invitedBy: UserSummary,
  expiresAt: Timestamp,
  createdAt: Timestamp,
  /** Accept link; only in the createInvitation response (the token is stored hashed). */
  url: z.url().optional(),
  /** Guests: access end of the membership the invitation creates. */
  memberExpiresAt: Timestamp.nullable().optional(),
});
export type Invitation = z.infer<typeof Invitation>;

export const CreateInvitation = z.object({
  email: z.email(),
  role: OrgRole.exclude(['owner']),
  /** Shared spaces to add the person to once they accept; guests need at least one. */
  spaceIds: z.array(Id).default([]),
  /** Guests: access ends at this time (in the future). */
  memberExpiresAt: Timestamp.optional(),
  /** Guests: role in the listed spaces; default viewer. */
  spaceRole: z.enum(['viewer', 'editor']).optional(),
});
export type CreateInvitation = z.infer<typeof CreateInvitation>;

/** Public preview shown on the accept-invite screen (no session yet). */
export const InvitationPreview = z.object({
  orgName: z.string(),
  invitedByName: z.string(),
  email: z.email(),
  role: OrgRole,
  expiresAt: Timestamp,
  /** Spaces the person joins on accept, with the role they get there. */
  spaces: z
    .array(z.object({ id: Id, name: z.string(), role: z.enum(['admin', 'editor', 'viewer']) }))
    .optional(),
  /** An account already exists for the invited address: show sign-in instead of sign-up. */
  hasAccount: z.boolean().optional(),
});
export type InvitationPreview = z.infer<typeof InvitationPreview>;
