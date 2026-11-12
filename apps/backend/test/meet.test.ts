import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auditLogs,
  meetingCalls,
  meetingParticipants,
  meetingSessions,
  meetSpaceSettings,
  meetings,
  nodes,
  notifications,
  organizations,
  recordings,
} from '@crewhall/db';
import { ApiError } from '@crewhall/api-client';
import {
  MEET_IDENTITY,
  MEET_RAW_PATHS,
  type MeetSignal,
  type WsServerEvent,
} from '@crewhall/shared';
import {
  liveKitSigning,
  setLiveKit,
  type LiveKitGateway,
  type LiveParticipant,
} from '../src/services/meet/livekit';
import { invalidateModules } from '../src/services/identity/modules';
import { resetGuestChat } from '../src/services/meet/guest-chat';
import { endCallsOfMeeting, timeoutCall } from '../src/services/meet/calls';
import { emptyRoomCheck, hangupCheck, reconcileRooms } from '../src/services/meet/webhook';
import { expireRecordings } from '../src/services/meet/recordings';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

const KEY = 'test-key';
const SECRET = 'test-secret-0123456789abcdef0123456789';

/** Records what the api asks LiveKit to do; tokens and webhook checks are the real SDK. */
function fakeLiveKit() {
  const calls: { op: string; args: unknown[] }[] = [];
  const signals: { room: string; signal: MeetSignal; to?: string[] }[] = [];
  const participants = new Map<string, LiveParticipant[]>();
  let egress = 0;
  const gw: LiveKitGateway = {
    publicUrl: 'ws://livekit.test',
    egressEnabled: true,
    ...liveKitSigning({ apiKey: KEY, apiSecret: SECRET }),
    async ensureRoom(...args) {
      calls.push({ op: 'ensureRoom', args });
    },
    async updateRoomMetadata(...args) {
      calls.push({ op: 'updateRoomMetadata', args });
    },
    async deleteRoom(...args) {
      calls.push({ op: 'deleteRoom', args });
    },
    async sendSignal(room, signal, to) {
      signals.push({ room, signal, to });
    },
    async listParticipants(room) {
      return participants.get(room) ?? [];
    },
    async listRooms() {
      return [...participants].map(([name, list]) => ({
        name,
        sid: `RM_${name}`,
        numParticipants: list.length,
      }));
    },
    async muteTrack(...args) {
      calls.push({ op: 'muteTrack', args });
    },
    async updateParticipant(...args) {
      calls.push({ op: 'updateParticipant', args });
    },
    async removeParticipant(...args) {
      calls.push({ op: 'removeParticipant', args });
    },
    async startRecording(...args) {
      calls.push({ op: 'startRecording', args });
      return { egressId: `EG_${++egress}` };
    },
    async stopRecording(...args) {
      calls.push({ op: 'stopRecording', args });
    },
  };
  return { gw, calls, signals, participants };
}

async function verify(token: string) {
  return new TokenVerifier(KEY, SECRET).verify(token);
}

