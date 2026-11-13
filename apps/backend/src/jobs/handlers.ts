import { createHash } from 'node:crypto';
import { and, eq, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  blobDerivatives,
  driveChanges,
  blobs,
  linkChecks,
  linkOpens,
  nodes,
  nodeVersions,
  spaces,
  surfaceCards,
  uploads,
  type Db,
} from '@crewhall/db';
import { DRIVE_CHANGES_RETENTION_DAYS, SPACE_DELETE_RETENTION_DAYS } from '@crewhall/shared';
import { fileTypeFromBuffer } from 'file-type';
import type { Env } from '../env';
import type { Logger } from '../logger';
import { reconcileSpaceBytes } from '../services/drive/quota';
import { runRevalidateJob } from '../services/portal/revalidate';
import { applyApproval } from '../services/mcp/approvals';
import { mcpCleanup } from '../services/mcp/cleanup';
import { syncAllDirectories } from '../services/identity/directory';
import { sendReminders } from '../services/calendar/reminders';
import { syncAccount, syncDueAccounts } from '../services/calendar/external/sync';
import { syncDirectoryProfiles } from '../services/contacts/directory-sync';
import { syncGoogleDirectories } from '../services/contacts/google-directory';
import { releaseUnclaimed } from '../services/calendar/bookings';
import { provisionDomainWide } from '../services/calendar/external/domain-wide';
import { purgeSubtrees } from '../services/drive/tree';
import { backfillContents, extractBlobContent } from '../services/drive/content';
import { sweepBoards } from '../services/boards/sweep';
import { renderDrawingThumbnail } from '../services/boards/thumbnail';
import { pastTrashRetention } from '../services/trash/retention';
import { backupTick, runBackup } from '../services/backups/service';
import { expireGuests } from '../services/guests';
import { applyRetention } from '../services/compliance/policy';
import { purgeExpiredExports, runExport } from '../services/compliance/ediscovery';
import { heldNodeRoots, notHeld } from '../services/compliance/holds';
import { opsDepsFromAppEnv } from '../ops/deps';
import { purgeVault, releaseSpaceVaults } from '../services/vault/purge';
import { rollupStats } from '../services/stats/rollup';
import { derivePage, sweepPages } from '../services/wiki/derive';
import { purgePageExports, runPageExport } from '../services/wiki/export/jobs';
import type { Storage } from '../storage/s3';
import {
  expireRecordings,
  failStaleRecordings,
  ingestRecording,
} from '../services/meet/recordings';
import type { Mailer } from '../mail/mailer';
import type { Bus } from '../realtime/bus';
import { publishBlobNodes } from '../realtime/events';
import { chatCleanup } from '../services/chat/cleanup';
import { runLinkPreview } from '../services/chat/link-preview';
import { fireDueReminders } from '../services/chat/commands';
import { deliver, deliverDue } from '../services/chat/scheduled';
import { postCelebrations } from '../services/announcements/kudos';
import { serviceDeps } from './service-deps';
import { sendAnnouncementEmails } from '../services/announcements';
import { timeoutCall } from '../services/meet/calls';
import { emptyRoomCheck, hangupCheck, reconcileRooms } from '../services/meet/webhook';
import { runDigest } from '../services/notifications/digest';
import { checkReceipts, pushCallEnd, pushClear, sendPush } from '../services/notifications/push';
import { sweepSearch } from '../services/ai/search/indexer';
import { deliverActivity } from '../services/federation/deliver';
import { deliverPluginEvent } from '../services/plugins/events';
import { pullFile } from '../services/federation/files';
import { pullFolderFile, scanSharedFolders } from '../services/federation/folders';
import { autoAcceptShare, shareJoined } from '../services/federation/shared';
import { runMeetingNotes } from '../services/ai/meeting';
import { deliverResponse, exportJob, sweepForms } from '../services/forms/deliver';
import { runAutomation, sweepAutomations } from '../services/automations/run';
import { runBulkJob } from '../services/mail/bulk';
import { checkMailboxes } from '../services/mail/poll';
import { runImportJob } from '../services/microsoft/storage/import';
import { renderPreviews } from './preview';
import type { JobName, JobPayloads, Jobs } from './queue';

