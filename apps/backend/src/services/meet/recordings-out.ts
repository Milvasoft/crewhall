import { eq } from 'drizzle-orm';
import { nodes, type DbOrTx } from '@crewhall/db';
import type { MeetingRecording, UserSummary } from '@crewhall/shared';
import { spaceMeetSettings, usersByIds, type RecordingRow } from './access';

export async function recordingOut(
  db: DbOrTx,
  r: RecordingRow,
  people?: Map<string, UserSummary>,
): Promise<MeetingRecording> {
  const who = people ?? (await usersByIds(db, [r.startedBy]));
  const node = r.nodeId
    ? (await db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, r.nodeId)))[0]
    : undefined;
  const retention = r.spaceId
    ? (await spaceMeetSettings(db, [r.spaceId])).get(r.spaceId)?.recordingRetentionDays
    : null;
  const ended = r.endedAt ?? (r.status === 'ready' ? r.updatedAt : null);
  return {
    id: r.id,
    meetingId: r.meetingId,
    sessionId: r.sessionId,
    status: r.status,
    audioOnly: r.audioOnly,
    startedBy: r.startedBy ? (who.get(r.startedBy) ?? null) : null,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    durationSeconds: r.durationS,
    sizeBytes: r.sizeBytes,
    nodeId: r.nodeId,
    spaceId: r.spaceId,
    fileName: node?.name ?? null,
    expiresAt:
      retention && ended && r.status === 'ready'
        ? new Date(r.startedAt.getTime() + retention * 86_400_000).toISOString()
        : null,
    error: r.error,
  };
}