/** A webhook signed like LiveKit does: JWT with the body's sha256 (base64). */
async function webhook(app: TestApp, body: Record<string, unknown>, secret = SECRET) {
  const raw = JSON.stringify(body);
  const at = new AccessToken(KEY, secret);
  at.sha256 = createHash('sha256').update(raw).digest('base64');
  const res = await app.app.request(`http://localhost:3000${MEET_RAW_PATHS.livekitWebhook}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: await at.toJwt() },
    body: raw,
  });
  return res;
}

let seq = 0;
const now = () => String(Math.floor(Date.now() / 1000));
const joinedEvent = (roomName: string, identity: string, name: string, role: string) => ({
  event: 'participant_joined',
  id: `EV_${++seq}`,
  createdAt: now(),
  room: { sid: `RM_${roomName}`, name: roomName },
  participant: {
    sid: `PA_${identity}_${seq}`,
    identity,
    name,
    metadata: JSON.stringify({ userId: null, role, guest: role === 'guest', imageUrl: null }),
    joinedAt: now(),
  },
});

async function expectCode(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe(code);
}

describe('Meet', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let editor: Client;
  let editorId: string;
  let viewer: Client;
  let outsider: Client;
  let outsiderId: string;
  let infraId: string;
  let lk: ReturnType<typeof fakeLiveKit>;

  beforeAll(async () => {
    app = await createTestApp();
    lk = fakeLiveKit();
    setLiveKit(app.deps, lk.gw);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    infraId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
    const e = await join(app, owner, 'mert@milvasoft.com', 'member', [infraId]);
    editor = e.person;
    editorId = e.me.user.id;
    const v = await join(app, owner, 'selin@milvasoft.com', 'member', [infraId]);
    viewer = v.person;
    await owner.api.call('updateSpaceMember', {
      params: { spaceId: infraId, userId: v.me.user.id },
      body: { role: 'viewer' },
    });
    await owner.api.call('updateSpaceMember', {
      params: { spaceId: infraId, userId: editorId },
      body: { role: 'editor' },
    });
    const o = await join(app, owner, 'can@milvasoft.com', 'member');
    outsider = o.person;
    outsiderId = o.me.user.id;
  });
  afterAll(() => app.close());

  it('issues LiveKit tokens with the room and rights of the meeting role', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Altyapı sohbeti', spaceId: infraId },
    });
    expect(m).toMatchObject({ kind: 'chat', spaceId: infraId, myRole: 'moderator' });
    expect(m.url).toMatch(/\/m\/altyapi-sohbeti-[a-z0-9]{5}$/);

    const host = await owner.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    if (host.status !== 'joined') throw new Error('host should join');
    const hc = await verify(host.connection.token);
    expect(hc.sub).toBe(MEET_IDENTITY.user(ownerId));
    expect(hc.video).toMatchObject({
      room: `m-${m.id}`,
      roomJoin: true,
      roomAdmin: true,
      canPublish: true,
    });
    expect(hc.video?.canPublishSources).toEqual(
      expect.arrayContaining(['camera', 'microphone', 'screen_share']),
    );
    expect(JSON.parse(hc.metadata!)).toMatchObject({ role: 'moderator', guest: false });
    expect(host.connection.url).toBe('ws://livekit.test');
    expect(lk.calls.some((c) => c.op === 'ensureRoom' && c.args[0] === `m-${m.id}`)).toBe(true);

    const ed = await editor.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    if (ed.status !== 'joined') throw new Error('editor should join');
    const ec = await verify(ed.connection.token);
    expect(ec.video).toMatchObject({ roomAdmin: false, canPublish: true });
    expect(ed.connection.role).toBe('member');

    // Doc 17 §5: viewers join and listen.
    const vw = await viewer.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    if (vw.status !== 'joined') throw new Error('viewer should join');
    const vc = await verify(vw.connection.token);
    expect(vw.connection.role).toBe('listener');
    expect(vc.video).toMatchObject({ canPublish: false, canSubscribe: true, canPublishData: true });

    // One room per conversation is reused; instant meetings with the same conversation id.
    const conv = '0192f3a4-1b2c-7d3e-8f40-123456789abc';
    const a1 = await owner.api.call('createMeeting', {
      body: { mode: 'instant', conversationId: conv },
    });
    const a2 = await owner.api.call('createMeeting', {
      body: { mode: 'instant', conversationId: conv },
    });
    expect(a2.id).toBe(a1.id);
  });

  it('answers 503 meet_unavailable when LiveKit is not configured', async () => {
    const m = await owner.api.call('createMeeting', { body: { mode: 'instant', title: 'X' } });
    setLiveKit(app.deps, null);
    await expectCode(
      owner.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} }),
      'meet_unavailable',
    );
    setLiveKit(app.deps, lk.gw);
  });

  it('renames a persistent room (same link) and deletes it softly, not while it is live', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Tasarım odası', spaceId: infraId },
    });
    expect(m.permissions.moderate).toBe(true);
    // Members who are not moderators see no actions and the server says no.
    const asEditor = await editor.api.call('getMeeting', { params: { meetingId: m.id } });
    expect(asEditor.permissions.moderate).toBe(false);
    await expectCode(
      editor.api.call('updateMeeting', { params: { meetingId: m.id }, body: { title: 'X' } }),
      'meet_not_moderator',
    );
    await expectCode(
      editor.api.call('cancelMeeting', { params: { meetingId: m.id } }),
      'meet_not_moderator',
    );

    const renamed = await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { title: 'Ürün odası' },
    });
    expect(renamed).toMatchObject({ title: 'Ürün odası', slug: m.slug, url: m.url });
    const link = await new Client(app).api.call('getMeetingLink', { params: { slug: m.slug } });
    expect(link).toMatchObject({ title: 'Ürün odası', status: 'valid' });

    // People inside: deleting waits until the meeting ends.
    const room = `m-${m.id}`;
    const joined = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    await webhook(app, joined);
    await expectCode(
      owner.api.call('cancelMeeting', { params: { meetingId: m.id } }),
      'meet_room_live',
    );
    await webhook(app, {
      event: 'room_finished',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });

    await owner.api.call('cancelMeeting', { params: { meetingId: m.id } });
    expect(
      (await new Client(app).api.call('getMeetingLink', { params: { slug: m.slug } })).status,
    ).toBe('ended');
    const home = await owner.api.call('getMeetHome', { query: { tz: 'Europe/Istanbul' } });
    expect(home.rooms.some((r) => r.id === m.id)).toBe(false);
    // Its history stays.
    const history = await owner.api.call('listMeetingHistory', { query: { meetingId: m.id } });
    expect(history.items).toHaveLength(1);
  });

  it('edits a scheduled meeting, tells its people, cancels it; calendar ones go via their event', async () => {
    const m = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Planlama',
        spaceId: infraId,
        startsAt: '2026-12-01T09:00:00.000Z',
        durationMinutes: 30,
        invitees: { userIds: [editorId], emails: [] },
      },
    });
    await expectCode(
      editor.api.call('updateMeeting', { params: { meetingId: m.id }, body: { title: 'X' } }),
      'meet_not_moderator',
    );
    const moved = await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: {
        startsAt: '2026-12-01T10:00:00.000Z',
        description: 'Gündem',
        spaceId: null,
        invitees: { userIds: [editorId, outsiderId], emails: [] },
      },
    });
    expect(moved).toMatchObject({
      startsAt: '2026-12-01T10:00:00.000Z',
      description: 'Gündem',
      spaceId: null,
    });
    expect(moved.invitees.map((i) => i.user?.id).sort()).toEqual([editorId, outsiderId].sort());
    const bell = async (who: Client) =>
      (await who.api.call('listNotifications', { query: {} })).items
        .filter((n) => n.target.id === m.id)
        .map((n) => n.type);
    // Moved: those already invited hear it; the new one is invited.
    expect(await bell(editor)).toContain('meet.updated');
    expect(await bell(outsider)).toEqual(['meet.invited']);

    // Not while it runs.
    const room = `m-${m.id}`;
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    await expectCode(
      owner.api.call('cancelMeeting', { params: { meetingId: m.id } }),
      'meet_room_live',
    );
    await webhook(app, {
      event: 'room_finished',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });
    await owner.api.call('cancelMeeting', { params: { meetingId: m.id } });
    expect(await bell(editor)).toContain('meet.cancelled');
    expect(await bell(outsider)).toContain('meet.cancelled');

    // A meeting created from the calendar changes through its event.
    const calendars = await owner.api.call('listCalendars');
    const personal = calendars.items.find((c) => c.kind === 'personal')!;
    const ev = await owner.api.call('createCalendarEvent', {
      body: {
        calendarId: personal.id,
        title: 'Takvimden',
        start: '2026-12-02T10:00:00.000Z',
        end: '2026-12-02T10:30:00.000Z',
        onlineMeeting: true,
      },
    });
    const linked = await owner.api.call('getMeeting', { params: { meetingId: ev.meeting!.id } });
    expect(linked.calendarEventId).toBeTruthy();
    await expectCode(
      owner.api.call('updateMeeting', { params: { meetingId: linked.id }, body: { title: 'Y' } }),
      'meet_managed_by_calendar',
    );
    await expectCode(
      owner.api.call('cancelMeeting', { params: { meetingId: linked.id } }),
      'meet_managed_by_calendar',
    );
  });

  it('sends people without access to the lobby until a moderator lets them in', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Altyapı haftalık', spaceId: infraId },
    });
    expect(m.slug).toBe('altyapi-haftalik');
    await expectCode(outsider.api.call('getMeeting', { params: { meetingId: m.id } }), 'not_found');

    const knock = await outsider.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    if (knock.status !== 'lobby') throw new Error('outsider should wait');
    expect(knock.request).toMatchObject({ status: 'waiting', guest: false });
    expect(lk.signals.at(-1)).toMatchObject({
      room: `m-${m.id}`,
      signal: { type: 'lobby', waiting: 1 },
    });

    // Not a moderator: editors cannot see or decide the lobby.
    await expectCode(
      editor.api.call('listMeetingLobby', { params: { meetingId: m.id } }),
      'meet_not_moderator',
    );
    const lobby = await owner.api.call('listMeetingLobby', { params: { meetingId: m.id } });
    expect(lobby.items.map((r) => r.user?.id)).toEqual([outsiderId]);

    const still = await outsider.api.call('getLobbyRequest', {
      params: { requestId: knock.request.id },
    });
    expect(still.status).toBe('lobby');
    await owner.api.call('decideMeetingLobby', {
      params: { meetingId: m.id },
      body: { requestIds: [knock.request.id], admit: true },
    });
    const inside = await outsider.api.call('getLobbyRequest', {
      params: { requestId: knock.request.id },
    });
    if (inside.status !== 'joined') throw new Error('admitted member should connect');
    expect((await verify(inside.connection.token)).sub).toBe(MEET_IDENTITY.user(outsiderId));
  });

  it('lets guests knock with a name, wait, and join with a guest-only token', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Hızlı', spaceId: infraId },
    });
    const anon = new Client(app);
    await expectCode(
      anon.api.call('requestGuestJoin', { params: { slug: m.slug }, body: { name: 'Deniz Kaya' } }),
      'meet_guests_disabled',
    );

    const starts = new Date(Date.now() + 30 * 60_000).toISOString();
    const demo = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Opsiyon · ürün demosu',
        spaceId: infraId,
        startsAt: starts,
        durationMinutes: 45,
        invitees: { userIds: [editorId], emails: ['deniz.kaya@opsiyon.com.tr'] },
      },
    });
    expect(demo.settings).toMatchObject({ guestsAllowed: true, lobby: true });
    expect(demo.invitees.map((i) => i.guest).sort()).toEqual([false, true]);

    const preview = await anon.api.call('getMeetingLink', { params: { slug: demo.slug } });
    expect(preview).toMatchObject({
      title: 'Opsiyon · ürün demosu',
      status: 'valid',
      orgName: 'Milvasoft',
      guestsAllowed: true,
    });
    expect(JSON.stringify(preview)).not.toContain('@');

    const ticket = await anon.api.call('requestGuestJoin', {
      params: { slug: demo.slug },
      body: { name: 'Deniz Kaya' },
    });
    expect(ticket.request.status).toBe('waiting');
    expect(ticket.connection).toBeNull();
    const poll = () =>
      anon.api.call('pollGuestRequest', {
        params: { requestId: ticket.request.id },
        body: { secret: ticket.secret },
      });
    expect((await poll()).connection).toBeNull();
    // A wrong secret looks like an unknown request.
    await expectCode(
      anon.api.call('pollGuestRequest', {
        params: { requestId: ticket.request.id },
        body: { secret: 'x'.repeat(32) },
      }),
      'not_found',
    );

    await owner.api.call('decideMeetingLobby', {
      params: { meetingId: demo.id },
      body: { requestIds: [ticket.request.id], admit: true },
    });
    const admitted = await poll();
    expect(admitted.request.status).toBe('admitted');
    const claims = await verify(admitted.connection!.token);
    expect(claims.sub).toBe(MEET_IDENTITY.guest(ticket.request.id));
    expect(claims.name).toBe('Deniz Kaya');
    expect(claims.video).toMatchObject({
      room: `m-${demo.id}`,
      roomAdmin: false,
      canPublish: true,
    });
    expect(claims.video?.canPublishSources).not.toContain('screen_share');
    expect(JSON.parse(claims.metadata!)).toMatchObject({
      role: 'guest',
      guest: true,
      userId: null,
    });

    // Turned away: the same browser may ask again only after a minute (design 7.14).
    const second = await anon.api.call('requestGuestJoin', {
      params: { slug: demo.slug },
      body: { name: 'Deniz 2' },
    });
    await owner.api.call('decideMeetingLobby', {
      params: { meetingId: demo.id },
      body: { requestIds: [second.request.id], admit: false },
    });
    await expectCode(
      anon.api.call('requestGuestJoin', { params: { slug: demo.slug }, body: { name: 'Deniz 3' } }),
      'meet_lobby_retry_later',
    );

    // The space can switch guests off altogether.
    await owner.api.call('updateMeetSpaceSettings', {
      params: { spaceId: infraId },
      body: { guestsAllowed: false },
    });
    await expectCode(
      new Client(app).api.call('requestGuestJoin', {
        params: { slug: demo.slug },
        body: { name: 'Biri' },
      }),
      'meet_guests_disabled',
    );
    await owner.api.call('updateMeetSpaceSettings', {
      params: { spaceId: infraId },
      body: { guestsAllowed: true },
    });
  });

  it('follows LiveKit without its webhooks: sessions open, people come and go, history fills', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Webhooksuz' },
    });
    const room = `m-${m.id}`;
    const person = (id: string, name: string) =>
      ({
        identity: MEET_IDENTITY.user(id),
        sid: `PA_${id}`,
        name,
        metadata: JSON.stringify({ userId: id, role: 'member', guest: false, imageUrl: null }),
        tracks: [],
      }) as LiveParticipant;
    const history = async () =>
      (await owner.api.call('listMeetingHistory', { query: { meetingId: m.id, limit: 10 } })).items;

    lk.participants.set(room, [person(ownerId, 'Buğra'), person(editorId, 'Mert')]);
    await reconcileRooms(app.deps);
    const live = await owner.api.call('getMeeting', { params: { meetingId: m.id } });
    expect(live.live?.participantCount).toBe(2);
    // Running it again changes nothing.
    await reconcileRooms(app.deps);
    expect(
      await app.deps.db
        .select()
        .from(meetingParticipants)
        .where(eq(meetingParticipants.meetingId, m.id)),
    ).toHaveLength(2);

    // Mert left: he is out a while later (a just-joined person is given time).
    lk.participants.set(room, [person(ownerId, 'Buğra')]);
    await reconcileRooms(app.deps, new Date(Date.now() + 90_000));
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live?.participantCount,
    ).toBe(1);
    expect(await history()).toEqual([]);

    // Everybody left and the room is gone: the meeting is in the history.
    lk.participants.delete(room);
    await reconcileRooms(app.deps, new Date(Date.now() + 180_000));
    const past = await history();
    expect(past).toHaveLength(1);
    expect((await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live).toBeNull();
  });

  it('leaves rooms of other projects on a shared LiveKit alone', async () => {
    lk.participants.set('baska-proje-odasi', [
      { identity: 'someone', name: 'x', metadata: '', tracks: [] },
    ]);
    await reconcileRooms(app.deps);
    lk.participants.delete('baska-proje-odasi');
  });

  const finished = (room: string) =>
    webhook(app, {
      event: 'room_finished',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });

  it('knows the meetings someone is in, on several devices, and moves them on request', async () => {
    const m = await owner.api.call('createMeeting', { body: { mode: 'room', title: 'İki cihaz' } });
    const room = `m-${m.id}`;
    const plain = MEET_IDENTITY.user(ownerId);
    const meta = JSON.stringify({
      userId: ownerId,
      role: 'moderator',
      guest: false,
      imageUrl: null,
    });
    const join1 = await owner.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    if (join1.status !== 'joined') throw new Error('not joined');
    expect((await verify(join1.connection.token)).sub).toBe(plain);
    expect(
      (await owner.api.call('listActiveMeetings')).items.map((x) => x.meetingId),
    ).not.toContain(m.id);

    const events: WsServerEvent[] = [];
    const off = app.deps.bus.subscribe(`user:${ownerId}`, (e) => events.push(e as WsServerEvent));
    await webhook(app, joinedEvent(room, plain, 'Buğra', 'moderator'));
    off();
    expect(events.some((e) => e.type === 'meet.active')).toBe(true);
    const active = (await owner.api.call('listActiveMeetings')).items.find(
      (x) => x.meetingId === m.id,
    );
    expect(active).toMatchObject({ slug: m.slug, title: 'İki cihaz', devices: 1 });

    // "Bu cihazı da ekle": a connection of its own, the first one stays.
    lk.participants.set(room, [{ identity: plain, name: 'Buğra', metadata: meta, tracks: [] }]);
    const added = await owner.api.call('joinMeeting', {
      params: { meetingId: m.id },
      body: { device: 'add' },
    });
    if (added.status !== 'joined') throw new Error('not joined');
    const second = (await verify(added.connection.token)).sub!;
    expect(second).not.toBe(plain);
    expect(MEET_IDENTITY.parse(second)).toEqual({ kind: 'user', id: ownerId });
    expect(lk.signals.some((s) => s.room === room && s.signal.type === 'transferred')).toBe(false);
    await webhook(app, joinedEvent(room, second, 'Buğra', 'moderator'));
    const both = await owner.api.call('listActiveMeetings');
    expect(both.items.find((x) => x.meetingId === m.id)?.devices).toBe(2);
    // Still one person in the room.
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live?.participantCount,
    ).toBe(1);

    // "Bu cihaza aktar": all of their connections are told, and this one takes the plain identity.
    lk.participants.set(room, [
      { identity: plain, name: 'Buğra', metadata: meta, tracks: [] },
      { identity: second, name: 'Buğra', metadata: meta, tracks: [] },
    ]);
    const moved = await owner.api.call('joinMeeting', {
      params: { meetingId: m.id },
      body: { device: 'transfer' },
    });
    if (moved.status !== 'joined') throw new Error('not joined');
    expect((await verify(moved.connection.token)).sub).toBe(plain);
    const told = lk.signals.find((s) => s.room === room && s.signal.type === 'transferred')!;
    expect(told.to?.sort()).toEqual([plain, second].sort());
    lk.participants.delete(room);
    await finished(room);
  });

  it('a person removed is out on every device, and cannot come back on another', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Çıkarma', spaceId: infraId },
    });
    const room = `m-${m.id}`;
    const first = MEET_IDENTITY.user(editorId);
    const second = MEET_IDENTITY.user(editorId, 'abc123');
    await webhook(app, joinedEvent(room, first, 'Mert', 'member'));
    lk.participants.set(room, [
      { identity: first, name: 'Mert', metadata: '{}', tracks: [] },
      { identity: second, name: 'Mert', metadata: '{}', tracks: [] },
    ]);
    lk.calls.length = 0;
    await owner.api.call('moderateMeetingParticipant', {
      params: { meetingId: m.id },
      body: { identity: second, action: 'remove' },
    });
    expect(
      lk.calls
        .filter((c) => c.op === 'removeParticipant')
        .map((c) => c.args[1])
        .sort(),
    ).toEqual([first, second].sort());
    const again = await editor.api.call('joinMeeting', {
      params: { meetingId: m.id },
      body: { device: 'add' },
    });
    expect(again.status).toBe('lobby');
    lk.participants.delete(room);
    await finished(room);
  });

  it('puts guests and members in one chat, and a guest sees only this visit of it', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Tek sohbet', spaceId: infraId },
    });
    await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { settings: { lobby: false, guestsAllowed: true } },
    });
    const conversationId = m.chatConversationId!;
    const say = (text: string) =>
      owner.api.call('sendMessage', {
        params: { conversationId },
        body: { text, clientMsgId: randomUUID(), attachmentNodeIds: [] },
      });
    await say('misafir gelmeden önce');
    await new Promise((r) => setTimeout(r, 20));

    const anon = new Client(app);
    const ticket = await anon.api.call('requestGuestJoin', {
      params: { slug: m.slug },
      body: { name: 'Deniz Kaya' },
    });
    const secret = ticket.secret;
    const params = { requestId: ticket.request.id };
    const identity = MEET_IDENTITY.guest(ticket.request.id);
    const list = () => anon.api.call('listGuestChat', { params, body: { secret } });
    const send = (text: string, clientMsgId: string = randomUUID()) =>
      anon.api.call('sendGuestChat', { params, body: { secret, text, clientMsgId } });

    await expectCode(
      anon.api.call('listGuestChat', { params, body: { secret: 'x'.repeat(32) } }),
      'not_found',
    );
    // Not in the room (yet, or any more): nothing.
    resetGuestChat();
    await expectCode(list(), 'forbidden');

    resetGuestChat();
    lk.participants.set(`m-${m.id}`, [
      { identity, name: 'Deniz Kaya', metadata: '{}', tracks: [] } as never,
    ]);
    expect((await list()).items).toEqual([]);

    const clientMsgId = randomUUID();
    const sent = await send('merhaba <@' + editorId + '>', clientMsgId);
    expect(sent).toMatchObject({ name: 'Deniz Kaya', guest: true, mine: true });
    // A guest cannot mention anyone.
    expect(sent.text).not.toContain('<@');
    // A retry is the same message.
    expect((await send('merhaba <@' + editorId + '>', clientMsgId)).id).toBe(sent.id);

    // Members read it in the chat module, marked as a guest's.
    const seen = await owner.api.call('listMessages', {
      params: { conversationId },
      query: { limit: 50 },
    });
    const line = seen.items.find((x) => x.id === sent.id)!;
    expect(line.author).toBeNull();
    expect(line.guestAuthor).toEqual({ name: 'Deniz Kaya' });

    // The guest reads the members' answers: name and text, no ids or e-mails.
    await say('hoş geldin <@' + ownerId + '>');
    const page = await list();
    expect(page.items.map((x) => x.mine)).toEqual([true, false]);
    expect(page.items[1]!.text).not.toContain('<@');
    expect(page.items[1]!.guest).toBe(false);
    expect(JSON.stringify(page)).not.toContain(ownerId);
    expect(JSON.stringify(page)).not.toContain('@milvasoft');
    expect(JSON.stringify(page)).not.toContain('misafir gelmeden önce');

    // A reply to a guest quotes them by name, and a reply to a member stays without one.
    const reply = await owner.api.call('sendMessage', {
      params: { conversationId },
      body: {
        text: 'sana cevap',
        replyToId: sent.id,
        clientMsgId: randomUUID(),
        attachmentNodeIds: [],
      },
    });
    expect(reply.replyTo).toMatchObject({ author: null, guestAuthor: { name: 'Deniz Kaya' } });
    const replyToMember = await owner.api.call('sendMessage', {
      params: { conversationId },
      body: {
        text: 'kendime cevap',
        replyToId: reply.id,
        clientMsgId: randomUUID(),
        attachmentNodeIds: [],
      },
    });
    expect(replyToMember.replyTo?.guestAuthor).toBeUndefined();

    // Left the room: the secret they still hold opens nothing.
    lk.participants.set(`m-${m.id}`, []);
    resetGuestChat();
    await expectCode(list(), 'forbidden');
    await expectCode(send('hâlâ burada mıyım'), 'forbidden');
  });

  it("never opens a chat that is not the meeting's own to a guest", async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Sohbetsiz', spaceId: infraId },
    });
    await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { settings: { lobby: false, guestsAllowed: true } },
    });
    const dm = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: editorId },
    });
    await app.deps.db
      .update(meetings)
      .set({ chatConversationId: dm.id })
      .where(eq(meetings.id, m.id));
    const anon = new Client(app);
    const ticket = await anon.api.call('requestGuestJoin', {
      params: { slug: m.slug },
      body: { name: 'Deniz' },
    });
    resetGuestChat();
    lk.participants.set(`m-${m.id}`, [
      {
        identity: MEET_IDENTITY.guest(ticket.request.id),
        name: 'Deniz',
        metadata: '{}',
        tracks: [],
      } as never,
    ]);
    await expectCode(
      anon.api.call('listGuestChat', {
        params: { requestId: ticket.request.id },
        body: { secret: ticket.secret },
      }),
      'not_found',
    );
  });

  it('mails an .ics invitation, an update with a higher SEQUENCE and a cancel', async () => {
    app.mailer.outbox.length = 0;
    const starts = new Date(Date.now() + 2 * 86_400_000);
    const m = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Portal geçiş planı',
        spaceId: infraId,
        startsAt: starts.toISOString(),
        durationMinutes: 45,
        recurrence: 'weekdays',
        invitees: { userIds: [editorId], emails: ['misafir@ornek.com'] },
      },
    });
    const guestMail = app.mailer.outbox.find((x) => x.to === 'misafir@ornek.com')!;
    expect(guestMail.subject).toContain('Portal geçiş planı');
    expect(guestMail.text).toContain(m.url);
    expect(guestMail.icalEvent?.method).toBe('REQUEST');
    const ics = guestMail.icalEvent!.content.replace(/\r\n /g, '');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain(`UID:${m.id}@localhost:5173`);
    expect(ics).toContain('SEQUENCE:0');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
    expect(ics).toContain(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:misafir@ornek.com',
    );
    expect(app.mailer.outbox.some((x) => x.to === 'mert@milvasoft.com')).toBe(true);

    app.mailer.outbox.length = 0;
    await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { startsAt: new Date(starts.getTime() + 3_600_000).toISOString() },
    });
    const update = app.mailer.outbox.find((x) => x.to === 'misafir@ornek.com')!;
    expect(update.icalEvent!.content).toContain('SEQUENCE:1');

    app.mailer.outbox.length = 0;
    await owner.api.call('cancelMeeting', { params: { meetingId: m.id } });
    const cancel = app.mailer.outbox.find((x) => x.to === 'misafir@ornek.com')!;
    expect(cancel.icalEvent).toMatchObject({ method: 'CANCEL' });
    expect(cancel.icalEvent!.content).toContain('STATUS:CANCELLED');
    expect(
      (await new Client(app).api.call('getMeetingLink', { params: { slug: m.slug } })).status,
    ).toBe('ended');
  });

  it('accepts only signed webhooks and tracks who is in, then closes the session', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Daily', spaceId: infraId },
    });
    const room = `m-${m.id}`;
    const bad = await webhook(
      app,
      joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'),
      'wrong-secret-0123456789abcdef0123',
    );
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('meet_webhook_invalid');
    const unsigned = await app.app.request(
      `http://localhost:3000${MEET_RAW_PATHS.livekitWebhook}`,
      {
        method: 'POST',
        body: JSON.stringify({ event: 'room_started' }),
      },
    );
    expect(unsigned.status).toBe(401);

    const ownerJoin = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    expect((await webhook(app, ownerJoin)).status).toBe(200);
    // LiveKit retries: the same delivery twice counts once.
    expect((await webhook(app, ownerJoin)).status).toBe(200);
    const edJoin = joinedEvent(room, MEET_IDENTITY.user(editorId), 'Mert', 'member');
    await webhook(app, edJoin);
    await webhook(app, joinedEvent(room, 'EG_recorder', 'egress', 'member'));

    // Presence: busy · in a meeting while in the room, even without an open app.
    expect(app.deps.presence.get(editorId)).toMatchObject({ state: 'busy', auto: 'meeting' });
    const live = await owner.api.call('listMeetingParticipants', { params: { meetingId: m.id } });
    expect(live.items.map((p) => p.identity).sort()).toEqual(
      [MEET_IDENTITY.user(ownerId), MEET_IDENTITY.user(editorId)].sort(),
    );
    const home = await editor.api.call('getMeetHome', { query: { tz: 'Europe/Istanbul' } });
    const card = home.live.find((x) => x.id === m.id)!;
    expect(card.live).toMatchObject({ participantCount: 2 });

    await webhook(app, { ...edJoin, event: 'participant_left', id: `EV_${++seq}` });
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live?.participantCount,
    ).toBe(1);
    expect(app.deps.presence.get(editorId)).toBeNull();
    expect(app.deps.presence.get(ownerId)?.auto).toBe('meeting');
    // Sharing the screen shows "Sunuyor" until the track goes; cameras change nothing, and the
    // room closing below ends a share still up.
    const track = (event: string, sid: string, source: string) => ({
      event,
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
      participant: ownerJoin.participant,
      track: { sid, source, type: 'VIDEO' },
    });
    await webhook(app, track('track_published', 'TR_cam', 'CAMERA'));
    expect(app.deps.presence.get(ownerId)?.auto).toBe('meeting');
    await webhook(app, track('track_published', 'TR_screen', 'SCREEN_SHARE'));
    expect(app.deps.presence.get(ownerId)).toMatchObject({ state: 'dnd', auto: 'screen_share' });
    await webhook(app, track('track_unpublished', 'TR_screen', 'SCREEN_SHARE'));
    expect(app.deps.presence.get(ownerId)).toMatchObject({ state: 'busy', auto: 'meeting' });
    await webhook(app, track('track_published', 'TR_screen2', 'SCREEN_SHARE'));
    expect(app.deps.presence.get(ownerId)?.auto).toBe('screen_share');

    await webhook(app, {
      event: 'room_finished',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });
    expect((await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live).toBeNull();
    expect(app.deps.presence.get(ownerId)).toBeNull();
    const history = await owner.api.call('listMeetingHistory', { query: { meetingId: m.id } });
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ title: 'Daily', participantCount: 2 });
    const detail = await editor.api.call('getMeetingSession', {
      params: { sessionId: history.items[0]!.id },
    });
    expect(detail.people.map((p) => p.user?.id).sort()).toEqual([ownerId, editorId].sort());
    expect(detail.peakParticipants).toBe(2);
  });

  describe('going back in from the history', () => {
    /** One finished session of a meeting; returns its id as the history lists it. */
    async function finishSession(meetingId: string) {
      const room = `m-${meetingId}`;
      await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
      await webhook(app, {
        event: 'room_finished',
        id: `EV_${++seq}`,
        createdAt: now(),
        room: { sid: `RM_${room}`, name: room },
      });
    }
    const historyOf = async (who: Client, meetingId: string) =>
      (await who.api.call('listMeetingHistory', { query: { meetingId } })).items;
    const instant = (title: string) =>
      owner.api.call('createMeeting', { body: { mode: 'instant', title, spaceId: infraId } });

    it('offers the room once, on the newest finished session, and the slug joins', async () => {
      const m = await instant('Yeniden katılım');
      await finishSession(m.id);
      // Webhook times have one-second steps: the first session is clearly the older one.
      await app.deps.db
        .update(meetingSessions)
        .set({ startedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(meetingSessions.meetingId, m.id));
      await finishSession(m.id);
      const items = await historyOf(owner, m.id);
      expect(items).toHaveLength(2);
      expect(items[0]!.rejoinSlug).toBe(m.slug);
      expect(items[1]!.rejoinSlug).toBeNull();

      const link = await editor.api.call('resolveMeetingLink', {
        params: { slug: (await historyOf(editor, m.id))[0]!.rejoinSlug! },
      });
      const joined = await editor.api.call('joinMeeting', {
        params: { meetingId: link.id },
        body: {},
      });
      expect(joined.status).toBe('joined');
    });

    it('stays while the same meeting is running again', async () => {
      const m = await instant('Yine açık');
      await finishSession(m.id);
      await webhook(
        app,
        joinedEvent(`m-${m.id}`, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'),
      );
      expect((await historyOf(editor, m.id))[0]!.rejoinSlug).toBe(m.slug);
    });

    it('is gone once the meeting is cancelled, and joining then answers meet_ended', async () => {
      const m = await instant('İptal olan');
      await finishSession(m.id);
      await owner.api.call('cancelMeeting', { params: { meetingId: m.id } });
      expect((await historyOf(owner, m.id))[0]!.rejoinSlug).toBeNull();
      await expectCode(
        owner.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} }),
        'meet_ended',
      );
    });

    it('ends with the scheduled meeting link; a recurring one stays open', async () => {
      const longAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const schedule = (title: string, recurrence: 'none' | 'daily') =>
        owner.api.call('createMeeting', {
          body: {
            mode: 'scheduled',
            title,
            startsAt: longAgo,
            durationMinutes: 30,
            recurrence,
            invitees: { userIds: [], emails: [] },
            settings: {},
          },
        });
      const once = await schedule('Bir kerelik', 'none');
      const daily = await schedule('Her gün', 'daily');
      await finishSession(once.id);
      await finishSession(daily.id);
      expect((await historyOf(owner, once.id))[0]!.rejoinSlug).toBeNull();
      expect((await historyOf(owner, daily.id))[0]!.rejoinSlug).toBe(daily.slug);
    });

    it('needs direct access: someone who only took part sees the row, not the way back', async () => {
      const m = await instant('Yalnız alan üyeleri');
      const room = `m-${m.id}`;
      // Let in from the lobby: the session is theirs to see, the room still needs a knock.
      await webhook(app, joinedEvent(room, MEET_IDENTITY.user(outsiderId), 'Can', 'member'));
      await finishSession(m.id);
      const [row] = await historyOf(outsider, m.id);
      expect(row).toBeDefined();
      expect(row!.rejoinSlug).toBeNull();
      expect((await historyOf(owner, m.id))[0]!.rejoinSlug).toBe(m.slug);
    });

    it('not for someone removed from the session running now', async () => {
      const m = await instant('Çıkarılan kişi');
      await finishSession(m.id);
      await webhook(app, joinedEvent(`m-${m.id}`, MEET_IDENTITY.user(editorId), 'Mert', 'member'));
      await app.deps.db
        .update(meetingSessions)
        .set({ removedIdentities: [MEET_IDENTITY.user(editorId)] })
        .where(and(eq(meetingSessions.meetingId, m.id), isNull(meetingSessions.endedAt)));
      expect((await historyOf(editor, m.id))[0]!.rejoinSlug).toBeNull();
      expect((await historyOf(owner, m.id))[0]!.rejoinSlug).toBe(m.slug);
    });

    it('not for a finished call: a new call rings people, this would not', async () => {
      const m = await instant('Arama odası');
      await finishSession(m.id);
      await app.deps.db.insert(meetingCalls).values({
        orgId: (await app.deps.db.select().from(organizations))[0]!.id,
        meetingId: m.id,
        conversationId: randomUUID(),
        callerId: ownerId,
        status: 'ended',
      });
      expect((await historyOf(owner, m.id))[0]!.rejoinSlug).toBeNull();
    });
  });

  it('closes a room shortly after the last person leaves (history, not "şu an")', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Hızlı görüşme', spaceId: infraId },
    });
    const room = `m-${m.id}`;
    const join = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    await webhook(app, join);
    const session = (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live!;
    const send = vi.spyOn(app.deps.jobs, 'send');
    try {
      await webhook(app, { ...join, event: 'participant_left', id: `EV_${++seq}` });
      expect(send).toHaveBeenCalledWith(
        'meet.room_empty',
        { meetingId: m.id, sessionId: session.sessionId },
        expect.objectContaining({ startAfterSeconds: 30 }),
      );
    } finally {
      send.mockRestore();
    }
    // Still open during the grace period for someone coming back.
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live,
    ).not.toBeNull();
    // Someone came back: the check leaves it open.
    const back = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    await webhook(app, back);
    await emptyRoomCheck(app.deps, m.id, session.sessionId);
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live,
    ).not.toBeNull();
    // Gone for good: the room closes and the meeting is in the history.
    await webhook(app, { ...back, event: 'participant_left', id: `EV_${++seq}` });
    await emptyRoomCheck(app.deps, m.id, session.sessionId);
    expect((await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live).toBeNull();
    const home = await owner.api.call('getMeetHome', { query: { tz: 'Europe/Istanbul' } });
    expect(home.live.some((x) => x.id === m.id)).toBe(false);
    const history = await owner.api.call('listMeetingHistory', { query: { meetingId: m.id } });
    expect(history.items).toHaveLength(1);
  });

  it('records with egress, warns the room and files the recording in Drive', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Sprint planlama', spaceId: infraId },
    });
    const room = `m-${m.id}`;
    // Nobody in the room yet: egress has nothing to record.
    await expectCode(
      owner.api.call('startMeetingRecording', { params: { meetingId: m.id }, body: {} }),
      'meet_not_live',
    );
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(editorId), 'Mert', 'member'));

    // Editors are not moderators of this meeting; with the space rule off nobody but Admins records.
    await expectCode(
      editor.api.call('startMeetingRecording', { params: { meetingId: m.id }, body: {} }),
      'meet_recording_forbidden',
    );
    const target = await owner.api.call('getRecordingTarget', { params: { meetingId: m.id } });
    expect(target).toMatchObject({
      spaceId: infraId,
      folderName: 'Toplantı kayıtları',
      canStart: true,
      retentionDays: 180,
    });

    lk.signals.length = 0;
    const rec = await owner.api.call('startMeetingRecording', {
      params: { meetingId: m.id },
      body: {},
    });
    expect(rec).toMatchObject({ status: 'recording', audioOnly: false, spaceId: infraId });
    const startCall = lk.calls.findLast((c) => c.op === 'startRecording')!;
    expect(startCall.args[0]).toBe(room);
    const key = (startCall.args[1] as { storageKey: string }).storageKey;
    expect(key).toMatch(/^meet\/.+\.mp4$/);
    // Everybody inside is told (room metadata + signal), late joiners see the metadata.
    expect(lk.signals).toContainEqual(
      expect.objectContaining({
        room,
        signal: { type: 'recording', recordingId: rec.id, active: true },
      }),
    );
    const meta = lk.calls.findLast((c) => c.op === 'updateRoomMetadata')!;
    expect(JSON.parse(meta.args[1] as string)).toMatchObject({
      recording: { id: rec.id, by: 'Ahmet Buğra Kösen' },
    });
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live?.recording?.id,
    ).toBe(rec.id);
    expect(
      (await new Client(app).api.call('getMeetingLink', { params: { slug: m.slug } })).recording,
    ).toBe(true);
    await expectCode(
      owner.api.call('startMeetingRecording', { params: { meetingId: m.id }, body: {} }),
      'meet_recording_active',
    );

    await owner.api.call('stopMeetingRecording', { params: { recordingId: rec.id } });
    const egressId = (
      await app.deps.db.select().from(recordings).where(eq(recordings.id, rec.id))
    )[0]!.egressId!;
    expect(lk.calls.findLast((c) => c.op === 'stopRecording')!.args).toEqual([egressId]);
    // The room's indicator goes off at once; egress only finishes the file now.
    const afterStop = lk.calls.findLast((c) => c.op === 'updateRoomMetadata')!;
    expect(JSON.parse(afterStop.args[1] as string)).toMatchObject({ recording: null });
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: m.id } })).live?.recording ?? null,
    ).toBeNull();

    // Egress wrote the file to the bucket; egress_ended queues recording.ingest.
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypmp42'),
      Buffer.alloc(4096, 7),
    ]);
    await app.deps.storage!.put(key, mp4, 'video/mp4');
    const ended = await webhook(app, {
      event: 'egress_ended',
      id: `EV_${++seq}`,
      createdAt: now(),
      egressInfo: {
        egressId,
        roomName: room,
        status: 'EGRESS_COMPLETE',
        fileResults: [{ filename: key, size: String(mp4.length), duration: '1320000000000' }],
      },
    });
    expect(ended.status).toBe(200);

    const [done] = await owner.api
      .call('listMeetingRecordings', { params: { meetingId: m.id } })
      .then((r) => r.items);
    expect(done).toMatchObject({ status: 'ready', durationSeconds: 1320, sizeBytes: mp4.length });
    expect(done!.fileName).toMatch(/^Sprint planlama · \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.mp4$/);
    const root = await owner.api.call('listNodes', { params: { spaceId: infraId }, query: {} });
    const folder = root.items.find((n) => n.name === 'Toplantı kayıtları')!;
    expect(folder.type).toBe('folder');
    const files = await editor.api.call('listNodes', {
      params: { spaceId: infraId },
      query: { parentId: folder.id },
    });
    expect(files.items).toEqual([
      expect.objectContaining({ id: done!.nodeId, type: 'file', sizeBytes: mp4.length }),
    ]);
    // A replayed egress_ended does not file it twice.
    await webhook(app, {
      event: 'egress_ended',
      id: `EV_${++seq}`,
      createdAt: now(),
      egressInfo: { egressId, roomName: room, status: 'EGRESS_COMPLETE', fileResults: [] },
    });
    const again = await owner.api.call('listNodes', {
      params: { spaceId: infraId },
      query: { parentId: folder.id },
    });
    expect(again.items).toHaveLength(1);

    // Retention (doc 17 §15 item 8): past the space's days the file goes to the trash.
    await owner.api.call('updateMeetSpaceSettings', {
      params: { spaceId: infraId },
      body: { recordingRetentionDays: 1 },
    });
    await app.deps.db
      .update(recordings)
      .set({ startedAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(recordings.id, rec.id));
    expect(await expireRecordings(app.deps)).toBe(1);
    const [trashed] = await app.deps.db.select().from(nodes).where(eq(nodes.id, done!.nodeId!));
    expect(trashed!.deletedAt).not.toBeNull();
    const [row] = await app.deps.db.select().from(recordings).where(eq(recordings.id, rec.id));
    expect(row!.status).toBe('expired');
  });

  it('marks a failed egress and lets space settings decide who records', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Kayıt hatası', spaceId: infraId },
    });
    const room = `m-${m.id}`;
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    const rec = await owner.api.call('startMeetingRecording', {
      params: { meetingId: m.id },
      body: { audioOnly: true },
    });
    const [row] = await app.deps.db.select().from(recordings).where(eq(recordings.id, rec.id));
    expect(row!.storageKey).toMatch(/\.m4a$/);
    await webhook(app, {
      event: 'egress_ended',
      id: `EV_${++seq}`,
      createdAt: now(),
      egressInfo: {
        egressId: row!.egressId,
        roomName: room,
        status: 'EGRESS_FAILED',
        error: 'chrome crashed',
      },
    });
    const [failed] = (
      await owner.api.call('listMeetingRecordings', { params: { meetingId: m.id } })
    ).items;
    expect(failed).toMatchObject({ status: 'failed', error: 'chrome crashed' });

    await expectCode(
      editor.api.call('updateMeetSpaceSettings', {
        params: { spaceId: infraId },
        body: { editorsCanRecord: false },
      }),
      'forbidden',
    );
    const s = await owner.api.call('updateMeetSpaceSettings', {
      params: { spaceId: infraId },
      body: { editorsCanRecord: false, recordingRetentionDays: null },
    });
    expect(s).toEqual({
      spaceId: infraId,
      guestsAllowed: true,
      editorsCanRecord: false,
      recordingRetentionDays: null,
    });
    const [stored] = await app.deps.db
      .select()
      .from(meetSpaceSettings)
      .where(eq(meetSpaceSettings.spaceId, infraId));
    expect(stored!.editorsCanRecord).toBe(false);
    expect(
      (await viewer.api.call('getMeetSpaceSettings', { params: { spaceId: infraId } }))
        .editorsCanRecord,
    ).toBe(false);
  });

  it('lets moderators mute, remove (back through the lobby) and end the meeting', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Moderasyon', spaceId: infraId },
    });
    const room = `m-${m.id}`;
    const edIdentity = MEET_IDENTITY.user(editorId);
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    await webhook(app, joinedEvent(room, edIdentity, 'Mert', 'member'));
    lk.participants.set(room, [
      {
        identity: edIdentity,
        name: 'Mert',
        metadata: JSON.stringify({
          userId: editorId,
          role: 'member',
          guest: false,
          imageUrl: null,
        }),
        tracks: [
          { sid: 'TR_mic', source: 'microphone', muted: false },
          { sid: 'TR_cam', source: 'camera', muted: false },
        ],
      },
    ]);
    await expectCode(
      editor.api.call('moderateMeetingParticipant', {
        params: { meetingId: m.id },
        body: { identity: edIdentity, action: 'mute' },
      }),
      'meet_not_moderator',
    );
    await owner.api.call('moderateMeetingParticipant', {
      params: { meetingId: m.id },
      body: { identity: edIdentity, action: 'mute' },
    });
    expect(lk.calls.findLast((c) => c.op === 'muteTrack')!.args).toEqual([
      room,
      edIdentity,
      'TR_mic',
    ]);
    await owner.api.call('muteAllInMeeting', { params: { meetingId: m.id }, body: {} });
    await owner.api.call('moderateMeetingParticipant', {
      params: { meetingId: m.id },
      body: { identity: edIdentity, action: 'lower_hand' },
    });
    expect(lk.calls.findLast((c) => c.op === 'updateParticipant')!.args[2]).toEqual({
      attributes: { hand: '' },
    });

    await owner.api.call('moderateMeetingParticipant', {
      params: { meetingId: m.id },
      body: { identity: edIdentity, action: 'remove' },
    });
    expect(lk.calls.findLast((c) => c.op === 'removeParticipant')!.args).toEqual([
      room,
      edIdentity,
    ]);
    // Design 7.8: back with the same link → lobby.
    const back = await editor.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    expect(back.status).toBe('lobby');

    await owner.api.call('moderateMeetingParticipant', {
      params: { meetingId: m.id },
      body: { identity: edIdentity, action: 'make_moderator' },
    });
    expect((await editor.api.call('getMeeting', { params: { meetingId: m.id } })).myRole).toBe(
      'moderator',
    );

    await owner.api.call('endMeetingForAll', { params: { meetingId: m.id } });
    expect(lk.signals.at(-1)).toMatchObject({ room, signal: { type: 'ended' } });
    expect(lk.calls.findLast((c) => c.op === 'deleteRoom')!.args).toEqual([room]);
    const live = await owner.api.call('getMeeting', { params: { meetingId: m.id } });
    expect(live.live).toBeNull();
  });

  it('lists today, upcoming and rooms for the people who can see them', async () => {
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const m = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Bugünkü',
        spaceId: infraId,
        startsAt: soon,
        durationMinutes: 30,
      },
    });
    const home = await editor.api.call('getMeetHome', { query: { tz: 'UTC' } });
    expect(home.rooms.map((r) => r.slug)).toContain('altyapi-haftalik');
    expect(home.upcomingCount).toBeGreaterThanOrEqual(1);
    const upcoming = await editor.api.call('listMeetings', { query: { view: 'upcoming' } });
    expect(upcoming.items.map((x) => x.id)).toContain(m.id);
    // Not in the space, not invited: none of these.
    const other = await outsider.api.call('listMeetings', { query: { view: 'upcoming' } });
    expect(other.items.map((x) => x.id)).not.toContain(m.id);
    const resolved = await outsider.api.call('resolveMeetingLink', { params: { slug: m.slug } });
    expect(resolved.myRole).toBeNull();

    const rows = await app.deps.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.spaceId, infraId), isNull(nodes.deletedAt), eq(nodes.type, 'folder')));
    expect(rows.filter((r) => r.name === 'Toplantı kayıtları')).toHaveLength(1);
  });
});