export interface JobDeps {
  db: Db;
  storage: Storage | null;
  logger: Logger;
  jobs: Jobs;
  env: Env;
  mailer: Mailer;
  /** Events for WebSocket clients (in-process bus, or NOTIFY from the worker process). */
  bus: Bus;
}

const EXECUTABLE = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
]);

export async function runJob<N extends JobName>(deps: JobDeps, name: N, data: JobPayloads[N]) {
  switch (name) {
    case 'blob.process':
      return processBlob(deps, (data as JobPayloads['blob.process']).blobId);
    case 'preview':
      return previewBlob(deps, (data as JobPayloads['preview']).blobId);
    case 'trash.purge':
      return purgeTrash(deps);
    case 'quota.reconcile':
      return reconcileSpaceBytes(deps.db);
    case 'portal.revalidate':
      return runRevalidateJob(deps, (data as JobPayloads['portal.revalidate']).jobId);
    case 'recording.ingest':
      return ingestRecording(deps, (data as JobPayloads['recording.ingest']).recordingId);
    case 'meet.call_end':
      return pushCallEnd(deps, data as JobPayloads['meet.call_end']);
    case 'push.clear':
      return pushClear(deps, data as JobPayloads['push.clear']);
    case 'meet.call_timeout':
      return timeoutCall(deps, (data as JobPayloads['meet.call_timeout']).callId);
    case 'meet.call_hangup': {
      const d = data as JobPayloads['meet.call_hangup'];
      return hangupCheck(deps, d.meetingId, d.sessionId);
    }
    case 'meet.room_empty': {
      const d = data as JobPayloads['meet.room_empty'];
      return emptyRoomCheck(deps, d.meetingId, d.sessionId);
    }
    case 'meet.reconcile':
      return reconcileRooms(serviceDeps(deps));
    case 'recording.retention':
      await failStaleRecordings(deps.db);
      await expireRecordings(deps);
      return;
    case 'push.send': {
      const d = data as JobPayloads['push.send'];
      return sendPush(deps, d.notificationId, d.repeat === true);
    }
    case 'push.receipts':
      return checkReceipts(deps, (data as JobPayloads['push.receipts']).olderThanSeconds);
    case 'chat.digest':
      return void (await runDigest(deps));
    case 'chat.cleanup':
      return chatCleanup(deps.db);
    case 'chat.reminders':
      return void (await fireDueReminders(deps));
    case 'chat.scheduled':
      return void (await deliver(serviceDeps(deps), (data as JobPayloads['chat.scheduled']).id));
    case 'chat.scheduled_sweep':
      return void (await deliverDue(serviceDeps(deps)));
    case 'announcement.email':
      return void (await sendAnnouncementEmails(
        deps,
        (data as JobPayloads['announcement.email']).announcementId,
      ));
    case 'celebrations.tick':
      return void (await postCelebrations(serviceDeps(deps)));
    case 'approval.apply':
      return applyApproval(deps, (data as JobPayloads['approval.apply']).approvalId);
    case 'mcp.cleanup':
      return mcpCleanup(deps.db);
    case 'chat.link_preview':
      return runLinkPreview(deps, (data as JobPayloads['chat.link_preview']).messageId);
    case 'drawing.thumbnail':
      return renderDrawingThumbnail(deps, (data as JobPayloads['drawing.thumbnail']).nodeId);
    case 'boards.sweep':
      return void (await sweepBoards(deps));
    case 'vault.purge':
      return purgeVault(deps.db);
    case 'page.snapshot': {
      const d = data as JobPayloads['page.snapshot'];
      return derivePage(deps, d.nodeId, d.force === true);
    }
    case 'page.sweep':
      await purgePageExports(deps);
      return sweepPages(deps);
    case 'page.export':
      return runPageExport(deps, (data as JobPayloads['page.export']).exportId);
    case 'identity.directory_sync':
      return void (await syncAllDirectories(deps));
    case 'ai.meeting_notes': {
      const d = data as JobPayloads['ai.meeting_notes'];
      return runMeetingNotes(deps, d.recordingId, { manual: d.manual === true });
    }
    case 'compliance.retention':
      await applyRetention(deps);
      return void (await purgeExpiredExports(deps.db, deps.storage));
    case 'ediscovery.export':
      return runExport(deps, (data as JobPayloads['ediscovery.export']).exportId);
    case 'guest.expire':
      return void (await expireGuests(deps.db));
    case 'backup.tick':
      return void (await backupTick(deps));
    case 'backup.run':
      return runBackup(
        deps,
        opsDepsFromAppEnv(deps.env, (m) => deps.logger.info(m)),
        (data as JobPayloads['backup.run']).runId,
      );
    case 'search.sweep':
      return void (await sweepSearch(deps, {
        orgId: (data as JobPayloads['search.sweep']).orgId,
      }));
    case 'plugin.deliver':
      return deliverPluginEvent(deps, data as JobPayloads['plugin.deliver']);
    case 'federation.deliver':
      return deliverActivity(deps, data as JobPayloads['federation.deliver']);
    case 'federation.share_accept':
      return autoAcceptShare(deps, data as JobPayloads['federation.share_accept']);
    case 'federation.file_pull':
      return pullFile(deps, data as JobPayloads['federation.file_pull']);
    case 'federation.share_joined':
      return shareJoined(deps, data as JobPayloads['federation.share_joined']);
    case 'federation.folder_scan':
      return scanSharedFolders(deps);
    case 'federation.folder_pull':
      return pullFolderFile(deps, data as JobPayloads['federation.folder_pull']);
    case 'content.extract':
      return extractBlobContent(deps, (data as JobPayloads['content.extract']).blobId);
    case 'content.backfill':
      return void (await backfillContents(deps));
    case 'forms.deliver':
      return deliverResponse(deps, (data as JobPayloads['forms.deliver']).responseId);
    case 'forms.export':
      return exportJob(deps, (data as JobPayloads['forms.export']).formId);
    case 'forms.sweep':
      return void (await sweepForms(deps));
    case 'calendar.reminders':
      return void (await sendReminders(deps));
    case 'calendar.domain_wide':
      return void (await provisionDomainWide(
        deps,
        (data as JobPayloads['calendar.domain_wide']).orgId,
      ));
    case 'calendar.bookings_release':
      return void (await releaseUnclaimed(deps.db));
    case 'calendar.external_sync':
      return void (await syncDueAccounts(deps));
    case 'calendar.external_sync_account':
      return void (await syncAccount(
        deps,
        (data as JobPayloads['calendar.external_sync_account']).accountId,
      ));
    case 'stats.rollup':
      return rollupStats(deps.db);
    case 'contacts.directory_sync':
      // AD/LDAP, then Google Workspace (orgs that switched it on in Yönetim › Takvim).
      await syncDirectoryProfiles(deps);
      return void (await syncGoogleDirectories(deps));
    case 'automation.run':
      return runAutomation(deps, (data as JobPayloads['automation.run']).runId);
    case 'automations.sweep':
      return void (await sweepAutomations(deps));
    case 'mail.poll':
      return void (await checkMailboxes(deps));
    case 'mail.bulk':
      return runBulkJob(deps, (data as JobPayloads['mail.bulk']).jobId);
    case 'microsoft.import':
      return runImportJob(deps, (data as JobPayloads['microsoft.import']).jobId);
  }
}

