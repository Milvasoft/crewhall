import { and, eq, inArray } from 'drizzle-orm';
import { ImapFlow, type SearchObject } from 'imapflow';
import { mailAccounts, mailBulkJobs, mailSettings, type DbOrTx } from '@crewhall/db';
import {
  MAIL_BULK_CHUNK,
  type MailBulkAction,
  type MailBulkJob,
  type StartMailBulk,
} from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { Jobs } from '../../jobs/queue';
import { userTopic } from '../../realtime/bus';
import { isModuleEnabled } from '../identity/modules';
import { dropRows, setFlags } from './cache';
import { accountAuth, type MailContext } from './accounts';
import { imapAddress, imapOptions, isAuthError, isUnreachable } from './imap';
import { lockFolder, specialFolder } from './folders';
import type { PollDeps } from './poll';

/**
 * Folder-wide changes ("mark all as read", "select every message in this folder"): the worker
 * searches the folder once and changes it 500 UIDs at a time, writing progress after each
 * chunk so the client can show "1.200 / 5.000". A separate IMAP connection keeps the user's
 * pooled one free while it runs.
 */

export type BulkJobRow = typeof mailBulkJobs.$inferSelect;

export const bulkView = (r: BulkJobRow): MailBulkJob => ({
  id: r.id,
  folder: r.folder,
  action: r.action,
  target: r.target,
  status: r.status,
  total: r.total,
  done: r.done,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/** What the job needs from an IMAP client; tests pass a fake. */
export type BulkClient = Pick<
  ImapFlow,
  'search' | 'messageFlagsAdd' | 'messageFlagsRemove' | 'messageMove' | 'messageDelete'
>;

const CRITERIA: Record<MailBulkAction, SearchObject> = {
  // Only what changes, so the progress counts real work.
  seen: { seen: false },
  unseen: { seen: true },
  move: { all: true },
  delete: { all: true },
};

/**
 * Runs one action over the selected folder in chunks. `destination` is the move target, or the
 * trash for `delete` (null deletes for good). Returns how many messages it changed.
 */
export async function applyBulk(
  c: BulkClient,
  action: MailBulkAction,
  destination: string | null,
  /** After each chunk; `part` are the UIDs the chunk changed. */
  onProgress: (done: number, total: number, part: number[]) => Promise<void>,
  chunk = MAIL_BULK_CHUNK,
): Promise<number> {
  const uids = [...((await c.search(CRITERIA[action], { uid: true })) || [])].sort((a, b) => a - b);
  await onProgress(0, uids.length, []);
  let done = 0;
  for (let i = 0; i < uids.length; i += chunk) {
    const part = uids.slice(i, i + chunk);
    if (action === 'seen') await c.messageFlagsAdd(part, ['\\Seen'], { uid: true });
    else if (action === 'unseen') await c.messageFlagsRemove(part, ['\\Seen'], { uid: true });
    else if (destination) await c.messageMove(part, destination, { uid: true });
    else await c.messageDelete(part, { uid: true });
    done += part.length;
    await onProgress(done, uids.length, part);
  }
  return done;
}

/** Queues a job (or returns the one already running for this folder and action). */
export async function startBulk(
  db: DbOrTx,
  jobs: Jobs,
  ctx: MailContext,
  input: StartMailBulk,
): Promise<MailBulkJob> {
  if (input.action === 'move' && input.target === input.folder) {
    throw new AppError('bad_request', { reason: 'same_folder' });
  }
  const [running] = await db
    .select()
    .from(mailBulkJobs)
    .where(
      and(
        eq(mailBulkJobs.accountId, ctx.account.id),
        eq(mailBulkJobs.folder, input.folder),
        eq(mailBulkJobs.action, input.action),
        inArray(mailBulkJobs.status, ['queued', 'running']),
      ),
    );
  if (running) return bulkView(running);
  const [row] = await db
    .insert(mailBulkJobs)
    .values({
      orgId: ctx.account.orgId,
      userId: ctx.account.userId,
      accountId: ctx.account.id,
      folder: input.folder,
      action: input.action,
      target: input.action === 'move' ? (input.target ?? null) : null,
    })
    .returning();
  await jobs.send('mail.bulk', { jobId: row!.id }, { singletonKey: `mail.bulk:${row!.id}` });
  // Inline jobs (tests) have finished by now: answer with the fresh row.
  const [fresh] = await db.select().from(mailBulkJobs).where(eq(mailBulkJobs.id, row!.id));
  return bulkView(fresh ?? row!);
}

export async function getBulk(db: DbOrTx, orgId: string, userId: string, jobId: string) {
  const [row] = await db
    .select()
    .from(mailBulkJobs)
    .where(
      and(
        eq(mailBulkJobs.id, jobId),
        eq(mailBulkJobs.orgId, orgId),
        eq(mailBulkJobs.userId, userId),
      ),
    );
  if (!row) throw new AppError('not_found');
  return bulkView(row);
}

function errorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  if (isAuthError(err)) return 'mail_auth_failed';
  if (isUnreachable(err)) return 'mail_server_unreachable';
  return 'internal';
}

/** Worker side of `mail.bulk`. Never throws: the outcome is written to the row. */
export async function runBulkJob(deps: PollDeps, jobId: string) {
  const { db } = deps;
  const [row] = await db
    .select({ job: mailBulkJobs, account: mailAccounts, settings: mailSettings })
    .from(mailBulkJobs)
    .innerJoin(mailAccounts, eq(mailAccounts.id, mailBulkJobs.accountId))
    .innerJoin(mailSettings, eq(mailSettings.orgId, mailBulkJobs.orgId))
    .where(eq(mailBulkJobs.id, jobId));
  if (!row || row.job.status !== 'queued') return;
  const finish = (set: Partial<BulkJobRow>) =>
    db
      .update(mailBulkJobs)
      .set({ ...set, finishedAt: new Date() })
      .where(eq(mailBulkJobs.id, jobId));
  if (!(await isModuleEnabled(db, row.job.orgId, 'mail', { fresh: true }))) {
    await finish({ status: 'failed', error: 'module_disabled' });
    return;
  }
  await db.update(mailBulkJobs).set({ status: 'running' }).where(eq(mailBulkJobs.id, jobId));

  let client: ImapFlow | null = null;
  try {
    const auth = await accountAuth(deps, row.settings, row.account);
    client = new ImapFlow(imapOptions(imapAddress(row.settings), auth));
    client.on('error', () => undefined);
    await client.connect();
    let destination: string | null = null;
    if (row.job.action === 'move') {
      const paths = (await client.list()).map((f) => f.path);
      if (!row.job.target || !paths.includes(row.job.target)) {
        throw new AppError('mail_folder_not_found');
      }
      destination = row.job.target;
    } else if (row.job.action === 'delete') {
      const trash = await specialFolder(client, 'trash', { create: true });
      destination = trash && trash !== row.job.folder ? trash : null;
    }
    const lock = await lockFolder(client, row.job.folder);
    try {
      const c = client;
      const owner = { orgId: row.job.orgId, accountId: row.account.id };
      await applyBulk(c, row.job.action, destination, async (done, total, part) => {
        // The header cache follows each chunk, so lists read from it stay right.
        if (row.job.action === 'seen' || row.job.action === 'unseen') {
          await setFlags(db, owner, row.job.folder, part, { seen: row.job.action === 'seen' });
        } else {
          await dropRows(db, owner, row.job.folder, part);
        }
        await db.update(mailBulkJobs).set({ done, total }).where(eq(mailBulkJobs.id, jobId));
      });
    } finally {
      lock.release();
    }
    await finish({ status: 'done' });
    deps.bus.publish(userTopic(row.job.userId), { type: 'mail.changed', folder: row.job.folder });
    if (destination) {
      deps.bus.publish(userTopic(row.job.userId), { type: 'mail.changed', folder: destination });
    }
  } catch (err) {
    const code = errorCode(err);
    if (code === 'internal') deps.logger.warn({ err, jobId }, 'mail bulk job failed');
    if (code === 'mail_auth_failed') {
      await db
        .update(mailAccounts)
        .set({ status: 'auth_failed' })
        .where(eq(mailAccounts.id, row.account.id));
    }
    await finish({ status: 'failed', error: code });
  } finally {
    client?.close();
  }
}
