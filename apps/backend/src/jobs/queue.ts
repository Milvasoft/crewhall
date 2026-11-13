import { PgBoss } from 'pg-boss';
import type { CallEndReason } from '@crewhall/shared';

/**
 * Background jobs (doc 17 §3 worker). The api only sends; the worker process runs them.
 * Every job is idempotent, so a retry or a duplicate is harmless.
 */
export interface JobPayloads {
  'blob.process': { blobId: string };
  preview: { blobId: string };
  'trash.purge': Record<string, never>;
  'quota.reconcile': Record<string, never>;
  'portal.revalidate': { jobId: string };
  'recording.ingest': { recordingId: string };
  /** H7: a call stops ringing after CALL_RING_SECONDS. */
  'meet.call_timeout': { callId: string };
  /** H7: phones of these people stop ringing (data-only meet.call_end). */
  'meet.call_end': { orgId: string; callId: string; userIds: string[]; reason?: CallEndReason };
  /** H7: a one-to-one call ends unless the side that left comes back (webhook.ts). */
  'meet.call_hangup': { meetingId: string; sessionId: string };
  'meet.room_empty': { meetingId: string; sessionId: string };
  /** Every minute: sessions and participants follow LiveKit even without its webhooks. */
  'meet.reconcile': Record<string, never>;
  'recording.retention': Record<string, never>;
  // Chat module (doc 17 §10)
  'push.send': { notificationId: string; repeat?: boolean };
  /** A delivered push leaves the person's phones (a plugin's notification read there). */
  'push.clear': { orgId: string; userId: string; tag: string };
  'push.receipts': { olderThanSeconds?: number };
  'chat.digest': Record<string, never>;
  'chat.cleanup': Record<string, never>;
  /** Roadmap 23: `/remind` reminders that are due (every minute). */
  'chat.reminders': Record<string, never>;
  /** A scheduled message at its send time (startAfter); the sweep catches lost ones. */
  'chat.scheduled': { id: string };
  'chat.scheduled_sweep': Record<string, never>;
  /** The preview card of a message's first external link (after sending, never blocking it). */
  'chat.link_preview': { messageId: string };
  /** Roadmap 19: a published announcement's e-mails (once, not in the digest). */
  'announcement.email': { announcementId: string };
  /** Hourly: the morning birthday and work anniversary posts (each org's own time zone). */
  'celebrations.tick': Record<string, never>;
  'approval.apply': { approvalId: string };
  'mcp.cleanup': Record<string, never>;
  'drawing.thumbnail': { nodeId: string };
  'boards.sweep': Record<string, never>;
  'vault.purge': Record<string, never>;
  /** Wiki: derive markdown, search, backlinks, mentions and versions from a page's Yjs state. */
  'page.snapshot': { nodeId: string; force?: boolean };
  /** Wiki: missed derivations, idle-session versions, abandoned empty pages (every 5 min). */
  'page.sweep': Record<string, never>;
  /** Wiki: build a page export (PDF, DOCX, HTML, Markdown; roadmap 6). */
  'page.export': { exportId: string };
  'identity.directory_sync': Record<string, never>;
  /** Nightly backup check (every 5 min) and one backup run (Yönetim › Yedekler). */
  'backup.tick': Record<string, never>;
  'backup.run': { runId: string };
  /** Guests past their end date are suspended (hourly). */
  'guest.expire': Record<string, never>;
  /** Compliance: nightly retention rules and expired eDiscovery archives; one export. */
  'compliance.retention': Record<string, never>;
  'ediscovery.export': { exportId: string };
  /** AI search index (yol haritası #11): changed sources every 5 minutes, or one org now. */
  'search.sweep': { orgId?: string };
  /** Federation (roadmap 26): one signed activity to one peer inbox, retried with backoff. */
  /** Plugins: one event to one installation's server (signed), retried with backoff. */
  'plugin.deliver': { installationId: string; path: string; body: Record<string, unknown> };
  'federation.deliver': {
    orgId: string;
    domain: string;
    activity: { id: string; type: string } & Record<string, unknown>;
  };
  /** Shared channels: the automatic accept of an invite (FEDERATION_AUTO_ACCEPT_DOMAINS). */
  'federation.share_accept': { orgId: string; shareId: string };
  /** Shared channels: one announced file pulled from a peer into the channel's Ekler folder. */
  'federation.file_pull': { orgId: string; fileId: string };
  /** Shared channels 2: what a guest that just accepted gets (folders, a live meeting). */
  'federation.share_joined': { orgId: string; shareId: string };
  /** Shared channels 2: local changes of every shared folder (every minute). */
  'federation.folder_scan': Record<string, never>;
  /** Shared channels 2: a remote file version pulled into this copy of a shared folder. */
  'federation.folder_pull': { orgId: string; itemId: string; peerId: string };
  /** AI meeting notes (yol haritası #12): transcript, summary and notes page of a recording. */
  'ai.meeting_notes': { recordingId: string; manual?: boolean };
  /** Drive: text of a stored file into the search index (roadmap 10). */
  'content.extract': { blobId: string };
  /** Drive: queue extraction for files stored before the indexer. */
  'content.backfill': Record<string, never>;
  /** Forms: board card and owner notification of one answer (at most once). */
  'forms.deliver': { responseId: string };
  /** Forms: rebuild the CSV table in Drive. */
  'forms.export': { formId: string };
  /** Forms: uploads never attached to an answer (hourly). */
  'forms.sweep': Record<string, never>;
  /** Calendar: reminders due this minute (every minute). */
  'calendar.reminders': Record<string, never>;
  /** Calendar: Google / Microsoft accounts not synced for five minutes (every minute). */
  'calendar.external_sync': Record<string, never>;
  /** Calendar: one account right after it was connected. */
  'calendar.external_sync_account': { accountId: string };
  /** Calendar: bookings nobody checked in to within the grace time are freed (every minute). */
  'calendar.bookings_release': Record<string, never>;
  /** Calendar: delegated accounts of orgs with org-wide access (hourly, and on admin change). */
  'calendar.domain_wide': { orgId?: string };
  /** Admin statistics (roadmap 21): activity and storage into org_stats_daily, hourly. */
  'stats.rollup': Record<string, never>;
  /** Contacts: profile attributes (title, department, manager...) from AD/LDAP. */
  'contacts.directory_sync': Record<string, never>;
  /** Automations: run one queued rule run. */
  'automation.run': { runId: string };
  /** Automations: run history past its retention (nightly). */
  'automations.sweep': Record<string, never>;
  /** Mail: new-mail check of every connected INBOX that is due (each org's poll interval). */
  'mail.poll': Record<string, never>;
  /** Mail: folder-wide read / unread / move / delete in chunks (mailStartBulk). */
  'mail.bulk': { jobId: string };
  /** Microsoft: copy a mount folder or a OneDrive into Drive (import_jobs). */
  'microsoft.import': { jobId: string };
}
export type JobName = keyof JobPayloads;
export const JOB_NAMES: JobName[] = [
  'blob.process',
  'preview',
  'trash.purge',
  'quota.reconcile',
  'portal.revalidate',
  'recording.ingest',
  'meet.call_timeout',
  'meet.call_end',
  'meet.call_hangup',
  'meet.room_empty',
  'meet.reconcile',
  'recording.retention',
  'approval.apply',
  'mcp.cleanup',
  'drawing.thumbnail',
  'boards.sweep',
  'push.send',
  'push.clear',
  'push.receipts',
  'chat.digest',
  'chat.cleanup',
  'chat.reminders',
  'chat.scheduled',
  'chat.scheduled_sweep',
  'chat.link_preview',
  'announcement.email',
  'celebrations.tick',
  'vault.purge',
  'page.snapshot',
  'page.sweep',
  'page.export',
  'identity.directory_sync',
  'backup.tick',
  'backup.run',
  'guest.expire',
  'compliance.retention',
  'ediscovery.export',
  'search.sweep',
  'federation.deliver',
  'plugin.deliver',
  'federation.share_accept',
  'federation.file_pull',
  'federation.share_joined',
  'federation.folder_scan',
  'federation.folder_pull',
  'ai.meeting_notes',
  'content.extract',
  'content.backfill',
  'forms.deliver',
  'forms.export',
  'forms.sweep',
  'calendar.reminders',
  'calendar.external_sync',
  'calendar.external_sync_account',
  'calendar.bookings_release',
  'calendar.domain_wide',
  'stats.rollup',
  'contacts.directory_sync',
  'automation.run',
  'automations.sweep',
  'mail.poll',
  'mail.bulk',
  'microsoft.import',
];

