import { z } from 'zod';
import { Id, Timestamp } from './common';
import { UserSummary } from './org';
import { SpaceColor, SpaceRole } from './space';

/**
 * Meetings on LiveKit (design 07, 19.21-19.22, mobile 13; doc 17 §2, §4, §11).
 * The api issues short-lived LiveKit access tokens; media never touches the api.
 * Live state inside a room (who speaks, raised hands, reactions) travels over the LiveKit
 * data channel and participant attributes (MeetSignal, MEET_ATTRIBUTES below).
 */

/** Routes outside the endpoint table. */
export const MEET_RAW_PATHS = {
  /** LiveKit server and egress webhooks (Authorization: LiveKit-signed JWT with the body hash). */
  livekitWebhook: '/api/meet/livekit/webhook',
} as const;

/** Web paths: the room link everybody (member or guest) opens, and the app pages. */
export const MEET_WEB_PATHS = {
  room: '/m/:slug',
  home: '/meetings',
  summary: '/meetings/summary/:sessionId',
} as const;

export const MEET_LIMITS = {
  titleChars: 120,
  guestNameChars: 60,
  invitees: 100,
  /** A guest who was turned away may ask again after this (design 7.14). */
  guestRetrySeconds: 60,
  /** An unanswered knock drops after this (design 7.14). */
  lobbyWaitSeconds: 600,
  /** Join button of a scheduled meeting appears this early (design 7.1). */
  joinEarlyMinutes: 5,
  /** Room closes this long after the last person left (design 07 rules). */
  emptyRoomSeconds: 120,
  /** LiveKit access token lifetime; the SDK refreshes it while connected. */
  tokenSeconds: 15 * 60,
  /** Recording retention: default 180 days (doc 17 §15 item 8). */
  defaultRetentionDays: 180,
  /** Free space a recording needs to start (design 7.10: "Yer aç"). */
  recordingMinFreeBytes: 200 * 1024 * 1024,
  /** Grid pages: 3×2 up to 6, 4×3 up to 12 (design 7.4). */
  gridPageSize: 12,
} as const;

// ---- Recordings and lobby (used by the meeting shapes below) ----------------------------

export const RecordingStatus = z.enum([
  'starting',
  'recording',
  'processing',
  'ready',
  'failed',
  'expired',
]);
export type RecordingStatus = z.infer<typeof RecordingStatus>;

export const MeetingRecording = z.object({
  id: Id,
  meetingId: Id,
  sessionId: Id.nullable(),
  status: RecordingStatus,
  audioOnly: z.boolean(),
  startedBy: UserSummary.nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  durationSeconds: z.number().int().nullable(),
  sizeBytes: z.number().int().nullable(),
  /** Drive file once ready (space › "Toplantı kayıtları"). */
  nodeId: Id.nullable(),
  spaceId: Id.nullable(),
  fileName: z.string().nullable(),
  /** Trashed by the retention rule after this. */
  expiresAt: Timestamp.nullable(),
  error: z.string().nullable(),
});
export type MeetingRecording = z.infer<typeof MeetingRecording>;

export const LobbyStatus = z.enum(['waiting', 'admitted', 'denied', 'expired', 'cancelled']);
export type LobbyStatus = z.infer<typeof LobbyStatus>;

export const LobbyRequest = z.object({
  id: Id,
  meetingId: Id,
  name: z.string(),
  /** Hub member knocking (no access or removed); null for a guest. */
  user: UserSummary.nullable(),
  guest: z.boolean(),
  status: LobbyStatus,
  requestedAt: Timestamp,
  decidedAt: Timestamp.nullable(),
  decidedBy: UserSummary.nullable(),
  /** Denied: may ask again from this time on. */
  retryAt: Timestamp.nullable(),
});
export type LobbyRequest = z.infer<typeof LobbyRequest>;

/**
 * A guest's knock. `secret` is returned only here and proves the request on polls
 * (the guest has no session).
 */
// ---- Meetings ---------------------------------------------------------------------------

/**
 * chat: the one-click room of a conversation (or an ad hoc "Hemen başlat").
 * room: persistent room with a fixed link ("Milvasoft Daily").
 * scheduled: has a start time, invitees, .ics invitations.
 */
