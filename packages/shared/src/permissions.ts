import type { OrgPermission, OrgRole } from './schemas/org';
import type { SpaceRole } from './schemas/space';

/**
 * The single permission function (design doc 17 §5). api, collab and the UIs
 * all call this; the UI hides what it returns false for, the server re-checks.
 * Phase 0 covers org and space actions; node-level shares come with Drive.
 */

export type OrgAction =
  | 'org.transfer_ownership'
  | 'org.delete'
  | 'org.update_branding'
  | 'org.update_settings'
  | 'org.invite'
  | 'org.manage_members'
  | 'org.view_audit'
  /** Yönetim › İstatistikler (roadmap 21). */
  | 'org.view_stats'
  | 'org.manage_spaces'
  | 'org.create_space'
  | 'org.view_directory'
  | 'portal.edit'
  | 'portal.publish'
  | 'announcements.publish'
  | 'forms.respond'
  /**
   * Yönetim › Masaüstü sürümleri, install-wide like backups: the owner of the org the setup
   * wizard created (Me.installAdmin). The server also checks that it is that org.
   */
  | 'desktop.manage_releases';

export type SpaceAction =
  | 'space.view'
  | 'space.comment'
  | 'space.edit_content'
  | 'space.trash'
  | 'space.purge'
  | 'space.share_user'
  | 'space.share_link'
  | 'space.edit_surface'
  | 'space.chat_write'
  | 'space.chat_create'
  | 'space.manage_members'
  | 'space.update_settings'
  | 'space.archive'
  | 'space.delete'
  | 'space.transfer'
  | 'forms.manage'
  | 'forms.view_results'
  | 'automations.view'
  | 'automations.manage'
  /** Shared inbox (sonraki-isler.md "Ortak gelen kutusu"): read, work it, set it up. */
  | 'mail.inbox.view'
  | 'mail.inbox.work'
  | 'mail.inbox.manage'
  | 'tables.edit';

export type Action = OrgAction | SpaceAction;

export interface Actor {
  userId: string;
  orgRole: OrgRole;
  orgPermissions: readonly OrgPermission[];
}

export interface OrgContext {
  settings: { membersCanCreateSpaces: boolean; publicLinksEnabled: boolean };
}

export type Resource =
  | { type: 'org'; org: OrgContext }
  | {
      type: 'space';
      org: OrgContext;
      /** Actor's role in the space, null when not a member. */
      myRole: SpaceRole | null;
      /** Space setting: editors may create public links. */
      editorsCanShareLinks?: boolean;
    };

const ORG_RANK: Record<OrgRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };
const SPACE_RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const orgAtLeast = (actor: Actor, role: OrgRole) => ORG_RANK[actor.orgRole] >= ORG_RANK[role];
const spaceAtLeast = (role: SpaceRole | null, min: SpaceRole) =>
  role !== null && SPACE_RANK[role] >= SPACE_RANK[min];

const SPACE_MIN_ROLE: Record<Exclude<SpaceAction, 'space.share_link'>, SpaceRole> = {
  'space.view': 'viewer',
  'space.comment': 'viewer',
  'space.chat_write': 'viewer',
  'space.edit_content': 'editor',
  'space.trash': 'editor',
  'space.share_user': 'editor',
  'space.edit_surface': 'editor',
  'space.chat_create': 'editor',
  'space.purge': 'admin',
  'space.manage_members': 'admin',
  'space.update_settings': 'admin',
  'space.archive': 'owner',
  'space.delete': 'owner',
  'space.transfer': 'owner',
  'forms.manage': 'editor',
  'forms.view_results': 'editor',
  'automations.view': 'editor',
  'automations.manage': 'admin',
  'mail.inbox.view': 'viewer',
  'mail.inbox.work': 'editor',
  'mail.inbox.manage': 'admin',
  'tables.edit': 'editor',
};

export function can(actor: Actor, action: Action, resource: Resource): boolean {
  if (resource.type === 'org') return canOrg(actor, action as OrgAction, resource.org);
  return canSpace(actor, action as SpaceAction, resource);
}

function canOrg(actor: Actor, action: OrgAction, org: OrgContext): boolean {
  switch (action) {
    case 'org.transfer_ownership':
    case 'org.delete':
    case 'desktop.manage_releases':
      return actor.orgRole === 'owner';
    case 'org.update_branding':
    case 'org.update_settings':
    case 'org.invite':
    case 'org.manage_members':
    case 'org.view_audit':
    case 'org.view_stats':
    case 'org.manage_spaces':
      return orgAtLeast(actor, 'admin');
    case 'org.create_space':
      return (
        orgAtLeast(actor, 'admin') ||
        (actor.orgRole === 'member' && org.settings.membersCanCreateSpaces)
      );
    case 'org.view_directory':
      // Guests see only the people in shared conversations; the server narrows the list.
      return true;
    case 'portal.edit':
    case 'portal.publish':
    case 'announcements.publish':
      // Guests never edit the org's public site or publish announcements, whatever permissions
      // they were given.
      if (actor.orgRole === 'guest') return false;
      return orgAtLeast(actor, 'admin') || actor.orgPermissions.includes(action);
    case 'forms.respond':
      // Org-wide forms: every member answers; guests only see the spaces they were invited to.
      return orgAtLeast(actor, 'member');
  }
}

/**
 * Guests (roadmap 13) work with the content of the spaces they were added to, but never
 * reach past them: no sharing with people or by link, no member or space management.
 */
const GUEST_DENIED: ReadonlySet<SpaceAction> = new Set<SpaceAction>([
  'space.share_user',
  'space.share_link',
  'space.manage_members',
  'space.update_settings',
  'space.archive',
  'space.delete',
  'space.transfer',
  // The inbox's address and password are the org's.
  'mail.inbox.manage',
]);

function canSpace(
  actor: Actor,
  action: SpaceAction,
  resource: Extract<Resource, { type: 'space' }>,
): boolean {
  const { myRole } = resource;
  if (actor.orgRole === 'guest' && GUEST_DENIED.has(action)) return false;
  // Org admins do not see content implicitly: they must add themselves (audited).
  if (action === 'space.share_link') {
    if (!resource.org.settings.publicLinksEnabled) return false;
    return (
      spaceAtLeast(myRole, 'admin') ||
      (myRole === 'editor' && resource.editorsCanShareLinks === true)
    );
  }
  return spaceAtLeast(myRole, SPACE_MIN_ROLE[action]);
}

/** A member may grant at most their own role. */
export function canGrantSpaceRole(granter: SpaceRole | null, target: SpaceRole): boolean {
  return granter !== null && target !== 'owner' && SPACE_RANK[granter] >= SPACE_RANK[target];
}

/**
 * Effective role on a node (doc 17 §5): the higher of the space role and the strongest
 * share reaching the node (its own or an ancestor's). Shares only widen access.
 */
export function effectiveNodeRole(
  spaceRole: SpaceRole | null,
  shareRoles: readonly ('viewer' | 'editor')[],
): SpaceRole | null {
  let best = spaceRole;
  for (const r of shareRoles) {
    if (best === null || SPACE_RANK[r] > SPACE_RANK[best]) best = r;
  }
  return best;
}
