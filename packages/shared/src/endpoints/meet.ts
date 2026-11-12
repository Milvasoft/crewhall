import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import { page } from '../schemas/common';
import {
  Call,
  ConversationLive,
  CreateMeeting,
  DeclineCall,
  DecideLobby,
  GuestJoinRequest,
  GuestJoinTicket,
  ActiveMeetings,
  GuestChatMessage,
  GuestChatPage,
  GuestPoll,
  SendGuestChat,
  GuestPollResult,
  InviteToMeeting,
  JoinMeeting,
  ListMeetingHistoryQuery,
  ListMeetingsQuery,
  LobbyRequest,
  Meeting,
  MeetHome,
  MeetHomeQuery,
  MeetingJoinResult,
  MeetingLinkPreview,
  MeetingParticipantsLive,
  MeetingRecording,
  MeetingSessionDetail,
  MeetingSessionSummary,
  MeetSpaceSettings,
  ModerateParticipant,
  MuteAll,
  RecordingTarget,
  ReportRemoteControl,
  RingCall,
  StartCall,
  StartRecording,
  UpdateMeeting,
  UpdateMeetSpaceSettings,
  DeclineCallSigned,
} from '../schemas/meet';

/**
 * Meet module contract (design 07, 19.21-19.22; doc 17 §2, §4, §11).
 * Only the meet session edits this file; see docs/contracts/moduller.md.
 *
 * Media goes to LiveKit with the token from joinMeeting / pollGuestRequest. LiveKit tells
 * the api who joined and left through MEET_RAW_PATHS.livekitWebhook.
 */