export const MeetingKind = z.enum(['chat', 'room', 'scheduled']);
export type MeetingKind = z.infer<typeof MeetingKind>;

export const MeetingRecurrence = z.enum(['none', 'daily', 'weekdays', 'weekly']);
export type MeetingRecurrence = z.infer<typeof MeetingRecurrence>;

export const MeetingSettings = z.object({
  /** People without an account may join with the link (space setting must allow guests). */
  guestsAllowed: z.boolean(),
  /** Guests wait in the lobby until a moderator lets them in; off: they enter directly. */
  lobby: z.boolean(),
  /** Recording starts when the first moderator joins; everybody is told (design 7.2). */
  autoRecord: z.boolean(),
  /** Guest link lifetime after the start (design 7.12: 1 h or 24 h). */
  guestLinkHours: z.union([z.literal(1), z.literal(24)]),
  /** Screen sharers may hand over control ("Denetimi ver"); absent = on. A moderator turns it off. */
  remoteControl: z.boolean().optional(),
});
export type MeetingSettings = z.infer<typeof MeetingSettings>;

export const DEFAULT_MEETING_SETTINGS: MeetingSettings = {
  guestsAllowed: false,
  lobby: true,
  autoRecord: false,
  guestLinkHours: 24,
};

/** Role inside a meeting. Moderators: the host, space Admins/Owners, people made moderator. */
export const MeetingRole = z.enum(['moderator', 'member', 'listener', 'guest']);
export type MeetingRole = z.infer<typeof MeetingRole>;

export const MeetingInvitee = z.object({
  id: Id,
  /** Hub member; null for a guest invited by e-mail. */
  user: UserSummary.nullable(),
  email: z.string().nullable(),
  guest: z.boolean(),
});
export type MeetingInvitee = z.infer<typeof MeetingInvitee>;

export const MeetingRecordingState = z.object({
  id: Id,
  startedAt: Timestamp,
  startedBy: UserSummary.nullable(),
  audioOnly: z.boolean(),
});

/** Who is inside right now (from LiveKit webhooks). */
export const MeetingLiveState = z.object({
  sessionId: Id,
  startedAt: Timestamp,
  startedBy: UserSummary.nullable(),
  participantCount: z.number().int(),
  /** First few people inside, for avatars ("Zeynep, Elif, Can ve Mert içeride"). */
  participants: z.array(z.object({ name: z.string(), user: UserSummary.nullable() })),
  recording: MeetingRecordingState.nullable(),
});
export type MeetingLiveState = z.infer<typeof MeetingLiveState>;

/** What the caller may do; the server checks again on every request. */
export const MeetingPermissions = z.object({
  join: z.boolean(),
  /** Edit, cancel, invite, lobby, mute, remove, end for all. */
  moderate: z.boolean(),
  record: z.boolean(),
  /** Space allows guests (design 7.12 "Misafir izni kapalı · yöneticiye sor" otherwise). */
  inviteGuests: z.boolean(),
  /** Remote control of shared screens is allowed here (org setting and meeting setting). */
  remoteControl: z.boolean().optional(),
});

export const Meeting = z.object({
  id: Id,
  kind: MeetingKind,
  title: z.string(),
  description: z.string().nullable(),
  spaceId: Id.nullable(),
  spaceName: z.string().nullable(),
  spaceColor: SpaceColor.nullable(),
  /** The conversation the meeting is attached to (strip and system message there). */
  conversationId: Id.nullable(),
  /** The meeting's own conversation (conversations.type = meeting); null until chat runs. */
  chatConversationId: Id.nullable(),
  /** Link path segment: `/m/<slug>`. */
  slug: z.string(),
  /** Full room link for copying (HUB_URL/m/<slug>). */
  url: z.url(),
  host: UserSummary.nullable(),
  /** Scheduled meetings; for recurring ones the next occurrence. */
  startsAt: Timestamp.nullable(),
  durationMinutes: z.number().int().nullable(),
  recurrence: MeetingRecurrence,
  settings: MeetingSettings,
  invitees: z.array(MeetingInvitee),
  live: MeetingLiveState.nullable(),
  cancelledAt: Timestamp.nullable(),
  createdAt: Timestamp,
  myRole: MeetingRole.nullable(),
  permissions: MeetingPermissions,
  /**
   * The calendar event this meeting belongs to (created from the calendar): edit and cancel it
   * there (/calendar?event=<id>), the event keeps the meeting in step. Null or absent otherwise.
   */
  calendarEventId: Id.nullable().optional(),
});
export type Meeting = z.infer<typeof Meeting>;

