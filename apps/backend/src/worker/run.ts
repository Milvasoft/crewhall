import type { PgBoss } from 'pg-boss';
import { runJob, type JobDeps } from '../jobs/handlers';
import { JOB_NAMES, type JobName, type JobPayloads } from '../jobs/queue';
import { onLinkStatusChange } from '../services/notifications/link-events';
import { checkDueLinks } from '../services/quick/link-check';

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Starts the job handlers (doc 17 §3) and the link health loop (§10) on a pg-boss
 * instance. The worker process runs this; in development the api runs it in-process.
 */
export async function startWorker(boss: PgBoss, deps: JobDeps): Promise<WorkerHandle> {
  for (const name of JOB_NAMES) {
    await boss.work(name, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        await runJob(deps, name as JobName, job.data as JobPayloads[JobName]);
      }
    });
  }
  // Nightly housekeeping, server time.
  await boss.schedule('trash.purge', '0 3 * * *', {});
  await boss.schedule('quota.reconcile', '30 3 * * *', {});
  await boss.schedule('recording.retention', '15 4 * * *', {});
  // Chat: digest every 15 minutes (each person on their own schedule), cleanup nightly.
  await boss.schedule('chat.digest', '*/15 * * * *', {});
  await boss.schedule('chat.cleanup', '0 4 * * *', {});
  await boss.schedule('chat.reminders', '* * * * *', {});
  await boss.schedule('meet.reconcile', '* * * * *', {});
  await boss.schedule('chat.scheduled_sweep', '* * * * *', {});
  await boss.schedule('celebrations.tick', '7 * * * *', {});
  await boss.schedule('push.receipts', '*/15 * * * *', {});
  await boss.schedule('mcp.cleanup', '15 * * * *', {});
  await boss.schedule('boards.sweep', '*/10 * * * *', {});
  await boss.schedule('vault.purge', '45 3 * * *', {});
  await boss.schedule('page.sweep', '*/5 * * * *', {});
  await boss.schedule('search.sweep', '*/5 * * * *', {});
  // Shared channels 2: local changes of shared folders go to the other organizations.
  await boss.schedule('federation.folder_scan', '* * * * *', {});
  // Directory sync (identity): suspends people removed or disabled in AD/LDAP.
  await boss.schedule('identity.directory_sync', '5 * * * *', {});
  // Nightly backup: the time and zone come from Yönetim › Yedekler.
  await boss.schedule('backup.tick', '*/5 * * * *', {});
  await boss.schedule('guest.expire', '20 * * * *', {});
  await boss.schedule('compliance.retention', '30 2 * * *', {});
  // Drive content index: files stored before it (or whose job was lost) every half hour.
  await boss.schedule('content.backfill', '20,50 * * * *', {});
  await boss.schedule('forms.sweep', '25 * * * *', {});
  // Calendar reminders go out within a minute of their time.
  await boss.schedule('calendar.reminders', '* * * * *', {});
  // Google / Microsoft calendars: each account every five minutes (the job picks the due ones).
  await boss.schedule('calendar.external_sync', '* * * * *', {});
  await boss.schedule('calendar.bookings_release', '* * * * *', {});
  await boss.schedule('calendar.domain_wide', '17 * * * *', {});
  // Admin statistics: today's numbers stay at most an hour old.
  await boss.schedule('stats.rollup', '20 * * * *', {});
  // Directory profiles after identity's account sync (:05).
  await boss.schedule('contacts.directory_sync', '20 * * * *', {});
  await boss.schedule('automations.sweep', '50 3 * * *', {});
  // Mail: every minute; each account is checked on its org's interval (pollMinutes).
  await boss.schedule('mail.poll', '* * * * *', {});

  // Links are checked on their own schedule (next_check_at), every 15 s at most;
  // rows are claimed with SKIP LOCKED so several workers never check the same link.
  let stopped = false;
  let running: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    running = checkDueLinks({
      ...deps,
      onStatusChange: (before, after) => onLinkStatusChange(deps, before, after),
    })
      .catch((err) => deps.logger.warn({ err }, 'link check round failed'))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, 15_000);
      });
  };
  let timer = setTimeout(tick, 2_000);

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