/**
 * blob.process (doc 17 §8 steps 5-6): hash the stored object, detect its type from the
 * content, quarantine on size or type mismatch, and fold duplicates into the existing
 * blob of the org (the new object is deleted; nodes keep their own versions).
 */
export async function processBlob(deps: JobDeps, blobId: string) {
  const { db, storage, logger } = deps;
  if (!storage) return;
  const [blob] = await db.select().from(blobs).where(eq(blobs.id, blobId));
  if (!blob || blob.status !== 'pending') return;

  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  let size = 0;
  const stream = await storage.getStream(blob.storageKey);
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
    if (head.length < 4100) head = Buffer.concat([head, chunk.subarray(0, 4100 - head.length)]);
  }
  const sha256 = hash.digest('hex');
  const detected = (await fileTypeFromBuffer(head))?.mime ?? null;
  const declared = blob.mime;
  const mime = detected ?? declared ?? 'application/octet-stream';

  const sizeMismatch = size !== blob.size;
  const disguisedExecutable =
    detected !== null && EXECUTABLE.has(detected) && declared !== null && !EXECUTABLE.has(declared);
  if (sizeMismatch || disguisedExecutable) {
    await db
      .update(blobs)
      .set({ status: 'quarantined', sha256, mime })
      .where(eq(blobs.id, blob.id));
    logger.warn({ blobId, sizeMismatch, detected, declared }, 'blob quarantined');
    return;
  }

  const duplicate = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(blobs)
      .where(
        and(
          eq(blobs.orgId, blob.orgId),
          eq(blobs.sha256, sha256),
          eq(blobs.status, 'ready'),
          eq(blobs.encrypted, false),
          ne(blobs.id, blob.id),
        ),
      )
      .for('update');
    if (existing) {
      // Same bytes already stored in this org: point the versions at it (doc 17 §8 step 6).
      await tx
        .update(nodeVersions)
        .set({ blobId: existing.id, mime: sql`coalesce(${nodeVersions.mime}, ${existing.mime})` })
        .where(eq(nodeVersions.blobId, blob.id));
      await tx
        .update(blobs)
        .set({ refCount: sql`${blobs.refCount} + ${blob.refCount}`, orphanedAt: null })
        .where(eq(blobs.id, existing.id));
      await tx.delete(blobs).where(eq(blobs.id, blob.id));
      return existing;
    }
    await tx.update(blobs).set({ sha256, mime, status: 'ready' }).where(eq(blobs.id, blob.id));
    return null;
  });

  // Content-detected type for the versions and their files.
  const effectiveMime = duplicate?.mime ?? mime;
  await db
    .update(nodeVersions)
    .set({ mime: effectiveMime })
    .where(eq(nodeVersions.blobId, duplicate?.id ?? blob.id));
  await db.execute(sql`update ${nodes} set mime = ${effectiveMime}
    where ${nodes.currentVersionId} in (select id from ${nodeVersions} where ${nodeVersions.blobId} = ${duplicate?.id ?? blob.id})`);

  if (duplicate) {
    await storage
      .delete(blob.storageKey)
      .catch((err) => logger.warn({ err }, 'duplicate delete failed'));
    logger.info({ blobId, into: duplicate.id }, 'blob deduplicated');
    return;
  }
  await deps.jobs.send('preview', { blobId: blob.id });
  await deps.jobs.send('content.extract', { blobId: blob.id });
}

