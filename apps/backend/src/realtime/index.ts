import type { Server } from 'node:http';
import type { DbHandle } from '@crewhall/db';
import type { Logger } from '../logger';
import { listenBus, LocalBus, type Bus } from './bus';
import { Gateway, type GatewayHooks } from './gateway';
import { PresenceTracker } from './presence';

export { publishToUsers, userTopic, presenceTopic, type Bus } from './bus';
export type { PresenceReader } from './presence';

/** Bus, presence and the `/ws` gateway of one api process. */
export interface Realtime {
  bus: Bus;
  presence: PresenceTracker;
  gateway: Gateway;
  /** Accept WebSocket upgrades on this http server. */
  attach(server: Server): void;
  close(): Promise<void>;
}

export async function createRealtime(opts: {
  handle: DbHandle;
  logger: Logger;
  hooks: GatewayHooks;
  /** Relay events published by a separate worker process (Postgres NOTIFY). */
  listen: boolean;
  offlineGraceMs?: number;
}): Promise<Realtime> {
  const { handle, logger } = opts;
  const bus = new LocalBus(logger);
  const presence = new PresenceTracker(bus, handle.db, logger, opts.offlineGraceMs);
  const gateway = new Gateway({ db: handle.db, bus, presence, logger, hooks: opts.hooks });
  const listener = opts.listen ? await listenBus(handle.pool, bus, logger) : null;
  return {
    bus,
    presence,
    gateway,
    attach: (server) => gateway.attach(server),
    async close() {
      await gateway.close();
      presence.close();
      await listener?.stop();
    },
  };
}
