import {
  AccessToken,
  DataPacket_Kind,
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  WebhookReceiver,
  type VideoGrant,
} from 'livekit-server-sdk';
import type { MeetingGrants, MeetParticipantMeta, MeetSignal } from '@crewhall/shared';
import { MEET_LIMITS, MEET_SIGNAL_TOPIC } from '@crewhall/shared';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { loadMeetConfig, type MeetConfig } from './config';

/**
 * Everything the meet module asks of LiveKit (doc 17 §2): access tokens, room control,
 * egress and webhook verification. Tests swap the room calls for a recorder with
 * setLiveKit(); tokens and webhook signatures always use the real SDK.
 */

export interface TokenInput {
  roomName: string;
  identity: string;
  name: string;
  metadata: MeetParticipantMeta;
  grants: MeetingGrants;
  ttlSeconds?: number;
}

export type TrackKind = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio' | 'unknown';

export interface LiveRoom {
  name: string;
  sid: string;
  numParticipants: number;
}

export interface LiveParticipant {
  identity: string;
  /** LiveKit's id for this connection; the same one its webhooks carry. */
  sid?: string;
  joinedAt?: Date | null;
  name: string;
  metadata: string;
  tracks: { sid: string; source: TrackKind; muted: boolean }[];
}

export type EgressState =
  'starting' | 'active' | 'ending' | 'complete' | 'failed' | 'aborted' | 'limit_reached';

/** A verified webhook, flattened from the protobuf event. */
export interface MeetWebhookEvent {
  id: string;
  event: string;
  createdAt: Date;
  room: { sid: string; name: string } | null;
  participant: {
    sid: string;
    identity: string;
    name: string;
    metadata: string;
    joinedAt: Date | null;
  } | null;
  /** track_published / track_unpublished. */
  track: { sid: string; source: TrackKind } | null;
  egress: {
    egressId: string;
    roomName: string;
    status: EgressState;
    error: string | null;
    durationSeconds: number | null;
    sizeBytes: number | null;
  } | null;
}

export interface LiveKitGateway {
  readonly publicUrl: string;
  readonly egressEnabled: boolean;
  createToken(input: TokenInput): Promise<string>;
  receiveWebhook(body: string, authorization: string | undefined): Promise<MeetWebhookEvent>;
  ensureRoom(roomName: string, metadata: string): Promise<void>;
  updateRoomMetadata(roomName: string, metadata: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  sendSignal(roomName: string, signal: MeetSignal, identities?: string[]): Promise<void>;
  listParticipants(roomName: string): Promise<LiveParticipant[]>;
  /** Every room on the server, which may be shared with other projects. */
  listRooms(): Promise<LiveRoom[]>;
  muteTrack(roomName: string, identity: string, trackSid: string): Promise<void>;
  updateParticipant(
    roomName: string,
    identity: string,
    update: { attributes?: Record<string, string>; metadata?: string; grants?: MeetingGrants },
  ): Promise<void>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  startRecording(
    roomName: string,
    input: { storageKey: string; audioOnly: boolean },
  ): Promise<{ egressId: string }>;
  stopRecording(egressId: string): Promise<void>;
}

const SOURCE_NAMES: Record<number, TrackKind> = {
  [TrackSource.CAMERA]: 'camera',
  [TrackSource.MICROPHONE]: 'microphone',
  [TrackSource.SCREEN_SHARE]: 'screen_share',
  [TrackSource.SCREEN_SHARE_AUDIO]: 'screen_share_audio',
};

const EGRESS_STATES: Record<number, EgressState> = {
  [EgressStatus.EGRESS_STARTING]: 'starting',
  [EgressStatus.EGRESS_ACTIVE]: 'active',
  [EgressStatus.EGRESS_ENDING]: 'ending',
  [EgressStatus.EGRESS_COMPLETE]: 'complete',
  [EgressStatus.EGRESS_FAILED]: 'failed',
  [EgressStatus.EGRESS_ABORTED]: 'aborted',
  [EgressStatus.EGRESS_LIMIT_REACHED]: 'limit_reached',
};

/** MeetingGrants → LiveKit video grant fields. */
export function videoGrant(roomName: string, g: MeetingGrants): VideoGrant {
  const sources = g.publish
    ? [
        TrackSource.CAMERA,
        TrackSource.MICROPHONE,
        ...(g.screenShare ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
      ]
    : [];
  return {
    room: roomName,
    roomJoin: true,
    roomAdmin: g.roomAdmin,
    canPublish: g.publish,
    canPublishSources: sources,
    canSubscribe: g.subscribe,
    canPublishData: g.publishData,
    // Raised hand and away status are attributes the client sets on itself.
    canUpdateOwnMetadata: true,
  };
}

const seconds = (v: bigint | number | undefined) => (v ? Number(v) : 0);

/** Token signing and webhook verification: plain crypto, no LiveKit server needed. */
export function liveKitSigning(config: Pick<MeetConfig, 'apiKey' | 'apiSecret'>) {
  const receiver = new WebhookReceiver(config.apiKey, config.apiSecret);
  return {
    async createToken(input: TokenInput) {
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: input.identity,
        name: input.name,
        metadata: JSON.stringify(input.metadata),
        ttl: input.ttlSeconds ?? MEET_LIMITS.tokenSeconds,
      });
      at.addGrant(videoGrant(input.roomName, input.grants));
      return at.toJwt();
    },
    async receiveWebhook(body: string, authorization: string | undefined) {
      const e = await receiver.receive(body, authorization);
      const egress = e.egressInfo;
      const file = egress?.fileResults?.[0];
      return {
        id: e.id,
        event: e.event,
        createdAt: new Date(seconds(e.createdAt) * 1000 || Date.now()),
        room: e.room ? { sid: e.room.sid, name: e.room.name } : null,
        participant: e.participant
          ? {
              sid: e.participant.sid,
              identity: e.participant.identity,
              name: e.participant.name,
              metadata: e.participant.metadata,
              joinedAt: e.participant.joinedAt
                ? new Date(seconds(e.participant.joinedAt) * 1000)
                : null,
            }
          : null,
        track: e.track
          ? { sid: e.track.sid, source: SOURCE_NAMES[e.track.source] ?? 'unknown' }
          : null,
        egress: egress
          ? {
              egressId: egress.egressId,
              roomName: egress.roomName,
              status: EGRESS_STATES[egress.status] ?? 'failed',
              error: egress.error || null,
              // File duration is in nanoseconds.
              durationSeconds: file?.duration ? Math.round(Number(file.duration) / 1e9) : null,
              sizeBytes: file?.size ? Number(file.size) : null,
            }
          : null,
      } satisfies MeetWebhookEvent;
    },
  };
}