/** preview (doc 17 §8 step 7): WebP 256 / 1024 for images, first page for PDFs. */
export async function previewBlob(deps: JobDeps, blobId: string) {
  const { db, storage, logger } = deps;
  if (!storage) return;
  const [blob] = await db.select().from(blobs).where(eq(blobs.id, blobId));
  if (!blob || blob.status !== 'ready') return;
  const kind = previewKind(blob.mime, blob.size);
  if (!kind) {
    await db.update(blobs).set({ previewStatus: 'none' }).where(eq(blobs.id, blob.id));
    return;
  }
  await db.update(blobs).set({ previewStatus: 'pending' }).where(eq(blobs.id, blob.id));
  try {
    const chunks: Buffer[] = [];
    for await (const c of (await storage.getStream(blob.storageKey)) as AsyncIterable<Buffer>) {
      chunks.push(c);
    }
    const outputs = await renderPreviews(Buffer.concat(chunks), kind);
    for (const out of outputs) {
      const key = `${blob.storageKey}/${out.kind}.webp`;
      await storage.put(key, out.data, 'image/webp');
      await db
        .insert(blobDerivatives)
        .values({
          orgId: blob.orgId,
          blobId: blob.id,
          kind: out.kind,
          storageKey: key,
          mime: 'image/webp',
          width: out.width,
          height: out.height,
          size: out.data.length,
        })
        .onConflictDoUpdate({
          target: [blobDerivatives.blobId, blobDerivatives.kind],
          set: { storageKey: key, width: out.width, height: out.height, size: out.data.length },
        });
    }
    await db.update(blobs).set({ previewStatus: 'ready' }).where(eq(blobs.id, blob.id));
    // Open listings swap the placeholder for the thumbnail.
    await publishBlobNodes(deps, blob.id);
  } catch (err) {
    logger.warn({ err, blobId }, 'preview failed');
    await db.update(blobs).set({ previewStatus: 'failed' }).where(eq(blobs.id, blob.id));
  }
}

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
  'image/svg+xml',
]);

