import { dispose, Room, RoomEvent, type RemoteParticipant } from '@livekit/rtc-node';
import { lookup } from 'node:dns/promises';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEET_IDENTITY, MEET_SIGNAL_TOPIC, MeetRoomMeta } from '@crewhall/shared';
import { createLiveKitGateway, setLiveKit } from '../src/services/meet/livekit';
import { createTestApp, join, setupWithOwner, type Client, type TestApp } from './helpers';

/**
 * Smoke test against a real LiveKit server (Testcontainers): two headless participants
 * (@livekit/rtc-node) join with tokens from the api, see each other, exchange a data
 * message on the meet topic, get the recording state as room metadata and one of them is
 * removed by the moderator. Media goes over ICE/TCP on a fixed port, which works through
 * Docker Desktop's port mapping. MEET_SMOKE=0 skips it.
 *
 * LiveKit announces NODE_IP as its ICE candidate, so it must be the address this process
 * reaches the container on: 127.0.0.1 with Docker Desktop, but the Docker gateway when the
 * tests themselves run in a container (a CI agent using the host's Docker socket), where
 * 127.0.0.1 is the agent and the peer connection times out. MEET_SMOKE_NODE_IP overrides it.
 */
const KEY = 'smoke';
const SECRET = 'smoke-secret-0123456789abcdef0123456789';
const TCP_PORT = 17881;
const skip = process.env.MEET_SMOKE === '0';

const config = `
port: 7880
rtc:
  tcp_port: ${TCP_PORT}
  port_range_start: 17900
  port_range_end: 17910
  use_external_ip: false
keys:
  ${KEY}: ${SECRET}
logging:
  level: warn
`;

/** The IPv4 address the test process reaches containers on (see the note above). */
async function containerHostIp(): Promise<string> {
  if (process.env.MEET_SMOKE_NODE_IP) return process.env.MEET_SMOKE_NODE_IP;
  const host = (await getContainerRuntimeClient()).info.containerRuntime.host;
  if (host === 'localhost') return '127.0.0.1';
  return (await lookup(host, { family: 4 })).address;
}