/** One finished (or running) occurrence of a meeting: the history table of 7.1. */
export const MeetingSessionSummary = z.object({
  id: Id,
  meetingId: Id,
  title: z.string(),
  kind: MeetingKind,
  spaceId: Id.nullable(),
  spaceName: z.string().nullable(),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  durationSeconds: z.number().int().nullable(),
  participantCount: z.number().int(),
  participants: z.array(z.object({ name: z.string(), user: UserSummary.nullable() })),
  recordings: z.array(MeetingRecording),
  /**
   * `listMeetingHistory`: the room's `/m/<slug>` when the caller can go back in from this row,
   * decided by the server. Null or absent: no "Yeniden katıl" here.
   */
  rejoinSlug: z.string().nullable().optional(),
});
export type MeetingSessionSummary = z.infer<typeof MeetingSessionSummary>;

export const MeetingParticipantRecord = z.object({
  identity: z.string(),
  name: z.string(),
  user: UserSummary.nullable(),
  guest: z.boolean(),
  role: MeetingRole,
  joinedAt: Timestamp,
  leftAt: Timestamp.nullable(),
  /** Sum over the person's joins in this session. */
  seconds: z.number().int(),
});
export type MeetingParticipantRecord = z.infer<typeof MeetingParticipantRecord>;

/** Design 7.17: the summary page after a meeting. */
export const MeetingSessionDetail = MeetingSessionSummary.extend({
  meeting: Meeting,
  peakParticipants: z.number().int(),
  people: z.array(MeetingParticipantRecord),
  /** Seconds the caller was inside. */
  mySeconds: z.number().int(),
});
export type MeetingSessionDetail = z.infer<typeof MeetingSessionDetail>;

/** Design 7.1 / 19.21: open rooms, today's planned ones, persistent rooms. */
export const MeetHome = z.object({
  live: z.array(Meeting),
  today: z.array(Meeting),
  rooms: z.array(Meeting),
  upcomingCount: z.number().int(),
  recordingCount: z.number().int(),
});
export type MeetHome = z.infer<typeof MeetHome>;

/** `tz`: IANA zone of the caller for "Bugün" (defaults to UTC). */
export const MeetHomeQuery = z.object({ tz: z.string().max(64).optional() });

