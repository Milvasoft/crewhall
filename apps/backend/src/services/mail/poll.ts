import { and, eq, ne, sql } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { mailAccounts, mailSettings, type Db } from '@crewhall/db';
import type { Env } from '../../env';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import type { Bus } from '../../realtime/bus';
import { isModuleEnabled } from '../identity/modules';
import { notify } from '../notifications/notify';
import { accountAuth, type MailAccountRow } from './accounts';
import { imapAddress, imapOptions, isAuthError, isUnreachable } from './imap';
import type { MailSettingsRow } from './settings';
import { paths, withQuery } from '@crewhall/shared';

/**
 * New-mail notifications (roadmap 24): the worker checks each connected INBOX every
 * MailServerSettings.pollMinutes with STATUS (UIDNEXT, UIDVALIDITY). Messages above the stored
 * watermark that are still unread become a notification; the first check only sets the mark.
 * Periodic checks instead of IMAP IDLE: one long-lived connection per user would not scale
 * for a worker that serves every org (docs/contracts/kararlar.md).
 */

export interface PollDeps {
  db: Db;
  env: Pick<Env, 'AUTH_SECRET' | 'API_URL' | 'HUB_URL'>;
  logger: Logger;
  jobs: Jobs;
  bus: Bus;
}

const CONCURRENCY = 4;
/** At most this many single notifications per check; more become one grouped row. */
const NOTIFY_MAX = 3;

export async function checkMailboxes(deps: PollDeps, now = new Date()) {
  const due = await deps.db
    .select({ account: mailAccounts, settings: mailSettings })
    .from(mailAccounts)
    .innerJoin(mailSettings, eq(mailSettings.orgId, mailAccounts.orgId))
    .where(
      and(
        ne(mailAccounts.status, 'auth_failed'),
        // Shared inboxes notify nobody by themselves (their space works the conversations).
        eq(mailAccounts.kind, 'personal'),
        eq(mailAccounts.authMode, mailSettings.authMode),
        sql`(${mailAccounts.lastCheckedAt} is null or ${mailAccounts.lastCheckedAt} <= ${now}::timestamptz - make_interval(mins => ${mailSettings.pollMinutes}) + interval '20 seconds')`,
      ),
    );
  const enabled = new Map<string, boolean>();
  const queue: { account: MailAccountRow; settings: MailSettingsRow }[] = [];
  for (const row of due) {
    let on = enabled.get(row.account.orgId);
    if (on === undefined) {
      on = await isModuleEnabled(deps.db, row.account.orgId, 'mail', { fresh: true });
      enabled.set(row.account.orgId, on);
    }
    if (on) queue.push(row);
  }
  let checked = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await checkOne(deps, next.settings, next.account).catch((err: unknown) =>
        deps.logger.warn({ err, accountId: next?.account.id }, 'mail check failed'),
      );
      checked += 1;
    }
  });
  await Promise.all(workers);
  return checked;
}

interface NewMessage {
  uid: number;
  subject: string;
  from: string;
}

export async function checkOne(deps: PollDeps, settings: MailSettingsRow, account: MailAccountRow) {
  let client: ImapFlow | null = null;
  let fresh: NewMessage[] = [];
  let mark: { uidValidity: number; lastUid: number };
  try {
    const auth = await accountAuth(deps, settings, account);
    client = new ImapFlow(imapOptions(imapAddress(settings), auth));
    client.on('error', () => undefined);
    await client.connect();
    const status = await client.status('INBOX', { uidNext: true, uidValidity: true });
    if (!status) throw Object.assign(new Error('no INBOX status'), { code: 'NoConnection' });
    const uidValidity = Number(status.uidValidity ?? 0);
    const lastUid = Math.max(0, (status.uidNext ?? 1) - 1);
    mark = { uidValidity, lastUid };
    const known =
      account.inboxUidValidity === uidValidity && account.inboxLastUid !== null
        ? account.inboxLastUid
        : null;
    if (known !== null && lastUid > known && account.notify) {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        const rows = await client.fetchAll(
          `${known + 1}:*`,
          { uid: true, envelope: true, flags: true },
          { uid: true },
        );
        fresh = rows
          .filter((m) => m.uid > known && !m.flags?.has('\\Seen'))
          .sort((a, b) => b.uid - a.uid)
          .map((m) => ({
            uid: m.uid,
            subject: m.envelope?.subject ?? '',
            from: m.envelope?.from?.[0]?.name || m.envelope?.from?.[0]?.address || '',
          }));
      } finally {
        lock.release();
      }
    }
  } catch (err) {
    const status = isAuthError(err) ? 'auth_failed' : isUnreachable(err) ? 'unreachable' : null;
    await deps.db
      .update(mailAccounts)
      .set({ lastCheckedAt: new Date(), ...(status ? { status } : {}) })
      .where(eq(mailAccounts.id, account.id));
    if (!status) throw err;
    return { notified: 0 };
  } finally {
    client?.close();
  }

  await deps.db
    .update(mailAccounts)
    .set({
      status: 'ok',
      lastCheckedAt: new Date(),
      inboxUidValidity: mark.uidValidity,
      inboxLastUid: mark.lastUid,
    })
    .where(eq(mailAccounts.id, account.id));
  if (fresh.length === 0) return { notified: 0 };

  const shown = fresh.length > NOTIFY_MAX ? fresh.slice(0, 1) : fresh;
  await notify(
    deps,
    shown.map((m) => ({
      orgId: account.orgId,
      userId: account.userId,
      type: 'mail.new',
      category: 'alert' as const,
      actorId: null,
      target: { type: 'link' as const, id: account.id },
      data: {
        name: m.subject,
        title: m.subject,
        authorName: m.from,
        excerpt: m.subject,
        count: fresh.length,
      },
      url: withQuery(paths.mail(), { folder: 'INBOX', uid: m.uid }),
      groupKey: `mail:${account.id}`,
    })),
  );
  return { notified: fresh.length };
}