export interface SendOptions {
  /** One queued job per key (pg-boss singletonKey). */
  singletonKey?: string;
  /** With singletonKey: at most one job per key in this many seconds (push grouping). */
  singletonSeconds?: number;
  /** Throttled sends run once when the window ends, instead of being dropped. */
  singletonNextSlot?: boolean;
  /** Run later; inline jobs (tests) skip delayed jobs. */
  startAfterSeconds?: number;
}

/** Jobs that call other services retry with exponential backoff (doc 17 §2). */
const RETRY: Partial<
  Record<JobName, { retryLimit: number; retryDelay: number; retryBackoff: boolean }>
> = {
  'portal.revalidate': { retryLimit: 3, retryDelay: 2, retryBackoff: true },
  // A peer that is down gets the message later: 6 tries over about 10 minutes.
  'federation.deliver': { retryLimit: 6, retryDelay: 10, retryBackoff: true },
  'plugin.deliver': { retryLimit: 5, retryDelay: 10, retryBackoff: true },
  // FCM's 429 and 5xx: an immediate retry fails the same way and the push is lost.
  'push.send': { retryLimit: 4, retryDelay: 5, retryBackoff: true },
  'federation.share_accept': { retryLimit: 3, retryDelay: 10, retryBackoff: true },
  'federation.file_pull': { retryLimit: 6, retryDelay: 10, retryBackoff: true },
  'federation.share_joined': { retryLimit: 3, retryDelay: 10, retryBackoff: true },
  'federation.folder_pull': { retryLimit: 6, retryDelay: 10, retryBackoff: true },
};

