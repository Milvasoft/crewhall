import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { CHAT_LIMITS, WS_CLOSE, WsClientEvent, type WsServerEvent } from '@crewhall/shared';
import type { Db } from '@crewhall/db';
import { newId } from '@crewhall/db';
import type { Logger } from '../logger';
import { presenceTopic, userTopic, type Bus } from './bus';
import type { PresenceTracker, StatusChoice } from './presence';
import { consumeWsTicket } from './tickets';

/**
 * `/ws` (doc 17 §6): read-only event stream per person. Clients write over HTTP; the only
 * client messages are heartbeat, typing and the presence watch list.
 */

export interface GatewayHooks {
  /** People to tell that `userId` types in the conversation; null when not a member. */
  typingRecipients(orgId: string, userId: string, conversationId: string): Promise<string[] | null>;
  /** Saved status of the person (chat_user_settings). */
  statusChoice(orgId: string, userId: string): Promise<StatusChoice | null>;
  /** In a live meeting or call (presence "Toplantıda"); false without the meet module. */
  inMeeting?(orgId: string, userId: string): Promise<boolean>;
  /** Loads what allows() needs for the org (module switches) before events flow. */
  prime(orgId: string): Promise<void>;
  /** False for events of a module the org turned off (synchronous: keeps the order). */
  allows(orgId: string, event: WsServerEvent): boolean;
}

export interface GatewayOptions {
  db: Db;
  bus: Bus;
  presence: PresenceTracker;
  logger: Logger;
  hooks: GatewayHooks;
  /** Missed-heartbeat limit before closing (default 2.5 × 25 s). */
  idleTimeoutMs?: number;
}

/** Above this many unsent bytes events are dropped and the client is told to resync. */
const MAX_BUFFERED = 2 * 1024 * 1024;
/** What a client may send before its connection is set up (a heartbeat and a watch list). */
const MAX_EARLY_MESSAGES = 8;
const MAX_CLIENT_MESSAGE = 16 * 1024;
const TYPING_MIN_INTERVAL_MS = 1000;

export class Gateway {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE });
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly opts: GatewayOptions) {}

  /** Handles HTTP upgrades on `/ws` of a node http server. */
  attach(server: Server) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return;
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        void this.accept(ws, url.searchParams.get('ticket') ?? '');
      });
    });
  }

  get connectionCount() {
    return this.sockets.size;
  }

  async close() {
    for (const ws of this.sockets) ws.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private async accept(ws: WebSocket, ticket: string) {
    const { db, bus, presence, logger, hooks } = this.opts;
    // A client writes as soon as the socket opens (heartbeat, presence.watch): ws drops what
    // arrives with no listener, and a heartbeat before presence.connect has no connection to
    // land on, so these wait until the connection is set up.
    let onMessage: ((raw: RawData) => void) | null = null;
    const early: RawData[] = [];
    ws.on('message', (raw) => {
      if (onMessage) onMessage(raw);
      else if (early.length < MAX_EARLY_MESSAGES) early.push(raw);
    });
    const owner = await consumeWsTicket(db, ticket).catch((err: unknown) => {
      logger.warn({ err }, 'ws ticket check failed');
      return null;
    });
    if (!owner) {
      ws.close(WS_CLOSE.ticketInvalid, 'ws_ticket_invalid');
      return;
    }
    await hooks.prime(owner.orgId).catch(() => undefined);
    if (ws.readyState !== ws.OPEN) return;
    const { orgId, userId } = owner;
    const connId = newId();
    this.sockets.add(ws);

    let dropped = false;
    const send = (event: WsServerEvent) => {
      if (ws.readyState !== ws.OPEN) return;
      if (!hooks.allows(orgId, event)) return;
      if (ws.bufferedAmount > MAX_BUFFERED) {
        dropped = true;
        return;
      }
      if (dropped) {
        dropped = false;
        ws.send(JSON.stringify({ type: 'resync' }));
      }
      ws.send(JSON.stringify(event));
    };

    const subs: (() => void)[] = [bus.subscribe(userTopic(userId), send)];
    const watched = new Map<string, () => void>();

    const idleMs = this.opts.idleTimeoutMs ?? CHAT_LIMITS.heartbeatSeconds * 2500;
    let idle = setTimeout(() => ws.close(WS_CLOSE.timeout, 'heartbeat timeout'), idleMs);
    const lastTyping = new Map<string, number>();

    const handle = (raw: RawData) => {
      clearTimeout(idle);
      idle = setTimeout(() => ws.close(WS_CLOSE.timeout, 'heartbeat timeout'), idleMs);
      let parsed: WsClientEvent;
      try {
        const text = Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf8')
          : Buffer.from(raw as ArrayBuffer).toString('utf8');
        const result = WsClientEvent.safeParse(JSON.parse(text));
        if (!result.success) throw new Error('invalid');
        parsed = result.data;
      } catch {
        send({ type: 'error', code: 'bad_request', message: 'invalid event' });
        return;
      }
      switch (parsed.type) {
        case 'heartbeat':
          presence.heartbeat(
            connId,
            userId,
            parsed.active,
            parsed.focused,
            parsed.activeConversationId,
            { client: parsed.client, idleSeconds: parsed.idleSeconds, locked: parsed.locked },
          );
          return;
        case 'presence.watch': {
          const next = new Set(parsed.userIds);
          for (const [id, unsub] of watched) {
            if (!next.has(id)) {
              unsub();
              watched.delete(id);
            }
          }
          for (const id of next) {
            if (watched.has(id)) continue;
            watched.set(id, bus.subscribe(presenceTopic(id), send));
            // Current state of connected people right away; the rest are offline.
            const now = presence.get(id);
            if (now) send({ type: 'presence', presence: now });
          }
          return;
        }
        case 'typing': {
          const now = Date.now();
          if (now - (lastTyping.get(parsed.conversationId) ?? 0) < TYPING_MIN_INTERVAL_MS) return;
          lastTyping.set(parsed.conversationId, now);
          const conversationId = parsed.conversationId;
          void hooks
            .typingRecipients(orgId, userId, conversationId)
            .then((recipients) => {
              if (!recipients) return;
              const expiresAt = new Date(now + CHAT_LIMITS.typingSeconds * 1000).toISOString();
              for (const r of recipients) {
                if (r === userId) continue;
                bus.publish(userTopic(r), { type: 'typing', conversationId, userId, expiresAt });
              }
            })
            .catch((err: unknown) => logger.warn({ err }, 'typing fan-out failed'));
          return;
        }
      }
    };

    ws.on('close', () => {
      clearTimeout(idle);
      for (const unsub of subs) unsub();
      for (const unsub of watched.values()) unsub();
      watched.clear();
      this.sockets.delete(ws);
      presence.disconnect(connId, userId);
    });
    ws.on('error', (err) => logger.debug({ err }, 'ws error'));

    const [choice, meeting] = await Promise.all([
      hooks.statusChoice(orgId, userId).catch(() => null),
      hooks.inMeeting?.(orgId, userId).catch(() => false) ?? false,
    ]);
    if (meeting) presence.setMeeting(userId, true, choice);
    presence.connect(connId, userId, choice);
    send({
      type: 'ready',
      userId,
      orgId,
      serverTime: new Date().toISOString(),
      heartbeatSeconds: CHAT_LIMITS.heartbeatSeconds,
    });
    onMessage = handle;
    for (const raw of early.splice(0)) handle(raw);
  }
}