describe('Meet with chat', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;
  let member: Client;
  let memberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    setLiveKit(app.deps, fakeLiveKit().gw);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const m = await join(app, owner, 'zeynep@milvasoft.com', 'member');
    member = m.person;
    memberId = m.me.user.id;
  });
  afterAll(() => app.close());

  it("opens a space's permanent room chat to the space, not to anyone else", async () => {
    const spaceId = (await owner.api.call('listSpaces')).items.find(
      (s) => s.name === 'Altyapı',
    )!.id;
    const inSpace = await join(app, owner, 'selin@milvasoft.com', 'member', [spaceId]);
    const room = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Altyapı odası', spaceId },
    });
    const conversationId = room.chatConversationId!;
    const listed = await inSpace.person.api.call('listConversations', { query: { limit: 200 } });
    // The list says they may write, or the composer would stay locked for them.
    expect(listed.items.find((x) => x.id === conversationId)?.permissions.write).toBe(true);
    // Someone outside the space does not see it.
    const outside = await member.api.call('listConversations', { query: { limit: 200 } });
    expect(outside.items.map((x) => x.id)).not.toContain(conversationId);
    await expectCode(
      member.api.call('getConversation', { params: { conversationId } }),
      'not_found',
    );
    // They can read and write there without having joined the room.
    await inSpace.person.api.call('sendMessage', {
      params: { conversationId },
      body: { text: 'oda hazır mı?', clientMsgId: randomUUID(), attachmentNodeIds: [] },
    });
    // Unread and counting work for someone with no member row yet.
    const unread = await owner.api.call('listConversations', { query: { limit: 200 } });
    expect(unread.items.find((x) => x.id === conversationId)?.my.unread).toBe(1);
  });

  it('keeps a planned meeting chat with its invitees and whoever joined, not the whole space', async () => {
    const spaceId = (await owner.api.call('listSpaces')).items.find(
      (s) => s.name === 'Altyapı',
    )!.id;
    const invited = await join(app, owner, 'davetli@milvasoft.com', 'member', [spaceId]);
    const bystander = await join(app, owner, 'seyirci@milvasoft.com', 'member', [spaceId]);
    const title = 'Gizli bütçe görüşmesi';
    const planned = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title,
        spaceId,
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        durationMinutes: 30,
        invitees: { userIds: [invited.me.user.id], emails: [] },
      },
    });
    const conversationId = planned.chatConversationId!;
    const params = { conversationId };
    const send = (c: Client, text: string) =>
      c.api.call('sendMessage', {
        params,
        body: { text, clientMsgId: randomUUID(), attachmentNodeIds: [] },
      });
    // The invitee is in before the meeting starts.
    await send(invited.person, 'gündemsizbütçe notu');

    const person = bystander.person;
    // The list, its meeting filter and its search: neither the chat nor its title.
    for (const query of [{ limit: 200 }, { filter: 'meeting' as const }, { q: title }]) {
      const page = await person.api.call('listConversations', { query });
      expect(page.items.map((x) => x.id)).not.toContain(conversationId);
      expect(JSON.stringify(page.items)).not.toContain(title);
    }
    const unreads = await person.api.call('getUnreads');
    expect(unreads.conversations.map((c) => c.conversationId)).not.toContain(conversationId);
    const hits = await person.api.call('searchMessages', { query: { q: 'gündemsizbütçe' } });
    expect(hits.items).toEqual([]);
    // Opening it directly: it does not exist for them, whatever they try.
    await expectCode(person.api.call('getConversation', { params }), 'not_found');
    await expectCode(person.api.call('listMessages', { params, query: {} }), 'not_found');
    await expectCode(person.api.call('listConversationMembers', { params }), 'not_found');
    await expectCode(send(person, 'buradayım'), 'not_found');
    await expectCode(
      person.api.call('updateMyConversation', { params, body: { pinned: true } }),
      'not_found',
    );

    // Their failed attempts left no member row behind to let them in later.
    const before = await owner.api.call('listConversationMembers', { params });
    expect(before.items.map((x) => x.user.id)).not.toContain(bystander.me.user.id);

    // Joining the meeting, which the space may do, grants the chat.
    await person.api.call('joinMeeting', { params: { meetingId: planned.id }, body: {} });
    const after = await person.api.call('listConversations', { query: { limit: 200 } });
    expect(after.items.map((x) => x.id)).toContain(conversationId);
    const page = await person.api.call('listMessages', { params, query: {} });
    expect(page.items.map((x) => x.text)).toContain('gündemsizbütçe notu');
    await send(person, 'şimdi buradayım');
  });

  it('adds someone let in from the lobby to the meeting chat', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Kapıdan girenler' },
    });
    await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { settings: { lobby: true } },
    });
    const knocker = await join(app, owner, 'kapi@milvasoft.com', 'guest');
    const first = await knocker.person.api.call('joinMeeting', {
      params: { meetingId: m.id },
      body: {},
    });
    expect(first.status).toBe('lobby');
    if (first.status !== 'lobby') return;
    await owner.api.call('decideMeetingLobby', {
      params: { meetingId: m.id },
      body: { requestIds: [first.request.id], admit: true },
    });
    const second = await knocker.person.api.call('joinMeeting', {
      params: { meetingId: m.id },
      body: {},
    });
    expect(second.status).toBe('joined');
    const items = (await knocker.person.api.call('listConversations', { query: { limit: 200 } }))
      .items;
    expect(items.map((x) => x.id)).toContain(m.chatConversationId);
  });

  it('opens the meeting conversation with the people invited and adds whoever joins', async () => {
    const m = await owner.api.call('createMeeting', {
      body: {
        mode: 'scheduled',
        title: 'Sprint planlama',
        startsAt: new Date(Date.now() + 3_600_000).toISOString(),
        durationMinutes: 30,
        invitees: { userIds: [memberId], emails: [] },
      },
    });
    expect(m.chatConversationId).not.toBeNull();
    const conv = await member.api.call('getConversation', {
      params: { conversationId: m.chatConversationId! },
    });
    expect(conv).toMatchObject({ type: 'meeting', meetingId: m.id, title: 'Sprint planlama' });
    const members = await owner.api.call('listConversationMembers', {
      params: { conversationId: m.chatConversationId! },
    });
    expect(members.items.map((x) => x.user.id).sort()).toEqual([ownerId, memberId].sort());
    const list = await member.api.call('listConversations', { query: { filter: 'meeting' } });
    expect(list.items.map((c) => c.id)).toContain(m.chatConversationId);

    // A room without invitees: the conversation starts with the host; people join it by joining.
    const room = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Açık oda' },
    });
    await member.api.call('joinMeeting', { params: { meetingId: room.id }, body: {} });
    const after = await owner.api.call('listConversationMembers', {
      params: { conversationId: room.chatConversationId! },
    });
    expect(after.items.map((x) => x.user.id).sort()).toEqual([ownerId, memberId].sort());
  });

  it('writes started and ended lines into the source and the meeting conversations', async () => {
    const direct = await owner.api.call('createConversation', {
      body: { type: 'direct', userId: memberId },
    });
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', conversationId: direct.id },
    });
    // Members of a direct or group chat are invited up front (not the starter).
    expect(m.invitees.map((i) => i.user?.id)).toEqual([memberId]);
    const members = await member.api.call('listConversationMembers', {
      params: { conversationId: m.chatConversationId! },
    });
    expect(members.items.map((x) => x.user.id).sort()).toEqual([ownerId, memberId].sort());
    const inbox = await member.api.call('listNotifications', { query: {} });
    expect(inbox.items.find((n) => n.type === 'meet.invited')).toMatchObject({
      target: { id: m.id, conversationId: direct.id },
    });
    const ownInbox = await owner.api.call('listNotifications', { query: {} });
    expect(ownInbox.items.some((n) => n.type === 'meet.invited')).toBe(false);
    // Someone outside the conversation cannot attach a meeting to it.
    const outsider = await join(app, owner, 'ali@milvasoft.com', 'member');
    await expectCode(
      outsider.person.api.call('createMeeting', {
        body: { mode: 'instant', conversationId: direct.id },
      }),
      'not_found',
    );
    const room = `m-${m.id}`;
    // LiveKit sends room_started first: the session is open before anyone joins.
    await webhook(app, {
      event: 'room_started',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });
    const ownerJoin = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    await webhook(app, ownerJoin);
    // A retried delivery and a second person do not start it again.
    await webhook(app, ownerJoin);
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(memberId), 'Zeynep', 'member'));
    await webhook(app, {
      event: 'room_finished',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });
    const lines = async (conversationId: string) =>
      (await member.api.call('listMessages', { params: { conversationId }, query: {} })).items
        .map((x) => x.system)
        .filter((e) => e?.meetingId === m.id);
    for (const id of [direct.id, m.chatConversationId!]) {
      const got = await lines(id);
      expect(got.map((e) => e!.type)).toEqual(['meeting_started', 'meeting_ended']);
      expect(got[0]).toMatchObject({ actorId: ownerId });
      expect(got[1]!.durationSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('invites nobody up front from a space chat; people join by joining', async () => {
    const spaceId = (await owner.api.call('listSpaces')).items.find(
      (x) => x.name === 'Altyapı',
    )!.id;
    const mert = await join(app, owner, 'mert@milvasoft.com', 'member', [spaceId]);
    const conv = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Altyapı sohbeti' },
    });
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'instant', conversationId: conv.id },
    });
    expect(m.invitees).toEqual([]);
    const members = await owner.api.call('listConversationMembers', {
      params: { conversationId: m.chatConversationId! },
    });
    expect(members.items.map((x) => x.user.id)).toEqual([ownerId]);
    const inbox = await mert.person.api.call('listNotifications', { query: {} });
    expect(inbox.items.some((n) => n.type === 'meet.invited')).toBe(false);
  });
});