export interface Jobs {
  send<N extends JobName>(name: N, data: JobPayloads[N], options?: SendOptions): Promise<void>;
  stop(): Promise<void>;
}

export async function createBoss(connectionString: string) {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  await boss.start();
  for (const name of JOB_NAMES) {
    // A backup copies the whole bucket: give it hours, not the default 15 minutes.
    await boss.createQueue(
      name,
      name === 'backup.run' || name === 'ediscovery.export' ? { expireInSeconds: 6 * 3600 } : {},
    );
  }
  return boss;
}

export function pgBossJobs(boss: PgBoss): Jobs {
  return {
    async send(name, data, options = {}) {
      // Page derivation: once per page every 30 s; a change inside the window runs in the
      // next one (doc 17 §6 step 5).
      if (name === 'page.snapshot' && 'nodeId' in data) {
        await boss.send(name, data, {
          singletonKey: String(data.nodeId),
          singletonSeconds: 30,
          singletonNextSlot: true,
        });
        return;
      }
      // One pending job per blob is enough (doc 17 §3: singletonKey).
      const key =
        options.singletonKey ??
        ('blobId' in data
          ? String(data.blobId)
          : 'recordingId' in data
            ? String(data.recordingId)
            : undefined);
      await boss.send(name, data, {
        ...(key ? { singletonKey: key } : {}),
        ...(RETRY[name] ?? {}),
        ...(options.singletonSeconds ? { singletonSeconds: options.singletonSeconds } : {}),
        ...(options.singletonNextSlot ? { singletonNextSlot: true } : {}),
        ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
      });
    },
    stop: () => boss.stop({ graceful: true }),
  };
}

/**
 * Runs handlers right away in-process; used by tests and the seed. A job sent from a
 * running job is queued and run after it, and the outer send resolves once all are done.
 */
export function inlineJobs(
  run: <N extends JobName>(name: N, data: JobPayloads[N]) => Promise<void>,
  onError: (err: unknown, name: JobName) => void = () => undefined,
): Jobs {
  const queue: [JobName, JobPayloads[JobName]][] = [];
  let running = false;
  return {
    async send(name, data, options = {}) {
      if (options.startAfterSeconds) return;
      queue.push([name, data]);
      if (running) return;
      running = true;
      try {
        while (queue.length) {
          const [n, d] = queue.shift()!;
          await run(n, d).catch((err) => onError(err, n));
        }
      } finally {
        running = false;
      }
    },
    stop: async () => undefined,
  };
}