export const ListMeetingsQuery = z.object({
  view: z.enum(['upcoming', 'rooms', 'all']).default('upcoming'),
  spaceId: Id.optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const ListMeetingHistoryQuery = z.object({
  spaceId: Id.optional(),
  meetingId: Id.optional(),
  /** Only sessions with a recording ("Kayıtlar"). */
  recorded: z.stringbool().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ---- Meeting inputs ---------------------------------------------------------------------

export const MeetingInviteesInput = z.object({
  userIds: z.array(Id).max(MEET_LIMITS.invitees).default([]),
  /** Guests by e-mail; they get the link and an .ics (design 19.11). */
  emails: z.array(z.email()).max(MEET_LIMITS.invitees).default([]),
});

export const CreateMeeting = z.discriminatedUnion('mode', [
  /**
   * "Hemen başlat": opens the room right away. With conversationId the conversation's
   * room is reused (one room per conversation).
   */
  z.object({
    mode: z.literal('instant'),
    title: z.string().trim().min(1).max(MEET_LIMITS.titleChars).optional(),
    spaceId: Id.optional(),
    conversationId: Id.optional(),
  }),
  z.object({
    mode: z.literal('scheduled'),
    title: z.string().trim().min(1).max(MEET_LIMITS.titleChars),
    description: z.string().max(2000).optional(),
    spaceId: Id.optional(),
    conversationId: Id.optional(),
    startsAt: Timestamp,
    durationMinutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    recurrence: MeetingRecurrence.default('none'),
    invitees: MeetingInviteesInput.default({ userIds: [], emails: [] }),
    settings: MeetingSettings.partial().optional(),
  }),
  /** Persistent room with a fixed link; `slug` defaults to one made from the title. */
  z.object({
    mode: z.literal('room'),
    title: z.string().trim().min(1).max(MEET_LIMITS.titleChars),
    spaceId: Id.optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/)
      .optional(),
    settings: MeetingSettings.partial().optional(),
  }),
]);
export type CreateMeeting = z.infer<typeof CreateMeeting>;

export const UpdateMeeting = z.object({
  title: z.string().trim().min(1).max(MEET_LIMITS.titleChars).optional(),
  /** Move the meeting to another space (null: none); the same rule as starting one there. */
  spaceId: Id.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  startsAt: Timestamp.optional(),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(24 * 60)
    .optional(),
  recurrence: MeetingRecurrence.optional(),
  settings: MeetingSettings.partial().optional(),
  /** Replaces the invitee list; new people get the invitation, removed ones a cancel .ics. */
  invitees: MeetingInviteesInput.optional(),
});
export type UpdateMeeting = z.infer<typeof UpdateMeeting>;

/** 7.12 "E-postayla gönder" and "Hub üyeleri". */
export const InviteToMeeting = MeetingInviteesInput;

// ---- Joining ----------------------------------------------------------------------------

/** What the client publishes with; maps to LiveKit grants. */
export const MeetingGrants = z.object({
  publish: z.boolean(),
  /** Screen share is off for listeners and guests until a moderator allows it. */
  screenShare: z.boolean(),
  publishData: z.boolean(),
  subscribe: z.boolean(),
  roomAdmin: z.boolean(),
});
export type MeetingGrants = z.infer<typeof MeetingGrants>;

/** Everything the client needs to connect (livekit-client `room.connect(url, token)`). */
export const MeetingConnection = z.object({
  /** LiveKit signalling URL (wss://lk.<domain>). */
  url: z.string(),
  token: z.string(),
  roomName: z.string(),
  identity: z.string(),
  role: MeetingRole,
  grants: MeetingGrants,
  sessionId: Id.nullable(),
  expiresAt: Timestamp,
});
export type MeetingConnection = z.infer<typeof MeetingConnection>;

export const MeetingJoinResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('joined'), meeting: Meeting, connection: MeetingConnection }),
  /** The caller has no direct access (or was removed): wait for a moderator. */
  z.object({
    status: z.literal('lobby'),
    meeting: Meeting,
    request: LobbyRequest,
  }),
]);
export type MeetingJoinResult = z.infer<typeof MeetingJoinResult>;

export const JoinMeeting = z.object({
  /** Joining muted is a client choice; kept for the lobby card ("mikrofonu kapalı"). */
  muted: z.boolean().optional(),
  /**
   * The person is in this meeting on another device (listActiveMeetings). "transfer": it moves
   * here, the other devices get the `transferred` signal and leave. "add": this device joins as
   * well, under a connection of its own (microphone and camera off, speaker muted).
   * Left out: same connection as "transfer", without the signal (LiveKit drops the older one).
   */
  device: z.enum(['transfer', 'add']).optional(),
});

/**
 * What the room link shows before joining (public; design 7.13). Never e-mail addresses
 * or members of the space.
 */
export const MeetingLinkPreview = z.object({
  slug: z.string(),
  meetingId: Id,
  title: z.string(),
  orgName: z.string(),
  orgLogoUrl: z.string().nullable(),
  hostName: z.string().nullable(),
  startsAt: Timestamp.nullable(),
  durationMinutes: z.number().int().nullable(),
  /** valid: may knock or join; expired: guest link past its lifetime; ended: cancelled. */
  status: z.enum(['valid', 'expired', 'ended']),
  guestsAllowed: z.boolean(),
  lobby: z.boolean(),
  /** Initials of the people inside and their number (no names for guests). */
  insideInitials: z.array(z.string()),
  insideCount: z.number().int(),
  recording: z.boolean(),
});
export type MeetingLinkPreview = z.infer<typeof MeetingLinkPreview>;

export const GuestJoinRequest = z.object({
  name: z.string().trim().min(1).max(MEET_LIMITS.guestNameChars),
});

