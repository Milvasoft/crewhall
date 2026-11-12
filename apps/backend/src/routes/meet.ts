import { MEET_RAW_PATHS } from '@crewhall/shared';
import type { Router } from '../http/route';
import type { OrgCtx } from '../http/types';
import type { MeetActor } from '../services/meet/access';
import * as calls from '../services/meet/calls';
import { listGuestChat, sendGuestChat } from '../services/meet/guest-chat';
import * as join from '../services/meet/join';
import * as meetings from '../services/meet/meetings';
import * as recs from '../services/meet/recordings';
import * as rc from '../services/meet/remote-control';
import * as settings from '../services/meet/settings';
import { declineSigned } from '../services/meet/voip';
import { endForAll, handleWebhook } from '../services/meet/webhook';

const meetActor = (ctx: Pick<OrgCtx<never>, 'org' | 'actor' | 'user'>): MeetActor => ({
  org: ctx.org,
  actor: ctx.actor,
  userId: ctx.user.id,
  userName: ctx.user.name,
});

const image = (ctx: Pick<OrgCtx<never>, 'user'>) => {
  const url = ctx.user.image ?? null;
  return url && /^https?:\/\//.test(url) ? url : null;
};

/** Meet module routes; endpoints come from packages/shared/src/endpoints/meet.ts. */
export function registerMeet(r: Router): void {
  // Remote control of shared screens: the sharing client reports grants for the audit log.
  r.org('reportRemoteControl', (ctx) =>
    rc.reportRemoteControl(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body, ctx.req),
  );
  // Calls (H7).
  r.org('startCall', (ctx) => calls.startCall(ctx.deps, meetActor(ctx), ctx.body), { status: 201 });
  r.org('listIncomingCalls', (ctx) => calls.listIncoming(ctx.deps, meetActor(ctx)));
  r.org('getConversationLive', (ctx) =>
    calls.conversationLive(ctx.deps, meetActor(ctx), ctx.params.conversationId),
  );
  r.org('getCall', (ctx) => calls.getCall(ctx.deps, meetActor(ctx), ctx.params.callId));
  r.org('hangUpCall', (ctx) => calls.hangUpCall(ctx.deps, meetActor(ctx), ctx.params.callId));
  r.org('ringToMeeting', (ctx) =>
    calls.ringToMeeting(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body.userIds),
  );
  r.org('answerCall', (ctx) => calls.answerCall(ctx.deps, meetActor(ctx), ctx.params.callId));
  r.org('declineCall', (ctx) =>
    calls.declineCall(ctx.deps, meetActor(ctx), ctx.params.callId, ctx.body.busy),
  );
  // CallKit 'Reddet' with no session: the VoIP push's signed declineUrl.
  r.public('declineCallSigned', async (ctx) => {
    await declineSigned(ctx.deps, ctx.params.callId, ctx.query.token);
    return {};
  });
  r.org('cancelCall', (ctx) => calls.cancelCall(ctx.deps, meetActor(ctx), ctx.params.callId));
  r.org('ringCall', (ctx) =>
    calls.ringCall(ctx.deps, meetActor(ctx), ctx.params.callId, ctx.body.userIds),
  );

  r.org('getMeetHome', (ctx) => meetings.meetHome(ctx.deps, meetActor(ctx), ctx.query.tz));
  r.org('listMeetings', (ctx) => meetings.listMeetings(ctx.deps, meetActor(ctx), ctx.query));
  r.org('listMeetingHistory', (ctx) => meetings.listHistory(ctx.deps, meetActor(ctx), ctx.query));

  r.org('createMeeting', (ctx) => meetings.createMeeting(ctx.deps, meetActor(ctx), ctx.body), {
    status: 201,
  });
  r.org('getMeeting', (ctx) => meetings.getMeeting(ctx.deps, meetActor(ctx), ctx.params.meetingId));
  // Meetings created from the calendar change through their event (calendar/meeting.ts).
  r.org('updateMeeting', async (ctx) => {
    await meetings.assertNotCalendarManaged(ctx.deps.db, ctx.params.meetingId);
    return meetings.updateMeeting(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body);
  });
  r.org('cancelMeeting', async (ctx) => {
    await meetings.assertNotCalendarManaged(ctx.deps.db, ctx.params.meetingId);
    await meetings.cancelMeeting(ctx.deps, meetActor(ctx), ctx.params.meetingId);
    return {};
  });
  r.org('inviteToMeeting', (ctx) =>
    meetings.inviteToMeeting(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body),
  );
  r.org('rotateMeetingLink', (ctx) =>
    meetings.rotateLink(ctx.deps, meetActor(ctx), ctx.params.meetingId),
  );

  r.public('getMeetingLink', (ctx) => meetings.linkPreview(ctx.deps, ctx.params.slug));
  r.org('resolveMeetingLink', (ctx) =>
    meetings.resolveLink(ctx.deps, meetActor(ctx), ctx.params.slug),
  );
  r.org('joinMeeting', (ctx) =>
    join.joinMeeting(ctx.deps, meetActor(ctx), ctx.params.meetingId, image(ctx), ctx.body.device),
  );
  r.org('listActiveMeetings', (ctx) => join.listActiveMeetings(ctx.deps, meetActor(ctx)));
  r.public(
    'requestGuestJoin',
    (ctx) => join.requestGuestJoin(ctx.deps, ctx.params.slug, ctx.body.name, ctx.req),
    { status: 201 },
  );
  r.public('pollGuestRequest', (ctx) =>
    join.pollGuestRequest(ctx.deps, ctx.params.requestId, ctx.body.secret),
  );
  r.public('cancelGuestRequest', async (ctx) => {
    await join.cancelGuestRequest(ctx.deps, ctx.params.requestId, ctx.body.secret);
    return {};
  });
  r.public('listGuestChat', (ctx) =>
    listGuestChat(ctx.deps, ctx.params.requestId, ctx.body.secret),
  );
  r.public('sendGuestChat', (ctx) => sendGuestChat(ctx.deps, ctx.params.requestId, ctx.body));
  r.org('getLobbyRequest', (ctx) =>
    join.getLobbyRequest(ctx.deps, meetActor(ctx), ctx.params.requestId, image(ctx)),
  );

  r.org('listMeetingParticipants', (ctx) =>
    join.liveParticipants(ctx.deps, meetActor(ctx), ctx.params.meetingId),
  );
  r.org('listMeetingLobby', async (ctx) => ({
    items: await join.listLobby(ctx.deps, meetActor(ctx), ctx.params.meetingId),
  }));
  r.org('decideMeetingLobby', async (ctx) => ({
    items: await join.decideLobby(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body),
  }));
  r.org('moderateMeetingParticipant', async (ctx) => {
    await join.moderate(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body, ctx.req);
    return {};
  });
  r.org('muteAllInMeeting', async (ctx) => {
    await join.muteAll(ctx.deps, meetActor(ctx), ctx.params.meetingId, ctx.body.exceptModerators);
    return {};
  });
  r.org('endMeetingForAll', async (ctx) => {
    await endForAll(ctx.deps, meetActor(ctx), ctx.params.meetingId);
    return {};
  });

  r.org('getRecordingTarget', (ctx) =>
    recs.recordingTarget(ctx.deps, meetActor(ctx), ctx.params.meetingId),
  );
  r.org(
    'startMeetingRecording',
    (ctx) =>
      recs.startRecording(
        ctx.deps,
        meetActor(ctx),
        ctx.params.meetingId,
        ctx.body.audioOnly,
        ctx.req,
      ),
    { status: 201 },
  );
  r.org('stopMeetingRecording', (ctx) =>
    recs.stopRecording(ctx.deps, meetActor(ctx), ctx.params.recordingId, ctx.req),
  );
  r.org('listMeetingRecordings', async (ctx) => ({
    items: await recs.listRecordings(ctx.deps, meetActor(ctx), ctx.params.meetingId),
  }));

  r.org('getMeetingSession', (ctx) =>
    meetings.sessionDetail(ctx.deps, meetActor(ctx), ctx.params.sessionId),
  );
  r.org('getMeetSpaceSettings', (ctx) =>
    settings.getSpaceSettings(ctx.deps.db, meetActor(ctx), ctx.params.spaceId),
  );
  r.org('updateMeetSpaceSettings', (ctx) =>
    settings.updateSpaceSettings(ctx.deps.db, meetActor(ctx), ctx.params.spaceId, ctx.body),
  );

  // LiveKit server and egress webhooks: raw body, signed (Authorization JWT with sha256).
  r.rawPublic('POST', MEET_RAW_PATHS.livekitWebhook, async ({ c, deps }) => {
    const body = await c.req.text();
    await handleWebhook(deps, body, c.req.header('authorization'));
    return c.json({});
  });
}
