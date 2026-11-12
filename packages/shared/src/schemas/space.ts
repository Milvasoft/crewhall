import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';

export const SpaceKind = z.enum(['personal', 'shared']);
export type SpaceKind = z.infer<typeof SpaceKind>;

export const SpaceRole = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type SpaceRole = z.infer<typeof SpaceRole>;

/** Palette slots s1..s6 from the design system; the actual colors are theme tokens. */
export const SpaceColor = z.enum(['s1', 's2', 's3', 's4', 's5', 's6']);
export type SpaceColor = z.infer<typeof SpaceColor>;

/** Design 3.2: invite only, or listed for everyone in the org to join (content stays members-only). */
export const SpaceVisibility = z.enum(['invite_only', 'org']);
export type SpaceVisibility = z.infer<typeof SpaceVisibility>;

/** Deleted spaces wait this long and can be restored meanwhile (design 03). */
export const SPACE_DELETE_RETENTION_DAYS = 30;

export const Space = z.object({
  id: Id,
  kind: SpaceKind,
  name: z.string(),
  slug: z.string(),
  color: SpaceColor,
  icon: z.string().nullable(),
  /** Caller's role in this space. */
  myRole: SpaceRole,
  memberCount: z.number().int(),
  usedBytes: z.number().int(),
  quotaBytes: z.number().int().nullable(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  /** New members join default spaces automatically. */
  isDefault: z.boolean().optional(),
  description: z.string().nullable().optional(),
  visibility: SpaceVisibility.optional(),
  /** Set while the space waits for permanent deletion (owner only sees it, with deleted=true). */
  deletedAt: Timestamp.nullable().optional(),
  /** When a deleted space is removed for good. */
  purgeAt: Timestamp.nullable().optional(),
});
export type Space = z.infer<typeof Space>;

/**
 * Org-admin view of a shared space (9.9): metadata and membership only, no content.
 * myRole is null when the admin is not a member.
 */
export const OrgSpace = Space.omit({ myRole: true }).extend({
  myRole: SpaceRole.nullable(),
  owner: UserSummary.nullable(),
});
export type OrgSpace = z.infer<typeof OrgSpace>;

export const CreateSpace = z.object({
  name: z.string().min(1).max(60),
  slug: z
    .string()
    .regex(/^[a-z0-9-]{2,40}$/)
    .optional(),
  color: SpaceColor,
  icon: z.string().max(32).nullable().optional(),
  description: z.string().max(280).optional(),
  /** Default invite_only. */
  visibility: SpaceVisibility.optional(),
  /** Initial members besides the creator (who becomes owner). */
  members: z.array(z.object({ userId: Id, role: SpaceRole.exclude(['owner']) })).default([]),
});
export type CreateSpace = z.infer<typeof CreateSpace>;

export const UpdateSpace = z.object({
  name: z.string().min(1).max(60).optional(),
  color: SpaceColor.optional(),
  icon: z.string().max(32).nullable().optional(),
  quotaBytes: z.number().int().positive().nullable().optional(),
  description: z.string().max(280).nullable().optional(),
  visibility: SpaceVisibility.optional(),
});
export type UpdateSpace = z.infer<typeof UpdateSpace>;

export const SpaceMember = z.object({
  user: UserSummary,
  role: SpaceRole,
  addedAt: Timestamp,
});
export type SpaceMember = z.infer<typeof SpaceMember>;

export const AddSpaceMember = z.object({
  userId: Id,
  role: SpaceRole.exclude(['owner']),
});
export type AddSpaceMember = z.infer<typeof AddSpaceMember>;

export const UpdateSpaceMember = z.object({
  role: SpaceRole.exclude(['owner']),
});
export type UpdateSpaceMember = z.infer<typeof UpdateSpaceMember>;