export const GuestJoinTicket = z.object({
  request: LobbyRequest,
  secret: z.string(),
  /** Set when the meeting has no lobby: the guest connects right away. */
  connection: MeetingConnection.nullable(),
});
export type GuestJoinTicket = z.infer<typeof GuestJoinTicket>;

export const GuestPoll = z.object({ secret: z.string().min(16).max(200) });

/**
 * The meeting chat as a guest sees it: name and text, no member ids or e-mails. Empty `text`: the
 * message only had a file or a GIF, which guests do not get.
 */
export const GuestChatMessage = z.object({
  id: Id,
  name: z.string(),
  /** Written by a guest. */
  guest: z.boolean(),
  /** Written by this guest. */
  mine: z.boolean(),
  text: z.string(),
  createdAt: Timestamp,
});
export type GuestChatMessage = z.infer<typeof GuestChatMessage>;

export const GuestChatPage = z.object({ items: z.array(GuestChatMessage) });
export type GuestChatPage = z.infer<typeof GuestChatPage>;

export const SendGuestChat = GuestPoll.extend({
  text: z.string().min(1).max(4000),
  clientMsgId: Id,
});

export const GuestPollResult = z.object({
  request: LobbyRequest,
  /** Present once admitted; a fresh token on every poll after that. */
  connection: MeetingConnection.nullable(),
  meetingTitle: z.string(),
});
export type GuestPollResult = z.infer<typeof GuestPollResult>;

export const DecideLobby = z.object({
  requestIds: z.array(Id).min(1).max(50),
  admit: z.boolean(),
});

// ---- Moderation -------------------------------------------------------------------------

export const ModerateAction = z.enum([
  'mute',
  'stop_camera',
  'stop_screen_share',
  'lower_hand',
  'remove',
  'make_moderator',
  'allow_screen_share',
  'allow_publish',
]);
export type ModerateAction = z.infer<typeof ModerateAction>;

export const ModerateParticipant = z.object({
  /** LiveKit identity (MEET_IDENTITY). */
  identity: z.string().min(1).max(200),
  action: ModerateAction,
});

/** "Herkesi sessize al" (7.8): everybody except moderators. */
export const MuteAll = z.object({ exceptModerators: z.boolean().default(true) });

/** Live participants as LiveKit sees them, for the panel before tracks arrive. */
export const MeetingParticipantsLive = z.object({
  items: z.array(MeetingParticipantRecord),
  lobby: z.array(LobbyRequest),
});

// ---- Recordings -------------------------------------------------------------------------

export const StartRecording = z.object({
  /** "Yalnız ses" (7.10): M4A instead of MP4. */
  audioOnly: z.boolean().default(false),
});

/** For the 7.10 dialog: where it goes and whether there is room. */
export const RecordingTarget = z.object({
  spaceId: Id,
  spaceName: z.string(),
  folderName: z.string(),
  freeBytes: z.number().int().nullable(),
  canStart: z.boolean(),
  retentionDays: z.number().int().nullable(),
});
export type RecordingTarget = z.infer<typeof RecordingTarget>;

// ---- Space settings ---------------------------------------------------------------------

/** Meeting rules of a space (space settings › Toplantı; doc 17 §15 item 8). */
export const MeetSpaceSettings = z.object({
  spaceId: Id,
  /** Guests may join this space's meetings by link (design 07: "Misafir izni space ayarıdır"). */
  guestsAllowed: z.boolean(),
  /** Editors may record (doc 17 §5: "ayar"); Admins and Owners always may. */
  editorsCanRecord: z.boolean(),
  /** Recordings go to the trash after this many days; null keeps them. */
  recordingRetentionDays: z.number().int().min(1).max(3650).nullable(),
});
export type MeetSpaceSettings = z.infer<typeof MeetSpaceSettings>;

export const UpdateMeetSpaceSettings = MeetSpaceSettings.omit({ spaceId: true }).partial();

// ---- Inside the room (LiveKit data channel and attributes) ------------------------------