describe('Meet switched off for the org', () => {
  let app: TestApp;
  let owner: Client;
  let ownerId: string;

  beforeAll(async () => {
    app = await createTestApp();
    setLiveKit(app.deps, fakeLiveKit().gw);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
  });
  afterAll(() => app.close());

  it('ignores LiveKit webhooks and closes the guest link', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Kapalı', settings: { guestsAllowed: true } },
    });
    const [org] = await app.deps.db.select().from(organizations);
    const settings = { ...org!.settings, modules: { meet: false } };
    await app.deps.db.update(organizations).set({ settings }).where(eq(organizations.id, org!.id));
    invalidateModules();

    const res = await webhook(
      app,
      joinedEvent(`m-${m.id}`, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'),
    );
    expect(res.status).toBe(200);
    const sessions = await app.deps.db
      .select()
      .from(meetingSessions)
      .where(eq(meetingSessions.meetingId, m.id));
    expect(sessions).toHaveLength(0);

    const anon = new Client(app);
    await expectCode(
      // The central module guard (MODULE_OF_ENDPOINT) answers before the meet service.
      anon.api.call('getMeetingLink', { params: { slug: m.slug } }),
      'module_disabled',
    );
    await expectCode(
      anon.api.call('requestGuestJoin', { params: { slug: m.slug }, body: { name: 'Biri' } }),
      'module_disabled',
    );
  });
});