export function createLiveKitGateway(config: MeetConfig, env: Env): LiveKitGateway {
  const rooms = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret);
  const egress = new EgressClient(config.apiUrl, config.apiKey, config.apiSecret);
  const signing = liveKitSigning(config);
  const s3Endpoint = config.egressS3Endpoint ?? env.S3_ENDPOINT;

  return {
    publicUrl: config.publicUrl,
    egressEnabled: config.egressEnabled && Boolean(s3Endpoint && env.S3_ACCESS_KEY),
    ...signing,
    async ensureRoom(roomName, metadata) {
      await rooms.createRoom({
        name: roomName,
        metadata,
        // Design 07: the room closes 2 minutes after the last person left.
        departureTimeout: MEET_LIMITS.emptyRoomSeconds,
        emptyTimeout: 5 * 60,
      });
    },
    async updateRoomMetadata(roomName, metadata) {
      await rooms.updateRoomMetadata(roomName, metadata);
    },
    async deleteRoom(roomName) {
      await rooms.deleteRoom(roomName);
    },
    async sendSignal(roomName, signal, identities) {
      await rooms.sendData(
        roomName,
        new TextEncoder().encode(JSON.stringify(signal)),
        DataPacket_Kind.RELIABLE,
        { topic: MEET_SIGNAL_TOPIC, destinationIdentities: identities },
      );
    },
    async listParticipants(roomName) {
      const list = await rooms.listParticipants(roomName);
      return list.map((p) => ({
        identity: p.identity,
        sid: p.sid,
        joinedAt: p.joinedAt ? new Date(seconds(p.joinedAt) * 1000) : null,
        name: p.name,
        metadata: p.metadata,
        tracks: p.tracks.map((t) => ({
          sid: t.sid,
          source: SOURCE_NAMES[t.source] ?? 'unknown',
          muted: t.muted,
        })),
      }));
    },
    async listRooms() {
      const list = await rooms.listRooms();
      return list.map((r) => ({
        name: r.name,
        sid: r.sid,
        numParticipants: r.numParticipants,
      }));
    },
    async muteTrack(roomName, identity, trackSid) {
      await rooms.mutePublishedTrack(roomName, identity, trackSid, true);
    },
    async updateParticipant(roomName, identity, update) {
      const grant = update.grants ? videoGrant(roomName, update.grants) : null;
      await rooms.updateParticipant(roomName, identity, {
        attributes: update.attributes,
        metadata: update.metadata,
        permission: grant
          ? {
              canPublish: grant.canPublish,
              canSubscribe: grant.canSubscribe,
              canPublishData: grant.canPublishData,
              canPublishSources: grant.canPublishSources,
              canUpdateMetadata: true,
            }
          : undefined,
      });
    },
    async removeParticipant(roomName, identity) {
      await rooms.removeParticipant(roomName, identity);
    },
    async startRecording(roomName, input) {
      const output = new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: input.storageKey,
        output: {
          case: 's3',
          value: new S3Upload({
            accessKey: env.S3_ACCESS_KEY ?? '',
            secret: env.S3_SECRET_KEY ?? '',
            region: env.S3_REGION,
            endpoint: s3Endpoint ?? '',
            bucket: env.S3_BUCKET,
            forcePathStyle: true,
          }),
        },
      });
      // Design 7.10: speaker layout, 1080p; audio only gives an M4A.
      const info = await egress.startRoomCompositeEgress(roomName, output, {
        layout: 'speaker',
        audioOnly: input.audioOnly,
      });
      return { egressId: info.egressId };
    },
    async stopRecording(egressId) {
      await egress.stopEgress(egressId);
    },
  };
}

const gateways = new WeakMap<object, LiveKitGateway | null>();

/** The LiveKit gateway of this server (null: not configured). */
export function liveKit(deps: Pick<Deps, 'env' | 'db'>): LiveKitGateway | null {
  if (gateways.has(deps.db)) return gateways.get(deps.db) ?? null;
  const config = loadMeetConfig();
  const gw = config ? createLiveKitGateway(config, deps.env) : null;
  gateways.set(deps.db, gw);
  return gw;
}

/** Tests: use this gateway (or none) for the server built on `deps`. */
export function setLiveKit(deps: Pick<Deps, 'db'>, gateway: LiveKitGateway | null) {
  gateways.set(deps.db, gateway);
}
