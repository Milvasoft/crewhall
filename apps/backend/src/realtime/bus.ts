import type pg from 'pg';
import type { WsServerEvent } from '@crewhall/shared';
import type { Logger } from '../logger';

/**
 * Event distribution between the code that changes data and the WebSocket connections
 * (doc 17 §6). Topics:
 * - `user:<id>`     everything for one person (messages, reads, notifications, nodes…)
 * - `presence:<id>` presence changes of one person (watched by clients showing them)
 *
 * One api node: an in-process emitter. A separate worker process publishes through
 * Postgres NOTIFY and the api relays it locally; several api nodes would swap this for
 * Valkey pub/sub behind the same interface.
 */
export interface Bus {
  publish(topic: string, event: WsServerEvent): void;
  subscribe(topic: string, handler: (event: WsServerEvent) => void): () => void;
}

export const userTopic = (userId: string) => `user:${userId}`;
export const presenceTopic = (userId: string) => `presence:${userId}`;

/** Same event to many people. */
export function publishToUsers(bus: Bus, userIds: Iterable<string>, event: WsServerEvent) {
  for (const id of new Set(userIds)) bus.publish(userTopic(id), event);
}

export class LocalBus implements Bus {
  private readonly topics = new Map<string, Set<(event: WsServerEvent) => void>>();

  constructor(private readonly logger?: Logger) {}

  publish(topic: string, event: WsServerEvent) {
    const handlers = this.topics.get(topic);
    if (!handlers) return;
    for (const h of [...handlers]) {
      try {
        h(event);
      } catch (err) {
        this.logger?.warn({ err, topic }, 'bus handler failed');
      }
    }
  }

  subscribe(topic: string, handler: (event: WsServerEvent) => void) {
    let set = this.topics.get(topic);
    if (!set) this.topics.set(topic, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.topics.delete(topic);
    };
  }

  /** Subscribed topics, for tests and diagnostics. */
  get size() {
    return this.topics.size;
  }
}

export const BUS_CHANNEL = 'crewhall_bus';
/** NOTIFY payloads are limited to 8000 bytes; larger events ask clients to resync. */
const MAX_NOTIFY_BYTES = 7800;

/** Worker side: publish into the api's bus through NOTIFY. */
export function notifyBus(pool: pg.Pool, logger: Logger): Bus {
  return {
    publish(topic, event) {
      let payload = JSON.stringify({ topic, event });
      if (Buffer.byteLength(payload) > MAX_NOTIFY_BYTES) {
        payload = JSON.stringify({ topic, event: { type: 'resync' } });
      }
      pool
        .query('select pg_notify($1, $2)', [BUS_CHANNEL, payload])
        .catch((err: unknown) => logger.warn({ err, topic }, 'bus notify failed'));
    },
    subscribe() {
      throw new Error('the worker bus only publishes');
    },
  };
}

/** Api side: relay NOTIFY events from other processes into the local bus. */
export async function listenBus(pool: pg.Pool, bus: Bus, logger: Logger) {
  let client: pg.PoolClient | null = null;
  let stopped = false;
  const connect = async () => {
    try {
      client = await pool.connect();
      client.on('notification', (msg) => {
        if (msg.channel !== BUS_CHANNEL || !msg.payload) return;
        try {
          const { topic, event } = JSON.parse(msg.payload) as {
            topic: string;
            event: WsServerEvent;
          };
          bus.publish(topic, event);
        } catch (err) {
          logger.warn({ err }, 'bad bus notification');
        }
      });
      client.on('error', (err) => {
        logger.warn({ err }, 'bus listener lost its connection');
        client?.release(true);
        client = null;
        if (!stopped) setTimeout(() => void connect(), 2000);
      });
      await client.query(`listen ${BUS_CHANNEL}`);
    } catch (err) {
      logger.warn({ err }, 'bus listener could not connect');
      client?.release(true);
      client = null;
      if (!stopped) setTimeout(() => void connect(), 5000);
    }
  };
  await connect();
  return {
    async stop() {
      stopped = true;
      if (client) {
        await client.query(`unlisten ${BUS_CHANNEL}`).catch(() => undefined);
        client.release();
        client = null;
      }
    },
  };
}
