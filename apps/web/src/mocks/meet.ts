import {
  type Call,
  DEFAULT_MEETING_SETTINGS,
  type EndpointName,
  type GuestChatMessage,
  MEET_IDENTITY,
  type LobbyRequest,
  type Meeting,
  type MeetingConnection,
  type MeetingGrants,
  type MeetingRecording,
  type MeetingRole,
  type MeetingSessionSummary,
  type MeetSpaceSettings,
} from '@crewhall/shared';
import { MockApiError, myRole, randomToken, requireUser, summary, type Resolvers } from './core';
import { chatState, emitToUsers } from './chat';
import { db, newId } from './db';
import { type MockState, type MockUser } from './seed';

/**
 * Meet part of the contract mock (design 07). State lives under its own storage key so the
 * shared mock db stays untouched. Tokens are signed for the dev LiveKit of
 * docker/compose.dev.yml (profile meet), so `dev:mock` plus that container gives a real room.
 */

const LIVEKIT_URL = 'ws://localhost:7880';
const LIVEKIT_KEY = 'crewhall-dev';
const LIVEKIT_SECRET = 'crewhall-dev-livekit-secret-0123456789abcdef';
const KEY = 'crewhall.mock.meet';

interface MockMeeting {
  id: string;
  kind: Meeting['kind'];
  title: string;
  description: string | null;
  spaceId: string | null;
  conversationId: string | null;
  slug: string;
  hostId: string;
  startsAt: string | null;
  durationMinutes: number | null;
  recurrence: Meeting['recurrence'];
  settings: Meeting['settings'];
  invitees: { id: string; userId: string | null; email: string | null }[];
  cancelledAt: string | null;
  createdAt: string;
}

interface MockSession {
  id: string;
  meetingId: string;
  startedAt: string;
  endedAt: string | null;
  startedBy: string | null;
  people: {
    identity: string;
    userId: string | null;
    name: string;
    joinedAt: string;
    leftAt: string | null;
  }[];
}

interface MeetState {
  meetings: MockMeeting[];
  sessions: MockSession[];
  lobby: (LobbyRequest & { secret: string })[];
  recordings: MeetingRecording[];
  spaceSettings: Record<string, Omit<MeetSpaceSettings, 'spaceId'>>;
  /** Calls (H7); older stored states have none. */
  calls?: Call[];
}

let cache: MeetState | null = null;

function seed(s: MockState): MeetState {
  const owner = s.users[0];
  const shared = s.spaces.find((x) => x.kind === 'shared');
  const now = Date.now();
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  // The demo starts in 45 minutes, but stays today (it is listed under "Bugün") near midnight.
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const laterToday = Math.min(45, Math.max(1, Math.floor((midnight.getTime() - now) / 120_000)));
  const meetings: MockMeeting[] = owner
    ? [
        {
          id: newId(),
          kind: 'room',
          title: 'Milvasoft Daily',
          description: null,
          spaceId: shared?.id ?? null,
          conversationId: null,
          slug: 'milvasoft-daily',
          hostId: owner.id,
          startsAt: null,
          durationMinutes: null,
          recurrence: 'none',
          settings: { ...DEFAULT_MEETING_SETTINGS },
          invitees: [],
          cancelledAt: null,
          createdAt: at(-60 * 24 * 7),
        },
        {
          id: newId(),
          kind: 'scheduled',
          title: 'Opsiyon · ürün demosu',
          description: 'Opsiyon yönetim paneli demosu ve ilk geri bildirimler.',
          spaceId: shared?.id ?? null,
          conversationId: null,
          slug: 'opsiyon-demo-7k2xq',
          hostId: owner.id,
          startsAt: at(laterToday),
          durationMinutes: 45,
          recurrence: 'none',
          settings: { ...DEFAULT_MEETING_SETTINGS, guestsAllowed: true },
          invitees: [{ id: newId(), userId: null, email: 'deniz.kaya@opsiyon.com.tr' }],
          cancelledAt: null,
          createdAt: at(-60),
        },
      ]
    : [];
  return { meetings, sessions: [], lobby: [], recordings: [], spaceSettings: {} };
}

function state(s: MockState): MeetState {
  if (cache) return cache;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    cache = raw ? (JSON.parse(raw) as MeetState) : seed(s);
  } catch {
    cache = seed(s);
  }
  return cache;
}