export const meetEndpoints = {
  // ---- Lists ---------------------------------------------------------------------------
  /** 7.1 / 19.21: open rooms, today's planned meetings, persistent rooms. */
  getMeetHome: def({
    method: 'GET',
    path: '/api/v1/meet/home',
    auth: 'session',
    query: MeetHomeQuery,
    response: MeetHome,
  }),
  /** "Planlananlar" and "Kalıcı odalar" in full. */
  listMeetings: def({
    method: 'GET',
    path: '/api/v1/meet/meetings',
    auth: 'session',
    query: ListMeetingsQuery,
    response: page(Meeting),
  }),
  /** "Geçmiş toplantılar" and "Kayıtlar", newest first. */
  listMeetingHistory: def({
    method: 'GET',
    path: '/api/v1/meet/history',
    auth: 'session',
    query: ListMeetingHistoryQuery,
    response: page(MeetingSessionSummary),
  }),

  // ---- Meetings ------------------------------------------------------------------------
  /** 7.2: instant (reuses a conversation's room), scheduled (invitations + .ics) or room. */
  createMeeting: def({
    method: 'POST',
    path: '/api/v1/meet/meetings',
    auth: 'session',
    body: CreateMeeting,
    response: Meeting,
  }),
  getMeeting: def({
    method: 'GET',
    path: '/api/v1/meet/meetings/:meetingId',
    auth: 'session',
    response: Meeting,
  }),
  /** Moderators. A time change sends an updated .ics to everybody invited. */
  updateMeeting: def({
    method: 'PATCH',
    path: '/api/v1/meet/meetings/:meetingId',
    auth: 'session',
    body: UpdateMeeting,
    response: Meeting,
  }),
  /** Cancels a scheduled meeting (cancel .ics) or deletes a room; history stays. */
  cancelMeeting: def({
    method: 'DELETE',
    path: '/api/v1/meet/meetings/:meetingId',
    auth: 'session',
    response: Empty,
  }),
  /** 7.12: Hub members are added as invitees, e-mails get the guest link and an .ics. */
  inviteToMeeting: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/invitations',
    auth: 'session',
    body: InviteToMeeting,
    response: Meeting,
  }),
  /** New link; the old one stops working at once (7.12 "iptal edilebilir"). */
  rotateMeetingLink: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/link',
    auth: 'session',
    response: Meeting,
  }),

  /**
   * Rings people into a meeting going on, like an incoming call ("Toplantıya davet = çaldırma"):
   * the people get call.ringing and the phone rings; turning it down or not answering tells the
   * person who rang. In a call's room it rings into the call.
   */
  ringToMeeting: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/ring',
    auth: 'session',
    body: RingCall,
    response: Call,
  }),

  // ---- Joining -------------------------------------------------------------------------
  /** Room link → meeting (public; no e-mails, no member names). 404 for unknown links. */
  getMeetingLink: def({
    method: 'GET',
    path: '/api/v1/meet/links/:slug',
    auth: 'public',
    response: MeetingLinkPreview,
  }),
  /**
   * The meetings the caller is in now, on any device: other devices show "Şu an bu toplantıdasın"
   * and offer joinMeeting with `device`. WS `meet.active` says when to ask again.
   */
  listActiveMeetings: def({
    method: 'GET',
    path: '/api/v1/meet/active',
    auth: 'session',
    response: ActiveMeetings,
  }),
  /** Same as getMeetingLink for a signed-in member, with the full meeting. */
  resolveMeetingLink: def({
    method: 'GET',
    path: '/api/v1/meet/links/:slug/meeting',
    auth: 'session',
    response: Meeting,
  }),
  /**
   * Members: a LiveKit token, or a lobby request when the caller has no direct access
   * (not in the space or conversation, or removed from this session).
   */
  joinMeeting: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/join',
    auth: 'session',
    body: JoinMeeting,
    response: MeetingJoinResult,
  }),
  /**
   * Guests (no account): knock with a name (7.13). Without a lobby the answer already
   * carries the connection. 403 meet_guests_disabled, 410 meet_link_expired.
   */
  requestGuestJoin: def({
    method: 'POST',
    path: '/api/v1/meet/links/:slug/guest',
    auth: 'public',
    body: GuestJoinRequest,
    response: GuestJoinTicket,
  }),
  /** Guest waiting room (7.14): poll every 2 s; admitted → connection. */
  pollGuestRequest: def({
    method: 'POST',
    path: '/api/v1/meet/guest-requests/:requestId/poll',
    auth: 'public',
    body: GuestPoll,
    response: GuestPollResult,
  }),
  cancelGuestRequest: def({
    method: 'POST',
    path: '/api/v1/meet/guest-requests/:requestId/cancel',
    auth: 'public',
    body: GuestPoll,
    response: Empty,
  }),
  /**
   * The meeting chat for a guest in the room (their knock's secret, that meeting only): the
   * current session's messages. 403 once they left the room, 404 when the meeting has no chat
   * (the room then uses its live channel).
   */
  listGuestChat: def({
    method: 'POST',
    path: '/api/v1/meet/guest-requests/:requestId/chat/list',
    auth: 'public',
    body: GuestPoll,
    response: GuestChatPage,
  }),
  sendGuestChat: def({
    method: 'POST',
    path: '/api/v1/meet/guest-requests/:requestId/chat',
    auth: 'public',
    body: SendGuestChat,
    response: GuestChatMessage,
  }),
  /** A member's own knock (from joinMeeting status lobby). */
  getLobbyRequest: def({
    method: 'GET',
    path: '/api/v1/meet/lobby/:requestId',
    auth: 'session',
    response: MeetingJoinResult,
  }),

  // ---- Inside the room (moderators) -----------------------------------------------------
  /** Who is in (from webhooks) and who waits in the lobby (7.8, 7.15). */
  listMeetingParticipants: def({
    method: 'GET',
    path: '/api/v1/meet/meetings/:meetingId/participants',
    auth: 'session',
    response: MeetingParticipantsLive,
  }),
  listMeetingLobby: def({
    method: 'GET',
    path: '/api/v1/meet/meetings/:meetingId/lobby',
    auth: 'session',
    response: items(LobbyRequest),
  }),
  /** "İçeri al" / "Reddet" / "Tümünü al" (7.15). */
  decideMeetingLobby: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/lobby/decide',
    auth: 'session',
    body: DecideLobby,
    response: items(LobbyRequest),
  }),
  /** 7.8 menu: mute, camera off, lower hand, remove (→ lobby next time), make moderator. */
  moderateMeetingParticipant: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/participants/moderate',
    auth: 'session',
    body: ModerateParticipant,
    response: Empty,
  }),
  muteAllInMeeting: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/participants/mute-all',
    auth: 'session',
    body: MuteAll,
    response: Empty,
  }),
  /** "Herkes için bitir": closes the LiveKit room; recordings stop. */
  endMeetingForAll: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/end',
    auth: 'session',
    response: Empty,
  }),

  // ---- Recordings ----------------------------------------------------------------------
  /** 7.10 dialog: target space and folder, free space, retention. */
  getRecordingTarget: def({
    method: 'GET',
    path: '/api/v1/meet/meetings/:meetingId/recording-target',
    auth: 'session',
    response: RecordingTarget,
  }),
  /** Moderators with the record right; everybody inside is told (room metadata + signal). */
  startMeetingRecording: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/recordings',
    auth: 'session',
    body: StartRecording,
    response: MeetingRecording,
  }),
  stopMeetingRecording: def({
    method: 'POST',
    path: '/api/v1/meet/recordings/:recordingId/stop',
    auth: 'session',
    response: MeetingRecording,
  }),
  listMeetingRecordings: def({
    method: 'GET',
    path: '/api/v1/meet/meetings/:meetingId/recordings',
    auth: 'session',
    response: items(MeetingRecording),
  }),

  // ---- Summary and settings ------------------------------------------------------------
  /** 7.17: duration, people and their minutes, recording, chat. Participants only. */
  getMeetingSession: def({
    method: 'GET',
    path: '/api/v1/meet/sessions/:sessionId',
    auth: 'session',
    response: MeetingSessionDetail,
  }),
  getMeetSpaceSettings: def({
    method: 'GET',
    path: '/api/v1/meet/spaces/:spaceId/settings',
    auth: 'session',
    response: MeetSpaceSettings,
  }),
  /** Space Admin and Owner. */
  updateMeetSpaceSettings: def({
    method: 'PATCH',
    path: '/api/v1/meet/spaces/:spaceId/settings',
    auth: 'session',
    body: UpdateMeetSpaceSettings,
    response: MeetSpaceSettings,
  }),

  // ---- Calls (H7) ----------------------------------------------------------------------
  /**
   * Rings the other members of a direct or group conversation (WS call.ringing, push
   * meet.call). A call already live in the conversation is returned instead (join it).
   */
  startCall: def({
    method: 'POST',
    path: '/api/v1/meet/calls',
    auth: 'session',
    body: StartCall,
    response: Call,
  }),
  /** The call or meeting going on in a conversation's room (chat header). Members only. */
  getConversationLive: def({
    method: 'GET',
    path: '/api/v1/meet/conversations/:conversationId/live',
    auth: 'session',
    response: ConversationLive,
  }),
  /** Calls ringing for the caller now (after a reload or a missed socket event). */
  listIncomingCalls: def({
    method: 'GET',
    path: '/api/v1/meet/calls/incoming',
    auth: 'session',
    response: items(Call),
  }),
  getCall: def({
    method: 'GET',
    path: '/api/v1/meet/calls/:callId',
    auth: 'session',
    response: Call,
  }),
  /** Then join the room with joinMeeting(call.meetingId). */
  answerCall: def({
    method: 'POST',
    path: '/api/v1/meet/calls/:callId/answer',
    auth: 'session',
    response: Call,
  }),
  declineCall: def({
    method: 'POST',
    path: '/api/v1/meet/calls/:callId/decline',
    auth: 'session',
    body: DeclineCall,
    response: Call,
  }),
  /**
   * CallKit "Reddet" while the app has no session (iOS VoIP push `declineUrl`): the signed token
   * names the call and the person. 403 forbidden for a bad or expired token.
   */
  declineCallSigned: def({
    method: 'POST',
    path: '/api/v1/meet/calls/:callId/decline-signed',
    auth: 'public',
    query: DeclineCallSigned,
    response: Empty,
  }),
  /** The caller hangs up before anyone answered: missed for the people rung. */
  cancelCall: def({
    method: 'POST',
    path: '/api/v1/meet/calls/:callId/cancel',
    auth: 'session',
    response: Call,
  }),
  /**
   * "Ayrıl" in a call: cancels it while it rings (caller), ends a one-to-one call for both and
   * closes its room; in a group call nothing changes for the others.
   */
  hangUpCall: def({
    method: 'POST',
    path: '/api/v1/meet/calls/:callId/hangup',
    auth: 'session',
    response: Call,
  }),
  /** Rings more people during the call; with a third person the call becomes a meeting. */
  ringCall: def({
    method: 'POST',
    path: '/api/v1/meet/calls/:callId/ring',
    auth: 'session',
    body: RingCall,
    response: Call,
  }),

  // ---- Remote control of a shared screen -----------------------------------------------
  /**
   * The sharing client reports a grant or revoke for the audit log
   * (meet.remote_control.granted|revoked). Control itself runs over MEET_CONTROL_TOPIC.
   */
  reportRemoteControl: def({
    method: 'POST',
    path: '/api/v1/meet/meetings/:meetingId/remote-control',
    auth: 'session',
    body: ReportRemoteControl,
    response: Empty,
  }),
} as const satisfies Record<string, EndpointDef>;