export function previewKind(mime: string | null, size: number): 'image' | 'pdf' | null {
  if (!mime) return null;
  if (IMAGE_TYPES.has(mime) && size <= 100 * 1024 * 1024) return 'image';
  if (mime === 'application/pdf' && size <= 200 * 1024 * 1024) return 'pdf';
  return null;
}

/**
 * trash.purge (daily): nodes and quick-access cards past their org's trash retention
 * (OrgSettings.trashRetentionDays, default 30), blobs unreferenced for a day,
 * uploads left unfinished, and check / open history past its 30 days.
 */
export async function purgeTrash(deps: JobDeps) {
  const { db, storage, logger } = deps;
  const roots = await db
    .select()
    .from(nodes)
    .where(
      and(
        isNotNull(nodes.deletedAt),
        pastTrashRetention(nodes.deletedAt, nodes.orgId),
        or(
          sql`${nodes.parentId} is null`,
          sql`(select p.deleted_at from ${nodes} p where p.id = "nodes"."parent_id") is distinct from "nodes"."deleted_at"`,
        ),
      ),
    );
  // Legal hold: subtrees holding held content stay in the trash until the hold ends.
  const held = await heldNodeRoots(db, roots);
  const free = roots.filter((r) => !held.has(r.id));
  if (free.length) {
    await db.transaction((tx) => purgeSubtrees(tx, free));
    logger.info({ count: free.length, held: held.size }, 'trash purged');
  }
  // Pinned copies keep showing "Kaynak kaldırıldı" (pinned_from_card_id is set null).
  const cards = await db
    .delete(surfaceCards)
    .where(
      and(
        isNotNull(surfaceCards.deletedAt),
        pastTrashRetention(surfaceCards.deletedAt, surfaceCards.orgId),
        notHeld.surfaceCard(),
      ),
    )
    .returning({ id: surfaceCards.id });
  if (cards.length) logger.info({ count: cards.length }, 'quick cards purged');

  // Spaces deleted 30 days ago go for good: their tree first (blob references), then
  // the row, which cascades to members, surfaces and conversations.
  const spaceCutoff = new Date(Date.now() - SPACE_DELETE_RETENTION_DAYS * 86_400_000);
  const doomed = await db
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(isNotNull(spaces.deletedAt), lt(spaces.deletedAt, spaceCutoff), notHeld.space()));
  for (const s of doomed) {
    await db.transaction(async (tx) => {
      const top = await tx
        .select()
        .from(nodes)
        .where(and(eq(nodes.spaceId, s.id), sql`${nodes.parentId} is null`));
      await purgeSubtrees(tx, top);
      await releaseSpaceVaults(tx, s.id);
      await tx.delete(spaces).where(eq(spaces.id, s.id));
    });
    logger.info({ spaceId: s.id }, 'deleted space purged');
  }

  // The Drive change feed: a cursor this old answers drive_changes_expired anyway.
  await db
    .delete(driveChanges)
    .where(lt(driveChanges.at, new Date(Date.now() - DRIVE_CHANGES_RETENTION_DAYS * 86_400_000)));

  if (storage) {
    const orphans = await db
      .select()
      .from(blobs)
      .where(and(eq(blobs.refCount, 0), lt(blobs.orphanedAt, new Date(Date.now() - 86_400_000))));
    for (const b of orphans) {
      const derivs = await db
        .select()
        .from(blobDerivatives)
        .where(eq(blobDerivatives.blobId, b.id));
      for (const d of derivs) await storage.delete(d.storageKey).catch(() => undefined);
      await storage.delete(b.storageKey).catch(() => undefined);
      await db.delete(blobs).where(and(eq(blobs.id, b.id), eq(blobs.refCount, 0)));
    }
    const stale = await db
      .select()
      .from(uploads)
      .where(and(eq(uploads.status, 'uploading'), lt(uploads.expiresAt, new Date())));
    for (const u of stale) {
      await storage.abortMultipart(u.storageKey, u.s3UploadId).catch(() => undefined);
      await db.update(uploads).set({ status: 'expired' }).where(eq(uploads.id, u.id));
    }
  }
  await db.delete(linkChecks).where(lt(linkChecks.at, new Date(Date.now() - 30 * 86_400_000)));
  await db.delete(linkOpens).where(lt(linkOpens.at, new Date(Date.now() - 31 * 86_400_000)));
}