/** LiveKit identities: `u:<userId>` for members, `g:<lobbyRequestId>` for guests. */
export const MEET_IDENTITY = {
  /** `device`: a second device of the same person ("Bu cihazı da ekle"). */
  user: (userId: string, device?: string) => `u:${userId}${device ? `#${device}` : ''}`,
  guest: (requestId: string) => `g:${requestId}`,
  parse(identity: string): { kind: 'user' | 'guest'; id: string } | null {
    const m = /^([ug]):([0-9a-f-]{36})(?:#[0-9a-z]{1,16})?$/i.exec(identity);
    if (!m) return null;
    return { kind: m[1] === 'u' ? 'user' : 'guest', id: m[2]!.toLowerCase() };
  },
};

/** Participant metadata (JSON, set by the api in the token). */
export const MeetParticipantMeta = z.object({
  userId: Id.nullable(),
  role: MeetingRole,
  guest: z.boolean(),
  imageUrl: z.string().nullable(),
});
export type MeetParticipantMeta = z.infer<typeof MeetParticipantMeta>;

/**
 * Participant attributes each client sets on itself (late joiners see them):
 * `hand` = ISO time the hand went up ('' when down), `status` = 'away' | ''.
 */
export const MEET_ATTRIBUTES = { hand: 'hand', status: 'status' } as const;

/** Room metadata (JSON, set by the api): recording state for everybody in the room. */
export const MeetRoomMeta = z.object({
  meetingId: Id,
  recording: z
    .object({ id: Id, startedAt: Timestamp, by: z.string().nullable(), audioOnly: z.boolean() })
    .nullable(),
  /** Remote control allowed in this room (org and meeting settings); absent = allowed. */
  remoteControl: z.boolean().optional(),
});
export type MeetRoomMeta = z.infer<typeof MeetRoomMeta>;

export const MEET_SIGNAL_TOPIC = 'crewhall.meet';
export const MEET_REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🤔'] as const;

/** Messages on the data channel (topic MEET_SIGNAL_TOPIC). */
export const MeetSignal = z.discriminatedUnion('type', [
  /** Floats over the sender's tile for 3 s (design 7.6). */
  z.object({ type: z.literal('reaction'), emoji: z.enum(MEET_REACTIONS) }),
  /** From the api to moderators: someone knocked; refetch the lobby (design 7.15). */
  z.object({ type: z.literal('lobby'), waiting: z.number().int() }),
  /** From the api: recording started or stopped (room metadata carries the state too). */
  z.object({ type: z.literal('recording'), recordingId: Id, active: z.boolean() }),
  /** From the api: a moderator lowered your hand or changed your rights. */
  z.object({ type: z.literal('moderated'), action: ModerateAction }),
  /** From the api: "Herkes için bitir". */
  z.object({ type: z.literal('ended') }),
  /** From the api: this person moved the meeting to another device; leave without a goodbye. */
  z.object({ type: z.literal('transferred') }),
]);
export type MeetSignal = z.infer<typeof MeetSignal>;

// ---- Permission helper ------------------------------------------------------------------

const RANK: Record<SpaceRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

/**
 * Meeting rules of doc 17 §5 ("Chat ve toplantı"), shared by api and clients:
 * start/join for every space role (viewers listen), record for Admin+ and for Editors
 * when the space allows it; never for guests.
 */
export function canMeet(
  action: 'start' | 'join' | 'publish' | 'record',
  input: {
    spaceRole: SpaceRole | null;
    moderator: boolean;
    guest: boolean;
    editorsCanRecord: boolean;
  },
): boolean {
  const { spaceRole, moderator, guest } = input;
  switch (action) {
    case 'start':
      return !guest && (spaceRole === null || RANK[spaceRole] >= RANK.editor);
    case 'join':
      return true;
    case 'publish':
      return guest || moderator || spaceRole === null || RANK[spaceRole] >= RANK.editor;
    case 'record':
      if (guest || !moderator) return false;
      if (spaceRole === null) return true;
      return RANK[spaceRole] >= RANK.admin || (spaceRole === 'editor' && input.editorsCanRecord);
  }
}

// ---- Calls (H7: Teams-style calls from a direct or group chat) --------------------------

/** How long a call rings before it counts as missed. */
export const CALL_RING_SECONDS = 45;

export const CallStatus = z.enum(['ringing', 'active', 'ended', 'missed', 'declined', 'cancelled']);
export type CallStatus = z.infer<typeof CallStatus>;

/** Per person rung: `busy` when they were in another call or meeting, or said so. */
export const CallMemberState = z.enum(['ringing', 'accepted', 'declined', 'busy', 'missed']);
export type CallMemberState = z.infer<typeof CallMemberState>;

export const CallMember = z.object({
  user: UserSummary,
  state: CallMemberState,
  at: Timestamp,
  /** Who rang this person, when not `Call.caller`: their call screen shows this name. */
  by: UserSummary.nullable().optional(),
});
export type CallMember = z.infer<typeof CallMember>;

/**
 * A call takes place in the conversation's meeting room (Meeting.kind = 'chat'): answer, then
 * join with joinMeeting(meetingId). Ringing ends after CALL_RING_SECONDS. Adding someone during
 * the call (ringCall) makes it a meeting (`upgraded`).
 */
export const Call = z.object({
  id: Id,
  meetingId: Id,
  /** Room address: /meetings/room/<slug>. */
  slug: z.string(),
  conversationId: Id,
  /** Group conversation name; null for a direct chat. */
  conversationTitle: z.string().nullable(),
  caller: UserSummary.nullable(),
  video: z.boolean(),
  status: CallStatus,
  members: z.array(CallMember),
  upgraded: z.boolean(),
  /**
   * Someone in a meeting going on rings people into it ("X seni toplantıya çağırıyor"): the
   * conversation is the meeting's own chat and the title is the meeting's. Absent: a call.
   */
  invite: z.boolean().optional(),
  startedAt: Timestamp,
  answeredAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  durationSeconds: z.number().int().nullable(),
});
export type Call = z.infer<typeof Call>;

/**
 * What goes on in a conversation's room right now (chat header: "Sürüyor · Katıl" instead of the
 * call buttons). The conversation has one room; a call rings in it, a meeting runs in it.
 */
export const ConversationLive = z.object({
  /** A call ringing or going on in the conversation. */
  call: Call.nullable(),
  /** The conversation's room while people are in it (with or without a call). */
  meeting: z
    .object({
      id: Id,
      slug: z.string(),
      startedAt: Timestamp,
      participantCount: z.number().int(),
    })
    .nullable(),
});
export type ConversationLive = z.infer<typeof ConversationLive>;

export const StartCall = z.object({
  conversationId: Id,
  video: z.boolean().default(false),
});
export type StartCall = z.infer<typeof StartCall>;

/** Token of a VoIP push's declineUrl (query `token`). */
export const DeclineCallSigned = z.object({ token: z.string().min(16).max(2000) });

export const DeclineCall = z.object({
  /** "Meşgulüm": the caller sees busy instead of declined. */
  busy: z.boolean().default(false),
});
export type DeclineCall = z.infer<typeof DeclineCall>;

export const RingCall = z.object({
  userIds: z.array(Id).min(1).max(MEET_LIMITS.invitees),
});
export type RingCall = z.infer<typeof RingCall>;

/** A meeting the caller is in right now, on any device. */
export const ActiveMeeting = z.object({
  meetingId: Id,
  slug: z.string(),
  title: z.string(),
  /** How many of their devices are in it. */
  devices: z.number().int(),
  since: Timestamp,
});
export type ActiveMeeting = z.infer<typeof ActiveMeeting>;

export const ActiveMeetings = z.object({ items: z.array(ActiveMeeting) });
export type ActiveMeetings = z.infer<typeof ActiveMeetings>;

/**
 * Over the WebSocket (WsServerEvent): `call.ringing` to the people being rung (show the
 * incoming call and ring), `call.updated` to everybody in the call on every change.
 */
export const MeetWsEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('call.ringing'), call: Call }),
  z.object({ type: z.literal('call.updated'), call: Call }),
  /** To one person: the meetings they are in changed; fetch listActiveMeetings again. */
  z.object({ type: z.literal('meet.active') }),
]);
export type MeetWsEvent = z.infer<typeof MeetWsEvent>;

