import {
  can,
  type Action,
  type Actor,
  type Me,
  type OrgSettings,
  type Resource,
} from '@crewhall/shared';
import { useQuery } from '@tanstack/react-query';
import { meQuery, orgQuery } from '@/lib/queries';

/** The signed-in person as seen by `can()`. Guests until the membership loads. */
export function actorFrom(me: Me | undefined): Actor {
  const m = me?.memberships.find((x) => x.orgId === me.activeOrgId);
  return {
    userId: me?.user.id ?? '',
    orgRole: m?.role ?? 'guest',
    orgPermissions: m?.permissions ?? [],
  };
}

const FALLBACK_SETTINGS: Pick<OrgSettings, 'membersCanCreateSpaces' | 'publicLinksEnabled'> = {
  membersCanCreateSpaces: false,
  publicLinksEnabled: true,
};

/** `can()` bound to the current person and org; the UI hides what this returns false for. */
export function usePermissions() {
  const { data: me } = useQuery(meQuery);
  const { data: org } = useQuery({ ...orgQuery, enabled: Boolean(me) });
  const actor = actorFrom(me);
  const orgCtx = { settings: org?.settings ?? FALLBACK_SETTINGS };
  return {
    me,
    actor,
    orgCtx,
    role: actor.orgRole,
    canOrg: (action: Action) => can(actor, action, { type: 'org', org: orgCtx }),
    canSpace: (action: Action, myRole: Extract<Resource, { type: 'space' }>['myRole']) =>
      can(actor, action, { type: 'space', org: orgCtx, myRole }),
  };
}

export function useMe(): Me | undefined {
  return useQuery(meQuery).data;
}
