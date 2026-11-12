import { eq } from 'drizzle-orm';
import { organizations, type DbOrTx } from '@crewhall/db';
import type { OrgSettings, ReportRemoteControl } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { loadMeeting, type MeetActor, type MeetingRow } from './access';

/**
 * Remote control of a shared screen ("Denetimi iste / ver"). The control messages run between
 * the clients over the LiveKit data channel (MEET_CONTROL_TOPIC); the api only says whether it
 * is allowed (org setting meetRemoteControl, meeting setting remoteControl) and keeps the
 * audit trail the sharing client reports.
 */

export const orgAllowsRemoteControl = (settings: OrgSettings | null | undefined) =>
  settings?.meetRemoteControl !== false;

export const meetingAllowsRemoteControl = (m: Pick<MeetingRow, 'settings'>) =>
  m.settings.remoteControl !== false;

export async function remoteControlOn(db: DbOrTx, m: MeetingRow): Promise<boolean> {
  if (!meetingAllowsRemoteControl(m)) return false;
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, m.orgId));
  return orgAllowsRemoteControl(org?.settings as OrgSettings | undefined);
}

export async function reportRemoteControl(
  deps: Deps,
  a: MeetActor,
  meetingId: string,
  input: ReportRemoteControl,
  req: RequestInfo,
) {
  const { db } = deps;
  const { meeting, access } = await loadMeeting(db, a, meetingId);
  if (!access.direct) throw new AppError('not_found');
  if (!(await remoteControlOn(db, meeting))) throw new AppError('meet_remote_control_off');
  await audit(
    db,
    {
      orgId: meeting.orgId,
      actorId: a.userId,
      action: `meet.remote_control.${input.event}`,
      targetType: 'meeting',
      targetId: meeting.id,
      meta: { controllerId: input.userId },
    },
    req,
  );
  return {};
}
