import { z } from 'zod';
import { Id, Locale, Timestamp } from './common';
import { OrgPermission, OrgRole, ModuleKey } from './org';

export const Me = z.object({
  user: z.object({
    id: Id,
    name: z.string(),
    email: z.email(),
    imageUrl: z.url().nullable(),
    locale: Locale,
    twoFactorEnabled: z.boolean(),
    hasPasskey: z.boolean(),
  }),
  activeOrgId: Id.nullable(),
  memberships: z.array(
    z.object({
      orgId: Id,
      orgName: z.string(),
      orgSlug: z.string(),
      role: OrgRole,
      permissions: z.array(OrgPermission),
    }),
  ),
  /** Personal space of the active org (created when the user joins). */
  personalSpaceId: Id.nullable(),
  /**
   * The active org's policy requires 2FA (always for owners and admins) and the user
   * has neither TOTP nor a passkey yet: org endpoints answer two_factor_required (1.14).
   */
  twoFactorRequired: z.boolean().optional(),
  /** Modules enabled in the active org; clients show only these (absent = all on, older servers). */
  modules: z.array(ModuleKey).optional(),
  /** Days trashed items stay restorable in the active org (OrgSettings.trashRetentionDays). */
  trashRetentionDays: z.number().int().positive().optional(),
  /** Owner of the org the setup wizard created: manages install-wide things (backups). */
  installAdmin: z.boolean().optional(),
  /** Guests: when their access to the active org ends (null = no limit). */
  accessExpiresAt: Timestamp.nullable().optional(),
});
export type Me = z.infer<typeof Me>;

/** Photo stored and resized (512 px square); `imageUrl` is also in Me.user from now on. */
export const AvatarResult = z.object({ imageUrl: z.url() });
export type AvatarResult = z.infer<typeof AvatarResult>;

export const UpdateMe = z.object({
  name: z.string().min(1).max(80).optional(),
  locale: Locale.optional(),
});
export type UpdateMe = z.infer<typeof UpdateMe>;

/**
 * Personal interface choices that follow the person across devices (web, desktop app), per org.
 * navOrder: the left menu's module ids in the person's order; missing ones keep their default
 * place after them. Empty means the default order.
 */
const ModuleId = z.string().min(1).max(40);

/** A rail entry: module id, or `plugin:<pluginId>:<tabId>` for a plugin tab or pin. */
const RailEntryId = z.string().min(1).max(160);

/** `g c`: G then a key; `alt+shift+c`; '' for no shortcut (see the web's lib/shell/shortcuts). */
export const RAIL_SHORTCUT_RE = /^(?:g [a-z0-9]|alt\+shift\+[a-z0-9])$/;

export const UiPrefs = z.object({
  navOrder: z.array(ModuleId).max(40),
  /**
   * Web and desktop left menu, apart from the phone's bar, which navOrder keeps: entries in the
   * person's order (absent: navOrder, the earlier shared one), the ones they hid, and the keyboard
   * shortcut per entry ('' takes a default away).
   */
  railOrder: z.array(RailEntryId).max(120).optional(),
  railHidden: z.array(RailEntryId).max(120).optional(),
  railShortcuts: z
    .record(RailEntryId, z.union([z.literal(''), z.string().regex(RAIL_SHORTCUT_RE)]))
    .refine((r) => Object.keys(r).length <= 120, { message: 'at most 120 entries' })
    .optional(),
  /** Module sidebar width per module id (px; the web clamps it to 200–480). */
  sidebarWidths: z
    .record(ModuleId, z.number().int().min(120).max(800))
    .refine((r) => Object.keys(r).length <= 40, { message: 'at most 40 modules' })
    .optional(),
  /** Module ids whose sidebar is collapsed (dragged below its minimum). */
  sidebarCollapsed: z.array(ModuleId).max(40).optional(),
  /**
   * Pages › "Tam genişlik": every page opens full width for this person (capability
   * `ui.pagesFullWidth`). Replaces the per-page `Page.fullWidth`.
   */
  pagesFullWidth: z.boolean().optional(),
  /**
   * Pages where this person hides completed to-dos (capability `ui.pagesHideDone`). The view
   * changes, not the document; the newest first, the oldest fall off.
   */
  pagesHideDone: z.array(z.string().min(1).max(40)).max(500).optional(),
});
export type UiPrefs = z.infer<typeof UiPrefs>;

export const UpdateUiPrefs = UiPrefs.partial();
export type UpdateUiPrefs = z.infer<typeof UpdateUiPrefs>;

export const SessionInfo = z.object({
  id: Id,
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: Timestamp,
  lastActiveAt: Timestamp,
});
export type SessionInfo = z.infer<typeof SessionInfo>;