function waitFor<T>(
  what: string,
  check: () => T | undefined | null | false,
  ms = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

describe.skipIf(skip)('Meet on a real LiveKit server', () => {
  let livekit: StartedTestContainer;
  let app: TestApp;
  let owner: Client;
  let member: Client;
  let memberId: string;
  let ownerId: string;
  let url: string;
  const rooms: Room[] = [];

  beforeAll(async () => {
    livekit = await new GenericContainer('livekit/livekit-server:v1.9.1')
      .withEnvironment({ LIVEKIT_CONFIG: config, NODE_IP: await containerHostIp() })
      .withExposedPorts(7880, { container: TCP_PORT, host: TCP_PORT })
      .withWaitStrategy(Wait.forHttp('/', 7880))
      .withStartupTimeout(120_000)
      .start();
    url = `http://${livekit.getHost()}:${livekit.getMappedPort(7880)}`;
    app = await createTestApp();
    setLiveKit(
      app.deps,
      createLiveKitGateway(
        {
          apiUrl: url,
          publicUrl: url.replace(/^http/, 'ws'),
          apiKey: KEY,
          apiSecret: SECRET,
          egressEnabled: false,
          egressS3Endpoint: null,
        },
        app.env,
      ),
    );
    const setup = await setupWithOwner(app);
    owner = setup.owner;
    ownerId = setup.ownerId;
    const m = await join(app, owner, 'mert@milvasoft.com', 'member');
    member = m.person;
    memberId = m.me.user.id;
  }, 180_000);

  afterAll(async () => {
    for (const r of rooms) await r.disconnect().catch(() => undefined);
    await dispose().catch(() => undefined);
    await app?.close();
    await livekit?.stop();
  });

  it('connects two participants who see each other and share data', async () => {
    const meeting = await owner.api.call('createMeeting', {
      body: { mode: 'instant', title: 'Duman testi' },
    });
    const a = await owner.api.call('joinMeeting', { params: { meetingId: meeting.id }, body: {} });
    const b = await member.api.call('joinMeeting', { params: { meetingId: meeting.id }, body: {} });
    if (a.status !== 'joined' || b.status !== 'joined') throw new Error('both should join');

    const roomA = new Room();
    const roomB = new Room();
    rooms.push(roomA, roomB);
    const received: { topic?: string; text: string; from?: string }[] = [];
    roomA.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
        received.push({
          topic,
          text: new TextDecoder().decode(payload),
          from: participant?.identity,
        });
      },
    );

    await roomA.connect(a.connection.url, a.connection.token, {
      autoSubscribe: true,
      dynacast: false,
    });
    await roomB.connect(b.connection.url, b.connection.token, {
      autoSubscribe: true,
      dynacast: false,
    });

    await waitFor('A to see B', () => roomA.remoteParticipants.get(MEET_IDENTITY.user(memberId)));
    await waitFor('B to see A', () => roomB.remoteParticipants.get(MEET_IDENTITY.user(ownerId)));
    const seenByB = roomB.remoteParticipants.get(MEET_IDENTITY.user(ownerId))!;
    expect(seenByB.name).toBe('Ahmet Buğra Kösen');
    expect(JSON.parse(seenByB.metadata ?? '{}')).toMatchObject({ role: 'moderator', guest: false });

    // Reactions and hands travel on the data channel (design 7.6).
    const signal = JSON.stringify({ type: 'reaction', emoji: '👏' });
    await roomB.localParticipant!.publishData(new TextEncoder().encode(signal), {
      reliable: true,
      topic: MEET_SIGNAL_TOPIC,
    });
    await waitFor('the reaction', () => received.find((r) => r.topic === MEET_SIGNAL_TOPIC));
    expect(received[0]).toMatchObject({ text: signal, from: MEET_IDENTITY.user(memberId) });

    // The api sees both through the RoomService.
    const lk = await createLiveKitGateway(
      {
        apiUrl: url,
        publicUrl: url,
        apiKey: KEY,
        apiSecret: SECRET,
        egressEnabled: false,
        egressS3Endpoint: null,
      },
      app.env,
    ).listParticipants(a.connection.roomName);
    expect(lk.map((p) => p.identity).sort()).toEqual(
      [MEET_IDENTITY.user(ownerId), MEET_IDENTITY.user(memberId)].sort(),
    );

    // Room metadata reaches everybody (recording indicator uses it).
    const meta = JSON.stringify({ meetingId: meeting.id, recording: null });
    await createLiveKitGateway(
      {
        apiUrl: url,
        publicUrl: url,
        apiKey: KEY,
        apiSecret: SECRET,
        egressEnabled: false,
        egressS3Endpoint: null,
      },
      app.env,
    ).updateRoomMetadata(a.connection.roomName, meta);
    await waitFor('room metadata', () => roomB.metadata === meta);
    expect(MeetRoomMeta.safeParse(JSON.parse(roomB.metadata!)).success).toBe(true);

    // The moderator removes the member; their connection ends (design 7.8).
    let disconnected = false;
    roomB.on(RoomEvent.Disconnected, () => {
      disconnected = true;
    });
    await owner.api.call('moderateMeetingParticipant', {
      params: { meetingId: meeting.id },
      body: { identity: MEET_IDENTITY.user(memberId), action: 'remove' },
    });
    await waitFor('B to be removed', () => disconnected);
    await waitFor('A to lose B', () => !roomA.remoteParticipants.get(MEET_IDENTITY.user(memberId)));
    // Back with the same link: the lobby (design 7.8).
    const again = await member.api.call('joinMeeting', {
      params: { meetingId: meeting.id },
      body: {},
    });
    expect(again.status).toBe('lobby');
  }, 90_000);
});