describe('Calls from chat (H7)', () => {
  let app: TestApp;
  let lk: ReturnType<typeof fakeLiveKit>;
  let owner: Client;
  let ownerId: string;
  let zeynep: Client;
  let zeynepId: string;
  let mert: Client;
  let mertId: string;
  const events = new Map<string, WsServerEvent[]>();

  beforeAll(async () => {
    app = await createTestApp();
    lk = fakeLiveKit();
    setLiveKit(app.deps, lk.gw);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const z = await join(app, owner, 'zeynep@milvasoft.com', 'member');
    zeynep = z.person;
    zeynepId = z.me.user.id;
    const m = await join(app, owner, 'mert@milvasoft.com', 'member');
    mert = m.person;
    mertId = m.me.user.id;
    for (const id of [ownerId, zeynepId, mertId]) {
      events.set(id, []);
      app.deps.bus.subscribe(`user:${id}`, (e) => events.get(id)!.push(e));
    }
  });
  afterAll(() => app.close());

  const callEvents = (userId: string, type: 'call.ringing' | 'call.updated') =>
    events.get(userId)!.filter((e) => e.type === type);
  const lines = async (who: Client, conversationId: string) =>
    (await who.api.call('listMessages', { params: { conversationId }, query: {} })).items
      .map((x) => x.system)
      .filter((e) => e?.type.startsWith('call_') || e?.type.startsWith('meeting_'));
  const direct = async (who = owner, userId = zeynepId) =>
    (await who.api.call('createConversation', { body: { type: 'direct', userId } })).id;

  it('rings, is answered, and a one-to-one call ends when one side hangs up', async () => {
    const conversationId = await direct();
    const call = await owner.api.call('startCall', { body: { conversationId, video: true } });
    expect(call).toMatchObject({ status: 'ringing', video: true, conversationTitle: null });
    expect(call.members).toEqual([expect.objectContaining({ state: 'ringing' })]);
    // The callee's web rings over the socket; the phone gets a push-only notification.
    expect(callEvents(zeynepId, 'call.ringing').at(-1)).toMatchObject({ call: { id: call.id } });
    const push = await app.deps.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, zeynepId), eq(notifications.type, 'meet.call')));
    expect(push).toHaveLength(1);
    expect(push[0]!.dismissedAt).not.toBeNull();
    expect(push[0]!.payload).toMatchObject({ callId: call.id, video: true });
    expect((await zeynep.api.call('listIncomingCalls')).items.map((c) => c.id)).toEqual([call.id]);
    // Calling again while it rings returns the same call.
    expect((await owner.api.call('startCall', { body: { conversationId } })).id).toBe(call.id);

    const answered = await zeynep.api.call('answerCall', { params: { callId: call.id } });
    expect(answered).toMatchObject({ status: 'active' });
    expect(answered.members[0]!.state).toBe('accepted');
    expect(callEvents(ownerId, 'call.updated').at(-1)).toMatchObject({
      call: { status: 'active' },
    });
    expect((await zeynep.api.call('listIncomingCalls')).items).toEqual([]);
    // The callee joins the room directly (invited with the call).
    const joined = await zeynep.api.call('joinMeeting', {
      params: { meetingId: call.meetingId },
      body: {},
    });
    expect(joined.status).toBe('joined');

    const room = `m-${call.meetingId}`;
    await webhook(app, {
      event: 'room_started',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });
    const oJoin = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    await webhook(app, oJoin);
    // The caller reconnecting before the other side arrives does not end the call.
    await webhook(app, { ...oJoin, event: 'participant_left', id: `EV_${++seq}` });
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    expect((await owner.api.call('getCall', { params: { callId: call.id } })).status).toBe(
      'active',
    );
    const zJoin = joinedEvent(room, MEET_IDENTITY.user(zeynepId), 'Zeynep', 'member');
    await webhook(app, zJoin);
    const [session] = await app.deps.db
      .select()
      .from(meetingSessions)
      .where(and(eq(meetingSessions.meetingId, call.meetingId), isNull(meetingSessions.endedAt)));
    // A dropped connection that comes back within the grace period keeps the call.
    await webhook(app, { ...zJoin, event: 'participant_left', id: `EV_${++seq}` });
    const zBack = joinedEvent(room, MEET_IDENTITY.user(zeynepId), 'Zeynep', 'member');
    await webhook(app, zBack);
    await hangupCheck(app.deps, call.meetingId, session!.id);
    expect((await owner.api.call('getCall', { params: { callId: call.id } })).status).toBe(
      'active',
    );
    // One side hangs up: the room closes for the other too and the call becomes history.
    await webhook(app, { ...zBack, event: 'participant_left', id: `EV_${++seq}` });
    await hangupCheck(app.deps, call.meetingId, session!.id);
    expect(lk.calls.some((c) => c.op === 'deleteRoom' && c.args[0] === room)).toBe(true);
    const done = await owner.api.call('getCall', { params: { callId: call.id } });
    expect(done.status).toBe('ended');
    expect(done.durationSeconds).toBeGreaterThanOrEqual(0);
    const history = await lines(owner, conversationId);
    // The call's line instead of the meeting's started and ended lines.
    expect(history.map((e) => e!.type)).toEqual(['call_ended']);
    expect(history[0]).toMatchObject({ actorId: ownerId, video: true });
    expect(history[0]!.userIds!.sort()).toEqual([ownerId, zeynepId].sort());
  });

  it('rings people into a meeting going on; turning it down or silence tells the ringer', async () => {
    const m = await owner.api.call('createMeeting', { body: { mode: 'room', title: 'Haftalık' } });
    // Not while nobody is inside.
    await expectCode(
      owner.api.call('ringToMeeting', {
        params: { meetingId: m.id },
        body: { userIds: [zeynepId] },
      }),
      'meet_not_live',
    );
    const room = `m-${m.id}`;
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    const events: WsServerEvent[] = [];
    const off = app.deps.bus.subscribe(`user:${zeynepId}`, (e) => events.push(e as WsServerEvent));
    const ring = await owner.api.call('ringToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [zeynepId, mertId] },
    });
    off();
    expect(ring).toMatchObject({ invite: true, status: 'active', slug: m.slug });
    expect(ring.members.map((x) => [x.user.id, x.state]).sort()).toEqual(
      [
        [zeynepId, 'ringing'],
        [mertId, 'ringing'],
      ].sort(),
    );
    expect(events.some((e) => e.type === 'call.ringing')).toBe(true);
    // Zeynep turns it down, Mert does not answer: Buğra hears about both.
    await zeynep.api.call('declineCall', { params: { callId: ring.id }, body: {} });
    await timeoutCall(app.deps, ring.id, new Date(Date.now() + 46_000));
    const bell = (await owner.api.call('listNotifications', { query: {} })).items;
    expect(bell.find((n) => n.type === 'meet.ring_declined')?.actor?.id).toBe(zeynepId);
    expect(bell.find((n) => n.type === 'meet.ring_unanswered')?.actor?.id).toBe(mertId);
    // Ringing again works while the meeting goes on; answering lets them in.
    const again = await owner.api.call('ringToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [zeynepId] },
    });
    expect(again.id).toBe(ring.id);
    await zeynep.api.call('answerCall', { params: { callId: ring.id } });
    const joined = await zeynep.api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    expect(joined.status).toBe('joined');
    // The meeting ends with its own line, not a call line.
    await webhook(app, {
      event: 'room_finished',
      id: `EV_${++seq}`,
      createdAt: now(),
      room: { sid: `RM_${room}`, name: room },
    });
    expect((await owner.api.call('getCall', { params: { callId: ring.id } })).status).toBe('ended');
  });

  /** The others in this file start calls of their own: nobody stays busy in this one. */
  const endRings = async (meetingId: string) => {
    lk.participants.delete(`m-${meetingId}`);
    await app.deps.db
      .update(meetingCalls)
      .set({ status: 'ended', endedAt: new Date() })
      .where(eq(meetingCalls.meetingId, meetingId));
    await app.deps.db
      .update(meetingSessions)
      .set({ endedAt: new Date() })
      .where(eq(meetingSessions.meetingId, meetingId));
  };

  it('rings whoever is not in the room, and adding someone mid-meeting never invites', async () => {
    const m = await owner.api.call('createMeeting', { body: { mode: 'room', title: 'Canlı' } });
    const room = `m-${m.id}`;
    const inRoom = (...ids: string[]) =>
      lk.participants.set(
        room,
        ids.map((id) => ({ identity: MEET_IDENTITY.user(id), name: '', metadata: '{}' }) as never),
      );
    // People are inside before LiveKit's webhook made a session row: that is live already.
    inRoom(ownerId);
    const ring = await owner.api.call('ringToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [zeynepId] },
    });
    expect(ring.members.map((x) => x.state)).toEqual(['ringing']);

    // Zeynep answers, joins and leaves; ringing her again works once she is gone.
    await zeynep.api.call('answerCall', { params: { callId: ring.id } });
    inRoom(ownerId, zeynepId);
    const inside = await owner.api.call('ringToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [zeynepId] },
    });
    expect(inside.members.find((x) => x.user.id === zeynepId)?.state).toBe('accepted');
    inRoom(ownerId);
    await app.deps.db
      .update(meetingCalls)
      .set({
        members: [
          { userId: zeynepId, state: 'accepted', at: new Date(Date.now() - 60_000).toISOString() },
        ],
      })
      .where(eq(meetingCalls.id, ring.id));
    const back = await owner.api.call('ringToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [zeynepId] },
    });
    expect(back.members.find((x) => x.user.id === zeynepId)?.state).toBe('ringing');

    // Another moderator rings: the screen says who, and the one who started it can be rung too.
    await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { settings: { lobby: false } },
    });
    inRoom(zeynepId);
    await zeynep.api.call('answerCall', { params: { callId: ring.id } });
    const byOther = await zeynep.api.call('ringToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [ownerId, mertId] },
    });
    const rung = byOther.members.find((x) => x.user.id === mertId)!;
    expect(rung.state).toBe('ringing');
    expect(rung.by?.id).toBe(zeynepId);
    expect(byOther.members.find((x) => x.user.id === ownerId)?.state).toBe('ringing');
    expect(byOther.caller?.id).toBe(ownerId);
    // The ringer hears how it went, not the one who started the call.
    await mert.api.call('declineCall', { params: { callId: ring.id }, body: {} });
    const bell = (await zeynep.api.call('listNotifications', { query: {} })).items;
    expect(bell.find((n) => n.type === 'meet.ring_declined')?.actor?.id).toBe(mertId);
    await endRings(m.id);
  });

  it('turns an invitation during a live meeting into a ring', async () => {
    app.mailer.outbox.length = 0;
    const m = await owner.api.call('createMeeting', { body: { mode: 'room', title: 'Davetsiz' } });
    await webhook(app, joinedEvent(`m-${m.id}`, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));
    await owner.api.call('inviteToMeeting', {
      params: { meetingId: m.id },
      body: { userIds: [zeynepId], emails: ['misafir.canli@ornek.com'] },
    });
    const incoming = await zeynep.api.call('listIncomingCalls');
    expect(incoming.items.some((c) => c.meetingId === m.id)).toBe(true);
    const bell = (await zeynep.api.call('listNotifications', { query: {} })).items;
    expect(bell.some((n) => n.type === 'meet.invited' && n.data?.title === 'Davetsiz')).toBe(false);
    // Guests have nothing to ring: the link goes by e-mail, and only to them.
    expect(app.mailer.outbox.map((x) => x.to)).toEqual(['misafir.canli@ornek.com']);
    await endRings(m.id);
  });

  it('closes the room of a one-to-one call that ends, without waiting for LiveKit', async () => {
    const conversationId = await direct();
    const room = (meetingId: string) => `m-${meetingId}`;
    const deleted = (meetingId: string) =>
      lk.calls.some((c) => c.op === 'deleteRoom' && c.args[0] === room(meetingId));

    // Nobody answers: the room the caller waits in closes with the call.
    const missed = await owner.api.call('startCall', { body: { conversationId } });
    await webhook(
      app,
      joinedEvent(room(missed.meetingId), MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'),
    );
    await timeoutCall(app.deps, missed.id, new Date(Date.now() + 46_000));
    expect(deleted(missed.meetingId)).toBe(true);
    expect(
      (await owner.api.call('getMeeting', { params: { meetingId: missed.meetingId } })).live,
    ).toBeNull();

    // "Ayrıl" in a call going on ends it for both, even if LiveKit never reports a departure.
    lk.calls.length = 0;
    const call = await owner.api.call('startCall', { body: { conversationId } });
    await zeynep.api.call('answerCall', { params: { callId: call.id } });
    await webhook(
      app,
      joinedEvent(room(call.meetingId), MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'),
    );
    await webhook(
      app,
      joinedEvent(room(call.meetingId), MEET_IDENTITY.user(zeynepId), 'Zeynep', 'member'),
    );
    await expectCode(mert.api.call('hangUpCall', { params: { callId: call.id } }), 'not_found');
    const ended = await zeynep.api.call('hangUpCall', { params: { callId: call.id } });
    expect(ended.status).toBe('ended');
    expect(deleted(call.meetingId)).toBe(true);
    expect(
      lk.signals.some((s) => s.room === room(call.meetingId) && s.signal.type === 'ended'),
    ).toBe(true);
    // The call's line, not a "toplantı bitti" one.
    expect((await lines(owner, conversationId)).at(-1)).toMatchObject({ type: 'call_ended' });
  });

  it('counts a call from the time the two were in the room, not until the room closed', async () => {
    const conversationId = await direct();
    const call = await owner.api.call('startCall', { body: { conversationId } });
    const answered = await zeynep.api.call('answerCall', { params: { callId: call.id } });
    const answeredAt = Date.parse(answered.answeredAt!);
    const room = `m-${call.meetingId}`;
    const oJoin = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    const zJoin = joinedEvent(room, MEET_IDENTITY.user(zeynepId), 'Zeynep', 'member');
    await webhook(app, oJoin);
    await webhook(app, zJoin);
    // A minute together, then the room stayed open (nobody hung up properly).
    const at = (ms: number) => new Date(answeredAt + ms);
    await app.deps.db
      .update(meetingParticipants)
      .set({ joinedAt: at(-10_000), leftAt: at(62_000) })
      .where(eq(meetingParticipants.identity, MEET_IDENTITY.user(ownerId)));
    await app.deps.db
      .update(meetingParticipants)
      .set({ joinedAt: at(2_000), leftAt: at(62_000) })
      .where(eq(meetingParticipants.identity, MEET_IDENTITY.user(zeynepId)));
    await endCallsOfMeeting(app.deps, call.meetingId, at(23 * 3600_000));
    const done = await owner.api.call('getCall', { params: { callId: call.id } });
    // From the answer to the last one leaving.
    expect(done.durationSeconds).toBe(62);
    expect((await lines(owner, conversationId)).at(-1)).toMatchObject({
      type: 'call_ended',
      durationSeconds: 62,
    });
    await webhook(app, { ...oJoin, event: 'participant_left', id: `EV_${++seq}` });
    await webhook(app, { ...zJoin, event: 'participant_left', id: `EV_${++seq}` });

    // Answered on a phone that never reached the room: a missed call for the chat.
    const other = await direct(mert, zeynepId);
    const again = await mert.api.call('startCall', { body: { conversationId: other } });
    await zeynep.api.call('answerCall', { params: { callId: again.id } });
    await endCallsOfMeeting(app.deps, again.meetingId);
    expect((await lines(mert, other)).at(-1)).toMatchObject({
      type: 'call_missed',
      callOutcome: 'missed',
    });
  });

  it('rings the phone even while the chat is open on another device', async () => {
    const conversationId = await direct();
    // Zeynep has the chat open on a visible web tab (H8 skips message notifications then).
    app.deps.presence.connect('zeynep-web', zeynepId, null);
    app.deps.presence.heartbeat('zeynep-web', zeynepId, true, true, conversationId);
    const send = vi.spyOn(app.deps.jobs, 'send');
    try {
      const call = await owner.api.call('startCall', { body: { conversationId } });
      const [ring] = await app.deps.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, zeynepId),
            eq(notifications.type, 'meet.call'),
            sql`${notifications.payload}->>'callId' = ${call.id}`,
          ),
        );
      // A call rings every device: the push goes out whatever is on screen elsewhere.
      expect(ring).toBeDefined();
      expect(ring!.wantsPush).toBe(true);
      expect(send).toHaveBeenCalledWith(
        'push.send',
        { notificationId: ring!.id },
        expect.anything(),
      );
      // Hanging up stops the phone ringing.
      await owner.api.call('cancelCall', { params: { callId: call.id } });
      expect(send).toHaveBeenCalledWith(
        'meet.call_end',
        expect.objectContaining({ callId: call.id, userIds: [zeynepId] }),
      );
    } finally {
      send.mockRestore();
      app.deps.presence.disconnect('zeynep-web', zeynepId);
    }
  });

  it('tells the chat header what goes on in the conversation room (members only)', async () => {
    const conversationId = await direct();
    const live = (who = zeynep) =>
      who.api.call('getConversationLive', { params: { conversationId } });
    expect(await live()).toEqual({ call: null, meeting: null });
    await expectCode(live(mert), 'not_found');

    const call = await owner.api.call('startCall', { body: { conversationId, video: true } });
    expect((await live()).call).toMatchObject({ id: call.id, status: 'ringing', video: true });
    expect((await live()).meeting).toBeNull();

    // Someone in the room: the meeting shows with its head count.
    const room = `m-${call.meetingId}`;
    const joined = joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator');
    await webhook(app, joined);
    expect((await live()).meeting).toMatchObject({
      id: call.meetingId,
      slug: call.slug,
      participantCount: 1,
    });

    // Hanging up a one-to-one call that rings closes its room too.
    await owner.api.call('cancelCall', { params: { callId: call.id } });
    expect(await live()).toEqual({ call: null, meeting: null });
  });

  it('becomes a missed call when nobody answers, with a notification', async () => {
    const conversationId = await direct();
    const call = await owner.api.call('startCall', { body: { conversationId } });
    await timeoutCall(app.deps, call.id, new Date(Date.now() + 46_000));
    const missed = await owner.api.call('getCall', { params: { callId: call.id } });
    expect(missed).toMatchObject({ status: 'missed', durationSeconds: null });
    expect(missed.members[0]!.state).toBe('missed');
    expect((await lines(zeynep, conversationId)).at(-1)).toMatchObject({
      type: 'call_missed',
      actorId: ownerId,
      video: false,
      callOutcome: 'missed',
    });
    const bell = await zeynep.api.call('listNotifications', { query: {} });
    expect(bell.items.find((n) => n.type === 'meet.call_missed')).toMatchObject({
      url: `/chat/c/${conversationId}`,
    });
    // The ring itself never shows in the bell.
    expect(bell.items.some((n) => n.type === 'meet.call')).toBe(false);
  });

  it('declines (busy), cancels, and says busy when someone is in another call', async () => {
    const conversationId = await direct();
    const a = await owner.api.call('startCall', { body: { conversationId } });
    const declined = await zeynep.api.call('declineCall', {
      params: { callId: a.id },
      body: { busy: true },
    });
    expect(declined.status).toBe('declined');
    expect(declined.members[0]!.state).toBe('busy');
    expect((await lines(zeynep, conversationId)).at(-1)).toMatchObject({
      type: 'call_missed',
      callOutcome: 'busy',
    });

    const b = await owner.api.call('startCall', { body: { conversationId } });
    await expectCode(zeynep.api.call('cancelCall', { params: { callId: b.id } }), 'forbidden');
    expect((await owner.api.call('cancelCall', { params: { callId: b.id } })).status).toBe(
      'cancelled',
    );
    await expectCode(zeynep.api.call('answerCall', { params: { callId: b.id } }), 'meet_call_over');
    expect((await lines(zeynep, conversationId)).at(-1)).toMatchObject({
      callOutcome: 'cancelled',
    });

    // "Reddet": the chat says declined, not missed.
    const d = await owner.api.call('startCall', { body: { conversationId } });
    await zeynep.api.call('declineCall', { params: { callId: d.id }, body: {} });
    expect((await lines(owner, conversationId)).at(-1)).toMatchObject({
      type: 'call_missed',
      callOutcome: 'declined',
    });

    // Mert is on a call with Zeynep; calling Mert finds him busy.
    const mz = await direct(mert, zeynepId);
    const busyCall = await mert.api.call('startCall', { body: { conversationId: mz } });
    await zeynep.api.call('answerCall', { params: { callId: busyCall.id } });
    const om = await direct(owner, mertId);
    const c = await owner.api.call('startCall', { body: { conversationId: om } });
    expect(c.status).toBe('declined');
    expect(c.members[0]!.state).toBe('busy');
    expect((await lines(owner, om)).at(-1)).toMatchObject({ callOutcome: 'busy' });
    await endCallsOfMeeting(app.deps, busyCall.meetingId);
  });

  it('rings everybody in a group, and a third person turns a call into a meeting', async () => {
    const group = await owner.api.call('createConversation', {
      body: { type: 'group', userIds: [zeynepId, mertId], name: 'Sprint' },
    });
    const g = await owner.api.call('startCall', { body: { conversationId: group.id } });
    expect(g.conversationTitle).toBe('Sprint');
    expect(g.members.map((m) => m.user.id).sort()).toEqual([zeynepId, mertId].sort());
    expect(g.members.every((m) => m.state === 'ringing')).toBe(true);
    await owner.api.call('cancelCall', { params: { callId: g.id } });

    const conversationId = await direct();
    const call = await owner.api.call('startCall', { body: { conversationId } });
    await zeynep.api.call('answerCall', { params: { callId: call.id } });
    expect(call.upgraded).toBe(false);
    const rung = await zeynep.api.call('ringCall', {
      params: { callId: call.id },
      body: { userIds: [mertId] },
    });
    expect(rung.upgraded).toBe(true);
    expect(rung.members.find((m) => m.user.id === mertId)!.state).toBe('ringing');
    expect(callEvents(mertId, 'call.ringing').at(-1)).toMatchObject({ call: { id: call.id } });
    // The added person joins the room straight away: invited now.
    const joined = await mert.api.call('joinMeeting', {
      params: { meetingId: call.meetingId },
      body: {},
    });
    expect(joined.status).toBe('joined');
    await endCallsOfMeeting(app.deps, call.meetingId);
  });

  it('replaces an answered call whose room stayed empty (nobody could connect)', async () => {
    const conversationId = await direct();
    const first = await owner.api.call('startCall', { body: { conversationId } });
    await zeynep.api.call('answerCall', { params: { callId: first.id } });
    // Still fresh: calling again joins it.
    expect((await owner.api.call('startCall', { body: { conversationId } })).id).toBe(first.id);
    await app.deps.db
      .update(meetingCalls)
      .set({ answeredAt: new Date(Date.now() - 31_000) })
      .where(eq(meetingCalls.id, first.id));
    const second = await owner.api.call('startCall', { body: { conversationId } });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('ringing');
    expect((await owner.api.call('getCall', { params: { callId: first.id } })).status).toBe(
      'ended',
    );
    await owner.api.call('cancelCall', { params: { callId: second.id } });
  });

  it('only from direct and group chats you are in', async () => {
    const spaces = await owner.api.call('listSpaces');
    const spaceId = spaces.items.find((s) => s.kind !== 'personal')!.id;
    const space = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Duyurular' },
    });
    await expectCode(
      owner.api.call('startCall', { body: { conversationId: space.id } }),
      'meet_call_unavailable',
    );
    const conversationId = await direct();
    await expectCode(mert.api.call('startCall', { body: { conversationId } }), 'not_found');
    const rows = await app.deps.db
      .select()
      .from(meetingCalls)
      .where(eq(meetingCalls.conversationId, conversationId));
    expect(rows.every((r) => r.status !== 'ringing')).toBe(true);
  });
});