function persist() {
  try {
    if (cache && typeof localStorage !== 'undefined') {
      localStorage.setItem(KEY, JSON.stringify(cache));
    }
  } catch {
    /* best effort */
  }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));

/** HS256 LiveKit access token for the dev server (the secret is a public dev value). */
async function liveKitToken(claims: Record<string, unknown>) {
  const head = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(claims);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(LIVEKIT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${base64url(sig)}`;
}

function grantsFor(role: MeetingRole): MeetingGrants {
  return {
    publish: role !== 'listener',
    screenShare: role === 'moderator' || role === 'member',
    publishData: true,
    subscribe: true,
    roomAdmin: role === 'moderator',
  };
}

async function connection(
  m: MockMeeting,
  who: { identity: string; name: string; role: MeetingRole; userId: string | null },
  sessionId: string | null,
): Promise<MeetingConnection> {
  const grants = grantsFor(who.role);
  const exp = Math.floor(Date.now() / 1000) + 15 * 60;
  const token = await liveKitToken({
    iss: LIVEKIT_KEY,
    sub: who.identity,
    name: who.name,
    nbf: Math.floor(Date.now() / 1000) - 10,
    exp,
    metadata: JSON.stringify({
      userId: who.userId,
      role: who.role,
      guest: who.role === 'guest',
      imageUrl: null,
    }),
    video: {
      room: `m-${m.id}`,
      roomJoin: true,
      roomAdmin: grants.roomAdmin,
      canPublish: grants.publish,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: true,
      canPublishSources: grants.publish
        ? [
            'camera',
            'microphone',
            ...(grants.screenShare ? ['screen_share', 'screen_share_audio'] : []),
          ]
        : [],
    },
  });
  return {
    url: LIVEKIT_URL,
    token,
    roomName: `m-${m.id}`,
    identity: who.identity,
    role: who.role,
    grants,
    sessionId,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function roleOf(s: MockState, m: MockMeeting, u: MockUser): { role: MeetingRole; direct: boolean } {
  const spaceRole = m.spaceId ? myRole(s, m.spaceId, u.id) : null;
  const moderator = m.hostId === u.id || spaceRole === 'owner' || spaceRole === 'admin';
  const invited = m.invitees.some((i) => i.userId === u.id);
  const direct = moderator || invited || (m.spaceId ? spaceRole !== null : true);
  const role: MeetingRole = moderator
    ? 'moderator'
    : spaceRole === 'viewer' && !invited
      ? 'listener'
      : 'member';
  return { role, direct };
}

function liveSession(ms: MeetState, meetingId: string) {
  return ms.sessions.find((x) => x.meetingId === meetingId && !x.endedAt) ?? null;
}

function toMeeting(s: MockState, ms: MeetState, m: MockMeeting, u: MockUser): Meeting {
  const space = m.spaceId ? s.spaces.find((x) => x.id === m.spaceId) : undefined;
  const host = s.users.find((x) => x.id === m.hostId);
  const { role, direct } = roleOf(s, m, u);
  const session = liveSession(ms, m.id);
  const inside = session?.people.filter((p) => !p.leftAt) ?? [];
  const rec = ms.recordings.find(
    (r) => r.meetingId === m.id && (r.status === 'recording' || r.status === 'starting'),
  );
  const userOf = (id: string | null) => {
    const x = id ? s.users.find((y) => y.id === id) : undefined;
    return x ? summary(x) : null;
  };
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    description: m.description,
    spaceId: m.spaceId,
    spaceName: space?.name ?? null,
    spaceColor: space?.color ?? null,
    conversationId: m.conversationId,
    chatConversationId: null,
    slug: m.slug,
    url: `${window.location.origin}/m/${m.slug}`,
    host: host ? summary(host) : null,
    startsAt: m.startsAt,
    durationMinutes: m.durationMinutes,
    recurrence: m.recurrence,
    settings: m.settings,
    invitees: m.invitees.map((i) => ({
      id: i.id,
      user: userOf(i.userId),
      email: i.userId ? null : i.email,
      guest: !i.userId,
    })),
    live: session
      ? {
          sessionId: session.id,
          startedAt: session.startedAt,
          startedBy: userOf(session.startedBy),
          participantCount: inside.length,
          participants: inside.map((p) => ({ name: p.name, user: userOf(p.userId) })),
          recording: rec
            ? {
                id: rec.id,
                startedAt: rec.startedAt,
                startedBy: rec.startedBy,
                audioOnly: rec.audioOnly,
              }
            : null,
        }
      : null,
    cancelledAt: m.cancelledAt,
    createdAt: m.createdAt,
    myRole: direct ? role : null,
    permissions: {
      join: !m.cancelledAt,
      moderate: direct && role === 'moderator',
      record: direct && role === 'moderator',
      inviteGuests: role === 'moderator',
    },
  };
}

function find(ms: MeetState, id: string) {
  const m = ms.meetings.find((x) => x.id === id);
  if (!m) throw new MockApiError('not_found');
  return m;
}

function visible(s: MockState, m: MockMeeting, u: MockUser) {
  return !m.cancelledAt && roleOf(s, m, u).direct;
}

/** Simulates LiveKit's participant_joined webhook when someone gets a token. */
function joinSession(
  ms: MeetState,
  m: MockMeeting,
  who: { identity: string; userId: string | null; name: string },
) {
  let session = liveSession(ms, m.id);
  if (!session) {
    session = {
      id: newId(),
      meetingId: m.id,
      startedAt: new Date().toISOString(),
      endedAt: null,
      startedBy: who.userId,
      people: [],
    };
    ms.sessions.push(session);
  }
  if (!session.people.some((p) => p.identity === who.identity && !p.leftAt)) {
    session.people.push({ ...who, joinedAt: new Date().toISOString(), leftAt: null });
  }
  return session;
}

function summaryOf(s: MockState, ms: MeetState, session: MockSession): MeetingSessionSummary {
  const m = find(ms, session.meetingId);
  const space = m.spaceId ? s.spaces.find((x) => x.id === m.spaceId) : undefined;
  const people = [...new Map(session.people.map((p) => [p.identity, p])).values()];
  return {
    id: session.id,
    meetingId: m.id,
    title: m.title,
    kind: m.kind,
    spaceId: m.spaceId,
    spaceName: space?.name ?? null,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationSeconds: session.endedAt
      ? Math.round(
          (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000,
        )
      : null,
    participantCount: people.length,
    participants: people.map((p) => {
      const x = p.userId ? s.users.find((y) => y.id === p.userId) : undefined;
      return { name: p.name, user: x ? summary(x) : null };
    }),
    recordings: ms.recordings.filter((r) => r.sessionId === session.id),
    // As the api, without its rights and expiry: the newest finished session of an open meeting.
    rejoinSlug:
      !m.cancelledAt &&
      ms.sessions.findLast((x) => x.meetingId === m.id && x.endedAt)?.id === session.id
        ? m.slug
        : null,
  };
}

const spaceSettings = (ms: MeetState, spaceId: string): MeetSpaceSettings => ({
  spaceId,
  ...(ms.spaceSettings[spaceId] ?? {
    guestsAllowed: true,
    editorsCanRecord: true,
    recordingRetentionDays: 180,
  }),
});

function lobbyOut(r: LobbyRequest & { secret: string }): LobbyRequest {
  const { secret: _secret, ...rest } = r;
  void _secret;
  return rest;
}

/** Calls (H7): the mock rings over its simulated socket; nobody answers on their own. */
function callOf(ms: MeetState, id: string): Call {
  const c = (ms.calls ?? []).find((x) => x.id === id);
  if (!c) throw new MockApiError('not_found');
  return c;
}

function emitCall(c: Call, ring: string[] = []) {
  const all = [c.caller?.id, ...c.members.map((m) => m.user.id)].filter(Boolean) as string[];
  emitToUsers(
    all.filter((id) => !ring.includes(id)),
    { type: 'call.updated', call: c },
  );
  if (ring.length) emitToUsers(ring, { type: 'call.ringing', call: c });
}

/** A guest's meeting chat in the mock: lines of this tab only. */
const guestChatLines: GuestChatMessage[] = [];

const callResolvers: Partial<Resolvers<EndpointName>> = {
  startCall: ({ s, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const chat = chatState(s);
    const conv = chat.conversations.find((c) => c.id === body.conversationId);
    if (!conv) throw new MockApiError('not_found');
    if (conv.type !== 'direct' && conv.type !== 'group') {
      throw new MockApiError('meet_call_unavailable');
    }
    const live = (ms.calls ?? []).find(
      (c) => c.conversationId === conv.id && (c.status === 'ringing' || c.status === 'active'),
    );
    if (live) return live;
    const meeting =
      ms.meetings.find((m) => m.conversationId === conv.id && m.kind === 'chat') ??
      (() => {
        const m: MockMeeting = {
          id: newId(),
          kind: 'chat',
          title: conv.name ?? 'Arama',
          description: null,
          spaceId: null,
          conversationId: conv.id,
          slug: `arama-${randomToken(4)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, 'x')
            .slice(0, 5)}`,
          hostId: u.id,
          startsAt: null,
          durationMinutes: null,
          recurrence: 'none',
          settings: { ...DEFAULT_MEETING_SETTINGS },
          invitees: [],
          cancelledAt: null,
          createdAt: new Date().toISOString(),
        };
        ms.meetings.push(m);
        return m;
      })();
    const at = new Date().toISOString();
    const members = chat.members
      .filter((m) => m.conversationId === conv.id && m.userId !== u.id)
      .flatMap((m) => {
        const user = s.users.find((x) => x.id === m.userId);
        return user ? [{ user: summary(user), state: 'ringing' as const, at }] : [];
      });
    const call: Call = {
      id: newId(),
      meetingId: meeting.id,
      slug: meeting.slug,
      conversationId: conv.id,
      conversationTitle: conv.type === 'direct' ? null : conv.name,
      caller: summary(u),
      video: body.video,
      status: 'ringing',
      members,
      upgraded: false,
      startedAt: at,
      answeredAt: null,
      endedAt: null,
      durationSeconds: null,
    };
    ms.calls = [...(ms.calls ?? []), call];
    persist();
    emitCall(
      call,
      members.map((m) => m.user.id),
    );
    return call;
  },
  ringToMeeting: ({ s, params, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    const at = new Date().toISOString();
    const people = body.userIds.flatMap((id) => {
      const user = s.users.find((x) => x.id === id);
      return user ? [{ user: summary(user), state: 'ringing' as const, at }] : [];
    });
    let call = (ms.calls ?? []).find(
      (c) => c.meetingId === m.id && (c.status === 'ringing' || c.status === 'active'),
    );
    if (call) {
      call.members = [...call.members.filter((x) => !body.userIds.includes(x.user.id)), ...people];
    } else {
      call = {
        id: newId(),
        meetingId: m.id,
        slug: m.slug,
        conversationId: m.conversationId ?? newId(),
        conversationTitle: m.title,
        caller: summary(u),
        video: true,
        status: 'active',
        members: people,
        upgraded: true,
        invite: true,
        startedAt: at,
        answeredAt: at,
        endedAt: null,
        durationSeconds: null,
      };
      ms.calls = [...(ms.calls ?? []), call];
    }
    persist();
    emitCall(call, body.userIds);
    return call;
  },
  listIncomingCalls: ({ s }) => {
    const u = requireUser(s);
    const items = (state(s).calls ?? []).filter(
      (c) =>
        (c.status === 'ringing' || c.status === 'active') &&
        c.members.some((m) => m.user.id === u.id && m.state === 'ringing'),
    );
    return { items };
  },
  getCall: ({ s, params }) => callOf(state(s), params.callId!),
  getConversationLive: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    const conv = chatState(s).conversations.find((c) => c.id === params.conversationId);
    if (!conv) throw new MockApiError('not_found');
    const call =
      (ms.calls ?? []).find(
        (c) => c.conversationId === conv.id && (c.status === 'ringing' || c.status === 'active'),
      ) ?? null;
    const room = ms.meetings.find((m) => m.conversationId === conv.id && m.kind === 'chat');
    const session = room
      ? ms.sessions.find((x) => x.meetingId === room.id && !x.endedAt)
      : undefined;
    const inside = session?.people.filter((p) => !p.leftAt).length ?? 0;
    return {
      call,
      meeting:
        room && session && inside > 0
          ? { id: room.id, slug: room.slug, startedAt: session.startedAt, participantCount: inside }
          : null,
    };
  },
  answerCall: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const c = callOf(ms, params.callId!);
    if (c.status !== 'ringing' && c.status !== 'active') {
      throw new MockApiError('meet_call_over');
    }
    const at = new Date().toISOString();
    c.members = c.members.map((m) => (m.user.id === u.id ? { ...m, state: 'accepted', at } : m));
    c.status = 'active';
    c.answeredAt ??= at;
    persist();
    emitCall(c);
    return c;
  },
  declineCall: ({ s, params, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const c = callOf(ms, params.callId!);
    const at = new Date().toISOString();
    c.members = c.members.map((m) =>
      m.user.id === u.id && m.state === 'ringing'
        ? { ...m, state: body.busy ? 'busy' : 'declined', at }
        : m,
    );
    if (c.status === 'ringing' && !c.members.some((m) => m.state === 'ringing')) {
      c.status = 'declined';
      c.endedAt = at;
    }
    persist();
    emitCall(c);
    return c;
  },
  hangUpCall: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const c = callOf(ms, params.callId!);
    const at = new Date().toISOString();
    if (c.status === 'ringing' && c.caller?.id === u.id) {
      c.status = 'cancelled';
      c.endedAt = at;
      c.members = c.members.map((m) => (m.state === 'ringing' ? { ...m, state: 'missed', at } : m));
    } else if (c.status === 'active' && c.members.length === 1) {
      c.status = 'ended';
      c.endedAt = at;
    }
    persist();
    emitCall(c);
    return c;
  },
  cancelCall: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    const c = callOf(ms, params.callId!);
    if (c.status === 'ringing') {
      const at = new Date().toISOString();
      c.status = 'cancelled';
      c.endedAt = at;
      c.members = c.members.map((m) => (m.state === 'ringing' ? { ...m, state: 'missed', at } : m));
      persist();
      emitCall(c);
    }
    return c;
  },
};

export const meetResolvers: Partial<Resolvers<EndpointName>> = {
  ...callResolvers,
  getMeetHome: ({ s }) => {
    const u = requireUser(s);
    const ms = state(s);
    const list = ms.meetings.filter((m) => visible(s, m, u));
    const today = new Date().toDateString();
    const out = {
      live: list.filter((m) => liveSession(ms, m.id)).map((m) => toMeeting(s, ms, m, u)),
      today: list
        .filter((m) => m.startsAt && new Date(m.startsAt).toDateString() === today)
        .map((m) => toMeeting(s, ms, m, u)),
      rooms: list.filter((m) => m.kind === 'room').map((m) => toMeeting(s, ms, m, u)),
      upcomingCount: list.filter((m) => m.kind === 'scheduled').length,
      recordingCount: ms.recordings.filter((r) => r.status === 'ready').length,
    };
    return out;
  },
  listMeetings: ({ s, query }) => {
    const u = requireUser(s);
    const ms = state(s);
    const items = ms.meetings
      .filter((m) => visible(s, m, u))
      .filter((m) =>
        query.view === 'rooms'
          ? m.kind === 'room'
          : query.view === 'upcoming'
            ? m.kind === 'scheduled'
            : true,
      )
      .map((m) => toMeeting(s, ms, m, u));
    return { items, nextCursor: null };
  },
  listMeetingHistory: ({ s, query }) => {
    requireUser(s);
    const ms = state(s);
    const items = ms.sessions
      .filter((x) => x.endedAt && (!query.meetingId || x.meetingId === query.meetingId))
      .map((x) => summaryOf(s, ms, x))
      .filter((x) => !query.recorded || x.recordings.length)
      .reverse();
    return { items, nextCursor: null };
  },
  createMeeting: ({ s, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const title = ('title' in body && body.title) || 'Hızlı görüşme';
    const id = newId();
    const slugBase = title
      .toLocaleLowerCase('tr')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
    const slug =
      body.mode === 'room' && body.slug
        ? body.slug
        : `${slugBase || 'toplanti'}-${randomToken(4)
            .toLowerCase()
            .replace(/[^a-z0-9]/g, 'x')
            .slice(0, 5)}`;
    const m: MockMeeting = {
      id,
      kind: body.mode === 'instant' ? 'chat' : body.mode,
      title,
      description: body.mode === 'scheduled' ? (body.description ?? null) : null,
      spaceId: body.spaceId ?? null,
      conversationId: body.mode !== 'room' ? (body.conversationId ?? null) : null,
      slug,
      hostId: u.id,
      startsAt: body.mode === 'scheduled' ? body.startsAt : null,
      durationMinutes: body.mode === 'scheduled' ? body.durationMinutes : null,
      recurrence: body.mode === 'scheduled' ? body.recurrence : 'none',
      settings: { ...DEFAULT_MEETING_SETTINGS, ...(body.mode !== 'instant' ? body.settings : {}) },
      invitees:
        body.mode === 'scheduled'
          ? [
              ...body.invitees.userIds.map((userId) => ({ id: newId(), userId, email: null })),
              ...body.invitees.emails.map((email) => ({ id: newId(), userId: null, email })),
            ]
          : [],
      cancelledAt: null,
      createdAt: new Date().toISOString(),
    };
    if (m.invitees.some((i) => i.email)) m.settings.guestsAllowed = true;
    ms.meetings.push(m);
    persist();
    return toMeeting(s, ms, m, u);
  },
  getMeeting: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    return toMeeting(s, ms, find(ms, params.meetingId!), u);
  },
  updateMeeting: ({ s, params, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    if (body.invitees) {
      m.invitees = [
        ...body.invitees.userIds.map((userId) => ({
          id: m.invitees.find((i) => i.userId === userId)?.id ?? newId(),
          userId,
          email: null,
        })),
        ...body.invitees.emails.map((email) => ({ id: newId(), userId: null, email })),
      ];
    }
    Object.assign(m, {
      title: body.title ?? m.title,
      description: body.description !== undefined ? body.description : m.description,
      spaceId: body.spaceId !== undefined ? body.spaceId : m.spaceId,
      startsAt: body.startsAt ?? m.startsAt,
      durationMinutes: body.durationMinutes ?? m.durationMinutes,
      recurrence: body.recurrence ?? m.recurrence,
      settings: { ...m.settings, ...body.settings },
    });
    persist();
    return toMeeting(s, ms, m, u);
  },
  cancelMeeting: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    // As the api: a room with people inside is not deleted under them.
    const live = ms.sessions.some(
      (x) => x.meetingId === m.id && !x.endedAt && x.people.some((p) => !p.leftAt),
    );
    if (m.kind === 'room' && live) throw new MockApiError('meet_room_live');
    m.cancelledAt = new Date().toISOString();
    persist();
    return {};
  },
  inviteToMeeting: ({ s, params, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    m.invitees.push(
      ...body.userIds.map((userId) => ({ id: newId(), userId, email: null })),
      ...body.emails.map((email) => ({ id: newId(), userId: null, email })),
    );
    persist();
    return toMeeting(s, ms, m, u);
  },
  rotateMeetingLink: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    m.slug = `${m.slug.replace(/-[a-z0-9]{5}$/, '')}-${randomToken(4)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')
      .slice(0, 5)}`;
    persist();
    return toMeeting(s, ms, m, u);
  },
  getMeetingLink: ({ s, params }) => {
    const ms = state(s);
    const m = ms.meetings.find((x) => x.slug === params.slug);
    if (!m) throw new MockApiError('not_found');
    const session = liveSession(ms, m.id);
    const inside = session?.people.filter((p) => !p.leftAt) ?? [];
    const host = s.users.find((x) => x.id === m.hostId);
    return {
      slug: m.slug,
      meetingId: m.id,
      title: m.title,
      orgName: s.org?.branding.orgName ?? '',
      orgLogoUrl: null,
      hostName: host?.name ?? null,
      startsAt: m.startsAt,
      durationMinutes: m.durationMinutes,
      status: m.cancelledAt ? 'ended' : 'valid',
      guestsAllowed: m.settings.guestsAllowed,
      lobby: m.settings.lobby,
      insideInitials: inside.map((p) => p.name.slice(0, 2).toUpperCase()),
      insideCount: inside.length,
      recording: ms.recordings.some((r) => r.meetingId === m.id && r.status === 'recording'),
    };
  },
  resolveMeetingLink: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = ms.meetings.find((x) => x.slug === params.slug);
    if (!m) throw new MockApiError('not_found');
    return toMeeting(s, ms, m, u);
  },
  joinMeeting: async ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    if (m.cancelledAt) throw new MockApiError('meet_ended');
    const { role } = roleOf(s, m, u);
    const identity = MEET_IDENTITY.user(u.id);
    const session = joinSession(ms, m, { identity, userId: u.id, name: u.name });
    persist();
    return {
      status: 'joined' as const,
      meeting: toMeeting(s, ms, m, u),
      connection: await connection(m, { identity, name: u.name, role, userId: u.id }, session.id),
    };
  },
  requestGuestJoin: async ({ s, params, body }) => {
    const ms = state(s);
    const m = ms.meetings.find((x) => x.slug === params.slug);
    if (!m) throw new MockApiError('not_found');
    if (!m.settings.guestsAllowed) throw new MockApiError('meet_guests_disabled');
    const secret = randomToken(24);
    const r = {
      id: newId(),
      meetingId: m.id,
      name: body.name,
      user: null,
      guest: true,
      status: m.settings.lobby ? ('waiting' as const) : ('admitted' as const),
      requestedAt: new Date().toISOString(),
      decidedAt: null,
      decidedBy: null,
      retryAt: null,
      secret,
    };
    ms.lobby.push(r);
    persist();
    return {
      request: lobbyOut(r),
      secret,
      connection:
        r.status === 'admitted'
          ? await connection(
              m,
              { identity: MEET_IDENTITY.guest(r.id), name: r.name, role: 'guest', userId: null },
              null,
            )
          : null,
    };
  },
  pollGuestRequest: async ({ s, params, body }) => {
    const ms = state(s);
    const r = ms.lobby.find((x) => x.id === params.requestId && x.secret === body.secret);
    if (!r) throw new MockApiError('not_found');
    const m = find(ms, r.meetingId);
    return {
      request: lobbyOut(r),
      meetingTitle: m.title,
      connection:
        r.status === 'admitted'
          ? await connection(
              m,
              { identity: MEET_IDENTITY.guest(r.id), name: r.name, role: 'guest', userId: null },
              null,
            )
          : null,
    };
  },
  listActiveMeetings: () => ({ items: [] }),
  listGuestChat: () => ({ items: guestChatLines }),
  sendGuestChat: ({ body }) => {
    const line = {
      id: body.clientMsgId,
      name: 'Misafir',
      guest: true,
      mine: true,
      text: body.text,
      createdAt: new Date().toISOString(),
    };
    guestChatLines.push(line);
    return line;
  },
  cancelGuestRequest: ({ s, params, body }) => {
    const ms = state(s);
    const r = ms.lobby.find((x) => x.id === params.requestId && x.secret === body.secret);
    if (r && r.status === 'waiting') r.status = 'cancelled';
    persist();
    return {};
  },
  getLobbyRequest: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const r = ms.lobby.find((x) => x.id === params.requestId);
    if (!r) throw new MockApiError('not_found');
    return {
      status: 'lobby' as const,
      meeting: toMeeting(s, ms, find(ms, r.meetingId), u),
      request: lobbyOut(r),
    };
  },
  listMeetingParticipants: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    const session = liveSession(ms, params.meetingId!);
    return {
      items: (session?.people ?? [])
        .filter((p) => !p.leftAt)
        .map((p) => {
          const x = p.userId ? s.users.find((y) => y.id === p.userId) : undefined;
          return {
            identity: p.identity,
            name: p.name,
            user: x ? summary(x) : null,
            guest: !p.userId,
            role: 'member' as const,
            joinedAt: p.joinedAt,
            leftAt: null,
            seconds: Math.round((Date.now() - new Date(p.joinedAt).getTime()) / 1000),
          };
        }),
      lobby: ms.lobby
        .filter((r) => r.meetingId === params.meetingId && r.status === 'waiting')
        .map(lobbyOut),
    };
  },
  listMeetingLobby: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    return {
      items: ms.lobby
        .filter((r) => r.meetingId === params.meetingId && r.status === 'waiting')
        .map(lobbyOut),
    };
  },
  decideMeetingLobby: ({ s, params, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const changed = ms.lobby.filter(
      (r) =>
        r.meetingId === params.meetingId &&
        body.requestIds.includes(r.id) &&
        r.status === 'waiting',
    );
    for (const r of changed) {
      r.status = body.admit ? 'admitted' : 'denied';
      r.decidedAt = new Date().toISOString();
      r.decidedBy = summary(u);
    }
    persist();
    return { items: changed.map(lobbyOut) };
  },
  moderateMeetingParticipant: ({ s }) => {
    requireUser(s);
    return {};
  },
  muteAllInMeeting: ({ s }) => {
    requireUser(s);
    return {};
  },
  endMeetingForAll: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    const session = liveSession(ms, params.meetingId!);
    if (session) {
      session.endedAt = new Date().toISOString();
      for (const p of session.people) p.leftAt ??= session.endedAt;
    }
    persist();
    return {};
  },
  getRecordingTarget: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    const space =
      s.spaces.find((x) => x.id === m.spaceId) ?? s.spaces.find((x) => x.ownerUserId === u.id);
    return {
      spaceId: space?.id ?? newId(),
      spaceName: space?.name ?? u.name,
      folderName: 'Toplantı kayıtları',
      freeBytes: null,
      canStart: true,
      retentionDays: 180,
    };
  },
  startMeetingRecording: ({ s, params, body }) => {
    const u = requireUser(s);
    const ms = state(s);
    const m = find(ms, params.meetingId!);
    const session = liveSession(ms, m.id);
    if (!session) throw new MockApiError('meet_not_live');
    const r: MeetingRecording = {
      id: newId(),
      meetingId: m.id,
      sessionId: session.id,
      status: 'recording',
      audioOnly: body.audioOnly,
      startedBy: summary(u),
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationSeconds: null,
      sizeBytes: null,
      nodeId: null,
      spaceId: m.spaceId,
      fileName: null,
      expiresAt: null,
      error: null,
    };
    ms.recordings.push(r);
    persist();
    return r;
  },
  stopMeetingRecording: ({ s, params }) => {
    requireUser(s);
    const ms = state(s);
    const r = ms.recordings.find((x) => x.id === params.recordingId);
    if (!r) throw new MockApiError('not_found');
    r.status = 'ready';
    r.endedAt = new Date().toISOString();
    r.durationSeconds = Math.round((Date.now() - new Date(r.startedAt).getTime()) / 1000);
    r.sizeBytes = r.durationSeconds * 150_000;
    r.fileName = 'Toplantı kaydı.mp4';
    persist();
    return r;
  },
  listMeetingRecordings: ({ s, params }) => {
    requireUser(s);
    return { items: state(s).recordings.filter((r) => r.meetingId === params.meetingId) };
  },
  getMeetingSession: ({ s, params }) => {
    const u = requireUser(s);
    const ms = state(s);
    const session = ms.sessions.find((x) => x.id === params.sessionId);
    if (!session) throw new MockApiError('not_found');
    const sum = summaryOf(s, ms, session);
    const people = session.people.map((p) => {
      const x = p.userId ? s.users.find((y) => y.id === p.userId) : undefined;
      const seconds = Math.round(
        ((p.leftAt ? new Date(p.leftAt).getTime() : Date.now()) - new Date(p.joinedAt).getTime()) /
          1000,
      );
      return {
        identity: p.identity,
        name: p.name,
        user: x ? summary(x) : null,
        guest: !p.userId,
        role: 'member' as const,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
        seconds,
      };
    });
    return {
      ...sum,
      meeting: toMeeting(s, ms, find(ms, session.meetingId), u),
      peakParticipants: people.length,
      people,
      mySeconds: people.find((p) => p.user?.id === u.id)?.seconds ?? 0,
    };
  },
  getMeetSpaceSettings: ({ s, params }) => {
    requireUser(s);
    return spaceSettings(state(s), params.spaceId!);
  },
  updateMeetSpaceSettings: ({ s, params, body }) => {
    requireUser(s);
    const ms = state(s);
    ms.spaceSettings[params.spaceId!] = { ...spaceSettings(ms, params.spaceId!), ...body };
    persist();
    return spaceSettings(ms, params.spaceId!);
  },
};

/** Tests: forget the meet mock state. */
export function resetMeetMock() {
  cache = null;
  void db;
}
