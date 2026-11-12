import type { Db } from '@crewhall/db';
import { purgeWsTickets } from '../../realtime/tickets';
import { purgeOldNotifications } from '../notifications/center';
import { purgePushTickets } from '../notifications/push';
import { purgeDeliveries } from './webhooks';
import { purgeFederationInbox } from '../federation/inbox';

/** Nightly chat housekeeping: tickets, delivery log (30 d), notifications (90 d), federation inbox (1 d). */
export async function chatCleanup(db: Db) {
  await purgeWsTickets(db);
  await purgeDeliveries(db);
  await purgeOldNotifications(db);
  await purgePushTickets(db);
  await purgeFederationInbox(db);
}