describe('Remote control of shared screens', () => {
  let app: TestApp;
  let lk: ReturnType<typeof fakeLiveKit>;
  let owner: Client;
  let ownerId: string;
  let member: Client;
  let memberId: string;

  beforeAll(async () => {
    app = await createTestApp();
    lk = fakeLiveKit();
    setLiveKit(app.deps, lk.gw);
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const m = await join(app, owner, 'zeynep@milvasoft.com', 'member');
    member = m.person;
    memberId = m.me.user.id;
  });
  afterAll(() => app.close());

  it('is on by default, a moderator turns it off for the room, the audit log keeps grants', async () => {
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Destek', settings: { guestsAllowed: false } },
    });
    expect(m.permissions.remoteControl).toBe(true);
    const room = `m-${m.id}`;
    await webhook(app, joinedEvent(room, MEET_IDENTITY.user(ownerId), 'Buğra', 'moderator'));

    // The sharing client reports a grant and a revoke.
    for (const event of ['granted', 'revoked'] as const) {
      await owner.api.call('reportRemoteControl', {
        params: { meetingId: m.id },
        body: { event, userId: memberId },
      });
    }
    const rows = await app.deps.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.targetId, m.id), eq(auditLogs.targetType, 'meeting')));
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['meet.remote_control.granted', 'meet.remote_control.revoked']),
    );
    expect(rows.find((r) => r.action === 'meet.remote_control.granted')!.meta).toMatchObject({
      controllerId: memberId,
    });

    // Members cannot turn it off; the moderator can, and the live room hears it at once.
    await expectCode(
      member.api.call('updateMeeting', {
        params: { meetingId: m.id },
        body: { settings: { remoteControl: false } },
      }),
      'meet_not_moderator',
    );
    const off = await owner.api.call('updateMeeting', {
      params: { meetingId: m.id },
      body: { settings: { remoteControl: false } },
    });
    expect(off.settings.remoteControl).toBe(false);
    expect(off.permissions.remoteControl).toBe(false);
    const meta = lk.calls.findLast((c) => c.op === 'updateRoomMetadata')!;
    expect(meta.args[0]).toBe(room);
    expect(JSON.parse(meta.args[1] as string)).toMatchObject({ remoteControl: false });
    await expectCode(
      owner.api.call('reportRemoteControl', {
        params: { meetingId: m.id },
        body: { event: 'granted', userId: memberId },
      }),
      'meet_remote_control_off',
    );
  });

  it('follows the org setting', async () => {
    const [org] = await app.deps.db.select().from(organizations);
    await app.deps.db
      .update(organizations)
      .set({ settings: { ...org!.settings, meetRemoteControl: false } })
      .where(eq(organizations.id, org!.id));
    invalidateModules();
    const m = await owner.api.call('createMeeting', {
      body: { mode: 'room', title: 'Kurum kapalı', settings: { guestsAllowed: false } },
    });
    expect(m.permissions.remoteControl).toBe(false);
    await expectCode(
      owner.api.call('reportRemoteControl', {
        params: { meetingId: m.id },
        body: { event: 'granted', userId: memberId },
      }),
      'meet_remote_control_off',
    );
  });
});
