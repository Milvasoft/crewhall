import { and, eq, isNull } from 'drizzle-orm';
import { meetingParticipants, meetingSessions, type DbOrTx } from '@crewhall/db';
import type { Deps } from '../../deps';
import { statusChoice } from '../chat/status';

/** The person is in a live meeting or call of the org (presence "Toplantıda"). */
export async function inLiveMeeting(db: DbOrTx, orgId: string, userId: string) {
  const rows = await db
    .select({ id: meetingParticipants.id })
    .from(meetingParticipants)
    .innerJoin(meetingSessions, eq(meetingSessions.id, meetingParticipants.sessionId))
    .where(
      and(
        eq(meetingParticipants.orgId, orgId),
        eq(meetingParticipants.userId, userId),
        isNull(meetingParticipants.leftAt),
        isNull(meetingSessions.endedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Screen share started or stopped: presence shows "Sunuyor" while a share track is up. */
export function screenSharePresence(
  deps: Pick<Deps, 'presence'>,
  userId: string,
  trackSid: string | null,
  on: boolean,
) {
  deps.presence.setScreenShare(userId, trackSid, on);
}

/** After a join or leave: presence shows busy · in a meeting while any live room has them. */
export async function refreshMeetingPresence(
  deps: Pick<Deps, 'db' | 'presence'>,
  orgId: string,
  userId: string,
) {
  const [inMeeting, choice] = await Promise.all([
    inLiveMeeting(deps.db, orgId, userId),
    statusChoice(deps.db, orgId, userId),
  ]);
  deps.presence.setMeeting(userId, inMeeting, choice);
}