/**
 * Notifications of the meet module (Notification.type). `meet.call` is push only (no bell row):
 * a high-priority push that rings the phone (mobile: full-screen call notification); its
 * PushData carries `callId`. `meet.call_missed` is the missed-call notification.
 */
export const MEET_NOTIFICATION_TYPES = [
  'meet.invited',
  'meet.recording_ready',
  'meet.call',
  'meet.call_missed',
  /** A scheduled meeting moved or changed (time, title, description). */
  'meet.updated',
  /** A scheduled meeting was cancelled. */
  'meet.cancelled',
  /** Someone rung into a meeting turned it down (to the person who rang). */
  'meet.ring_declined',
  /** Someone rung into a meeting did not answer (to the person who rang). */
  'meet.ring_unanswered',
] as const;

/**
 * How a `meet.call` push rings: the Android channel the app creates with the call melody
 * (its id changes with the melody, channel sounds cannot change later) and the iOS sound file.
 */
export const MEET_CALL_PUSH = { androidChannel: 'calls-v1', sound: 'call_incoming.wav' } as const;

// ---- Remote control of a shared screen ("Denetimi iste / ver") ---------------------------

/**
 * Data channel topic of remote control. Only the desktop app (Electron) can be controlled: while
 * it shares the whole screen it sets the participant attribute MEET_REMOTE_CONTROL_ATTRIBUTE to
 * "1"; clients offer "Denetim iste" only then. The sharing client applies `input` from the one
 * person it granted and ignores everyone else's, guests' (`g:` identities) always.
 */
