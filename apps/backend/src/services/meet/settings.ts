import { and, eq } from 'drizzle-orm';
import { meetSpaceSettings, spaceMembers, spaces, type DbOrTx } from '@crewhall/db';
import { can, type MeetSpaceSettings, type SpaceRole } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import { orgContext } from '../membership';
import { spaceMeetSettings, type MeetActor } from './access';

async function spaceAndRole(db: DbOrTx, a: MeetActor, spaceId: string) {
  const [row] = await db
    .select({ space: spaces, role: spaceMembers.role })
    .from(spaces)
    .leftJoin(
      spaceMembers,
      and(eq(spaceMembers.spaceId, spaces.id), eq(spaceMembers.userId, a.userId)),
    )
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, a.org.id)));
  if (!row || row.role === null) throw new AppError('not_found');
  return { space: row.space, role: row.role as SpaceRole };
}

export async function getSpaceSettings(
  db: DbOrTx,
  a: MeetActor,
  spaceId: string,
): Promise<MeetSpaceSettings> {
  await spaceAndRole(db, a, spaceId);
  return { spaceId, ...(await spaceMeetSettings(db, [spaceId])).get(spaceId)! };
}

export async function updateSpaceSettings(
  db: DbOrTx,
  a: MeetActor,
  spaceId: string,
  input: Partial<Omit<MeetSpaceSettings, 'spaceId'>>,
): Promise<MeetSpaceSettings> {
  const { role } = await spaceAndRole(db, a, spaceId);
  if (
    !can(a.actor, 'space.update_settings', { type: 'space', org: orgContext(a.org), myRole: role })
  ) {
    throw new AppError('forbidden');
  }
  const current = (await spaceMeetSettings(db, [spaceId])).get(spaceId)!;
  const next = { ...current, ...input };
  await db
    .insert(meetSpaceSettings)
    .values({ spaceId, orgId: a.org.id, ...next })
    .onConflictDoUpdate({ target: meetSpaceSettings.spaceId, set: next });
  return { spaceId, ...next };
}