export const MEET_CONTROL_TOPIC = 'meet.control';
export const MEET_REMOTE_CONTROL_ATTRIBUTE = 'crewhall.remoteControl';

/** A point on the shared frame: 0..1 from the left/top edge of the picture itself. */
const Unit = z.number().min(0).max(1);

export const MeetControlMods = z.object({
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  meta: z.boolean(),
});
export type MeetControlMods = z.infer<typeof MeetControlMods>;

/** Mouse buttons: 0 left, 1 middle, 2 right (DOM `MouseEvent.button`). */
const MouseButton = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const MeetControlInput = z.discriminatedUnion('k', [
  z.object({ k: z.literal('move'), x: Unit, y: Unit }),
  z.object({ k: z.literal('down'), b: MouseButton, x: Unit, y: Unit }),
  z.object({ k: z.literal('up'), b: MouseButton, x: Unit, y: Unit }),
  /** Wheel deltas in pixels (DOM `WheelEvent`, deltaMode normalised to pixels). */
  z.object({ k: z.literal('wheel'), dx: z.number(), dy: z.number() }),
  /** DOM `KeyboardEvent.code` (layout independent) and `key`. */
  z.object({
    k: z.literal('key'),
    code: z.string().min(1).max(64),
    key: z.string().min(1).max(64),
    down: z.boolean(),
    mods: MeetControlMods,
  }),
  /** Text typed with an input method or pasted. */
  z.object({ k: z.literal('text'), text: z.string().min(1).max(2000) }),
]);
export type MeetControlInput = z.infer<typeof MeetControlInput>;

/**
 * request: viewer → sharer. grant / deny {to: identity}, revoke: sharer → everyone (one
 * controller at a time; a new grant replaces the old). release: the controller gives it back.
 * input: controller → sharer.
 */
export const MeetControlMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request') }),
  z.object({ type: z.literal('grant'), to: z.string().min(1) }),
  z.object({ type: z.literal('deny'), to: z.string().min(1) }),
  z.object({ type: z.literal('revoke') }),
  z.object({ type: z.literal('release') }),
  z.object({ type: z.literal('input'), ev: MeetControlInput }),
]);
export type MeetControlMessage = z.infer<typeof MeetControlMessage>;

/** Pointer moves and wheel go lossy (latest wins); everything else reliable. */
export function controlReliable(m: MeetControlMessage): boolean {
  return !(m.type === 'input' && (m.ev.k === 'move' || m.ev.k === 'wheel'));
}

/** Guests (link joins) never control a screen. */
export function mayControl(identity: string): boolean {
  return MEET_IDENTITY.parse(identity)?.kind === 'user';
}

/** Remote control audit report from the sharing client (meet.remote_control.granted|revoked). */
export const ReportRemoteControl = z.object({
  event: z.enum(['granted', 'revoked']),
  /** The person given (or losing) control. */
  userId: Id,
});
export type ReportRemoteControl = z.infer<typeof ReportRemoteControl>;
