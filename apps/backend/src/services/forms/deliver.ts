import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { formFiles, formResponses, forms, organizations, type Db } from '@crewhall/db';
import { resolveLocale, resources, type AppLocale } from '@crewhall/i18n';
import { BOARD_LIMITS, answerText, type FormAnswers, paths } from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { JobDeps } from '../../jobs/handlers';
import { serviceDeps } from '../../jobs/service-deps';
import { actorFor } from '../boards/collab';
import { createCard } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { boardsEnabled } from '../boards/module';
import { usersById } from '../chat/views';
import * as files from '../drive/files';
import type { DriveActor } from '../drive/access';
import { notify } from '../notifications/notify';
import { answerToTable } from '../tables/forms';
import { tablesEnabled } from '../tables/access';
import { formsEnabled, type FormRow } from './access';
import { allResponses } from './responses';

/**
 * What happens after an answer (roadmap 16): a card on the chosen board column, a row in the
 * chosen table and the owner's bell (forms.deliver, at most once per answer), and the CSV table in Drive
 * (forms.export, rebuilt from all answers so a skipped run is caught up by the next).
 */

const resultsPath = (formId: string) => paths.formResults(formId);

/** Right after an answer was stored: queue its deliveries. */
export async function afterResponse(
  deps: Pick<Deps, 'jobs' | 'logger'>,
  form: FormRow,
  responseId: string,
  _respondentId: string | null,
) {
  const { board, drive, table } = form.settings.destinations;
  try {
    if (board || table || form.settings.notifyOnResponse) {
      await deps.jobs.send('forms.deliver', { responseId });
    }
    if (drive) await deps.jobs.send('forms.export', { formId: form.id }, { singletonKey: form.id });
  } catch (err) {
    // The answer is stored; a lost delivery is caught up by the next export.
    deps.logger.warn({ err, formId: form.id }, 'form delivery not queued');
  }
}

async function orgLocale(db: Db, orgId: string): Promise<AppLocale> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return resolveLocale(org?.settings.defaultLocale ?? null);
}

const strings = (locale: AppLocale) => resources[locale].email.forms;

export async function deliverResponse(deps: JobDeps, responseId: string) {
  const { db, logger } = deps;
  // Claim first: a retried or duplicate job delivers nothing twice.
  const [claimed] = await db
    .update(formResponses)
    .set({ deliveredAt: new Date() })
    .where(and(eq(formResponses.id, responseId), isNull(formResponses.deliveredAt)))
    .returning();
  if (!claimed) return;
  const [form] = await db.select().from(forms).where(eq(forms.id, claimed.formId));
  if (!form || !(await formsEnabled(db, form.orgId))) return;
  const owner = form.ownerId ? await actorFor(db, form.ownerId, form.orgId) : null;
  const locale = await orgLocale(db, form.orgId);
  const t = strings(locale);

  if (form.settings.notifyOnResponse && owner && owner.userId !== claimed.respondentId) {
    await notify(deps, [
      {
        orgId: form.orgId,
        userId: owner.userId,
        type: 'forms.response',
        category: 'alert',
        actorId: form.settings.anonymous ? null : claimed.respondentId,
        target: { type: 'space', id: form.spaceId, spaceId: form.spaceId },
        data: { title: form.title },
        url: resultsPath(form.id),
        groupKey: `forms.response:${form.id}`,
      },
    ]).catch((err) => logger.warn({ err, formId: form.id }, 'form notification failed'));
  }

  const board = form.settings.destinations.board;
  if (board && owner && (await boardsEnabled(db, form.orgId))) {
    try {
      const card = await inBoardsTx(deps, (tx) =>
        createCard(tx, owner, board.boardId, {
          columnId: board.columnId,
          title: cardTitle(form, claimed.answers, board.titleFieldId, t.cardTitle),
          description: cardBody(form, claimed.answers),
          top: false,
          labels: [],
          assigneeIds: [],
          dueAt: null,
          afterId: null,
          beforeId: null,
        }),
      );
      await db
        .update(formResponses)
        .set({ cardId: card.id })
        .where(eq(formResponses.id, responseId));
    } catch (err) {
      // The owner lost access or the column is gone: the answer stays, the card is skipped.
      logger.warn({ err, formId: form.id }, 'form card not created');
    }
  }

  const table = form.settings.destinations.table;
  if (table && owner && (await tablesEnabled(db, form.orgId))) {
    try {
      await answerToTable(deps, owner, form, table.tableId, claimed);
    } catch (err) {
      // Same as the card: the answer stays when the table is gone or the owner lost access.
      logger.warn({ err, formId: form.id }, 'form table row not created');
    }
  }
}

function cardTitle(
  form: FormRow,
  answers: FormAnswers,
  titleFieldId: string | null,
  fallback: string,
) {
  const field = titleFieldId ? form.fields.find((f) => f.id === titleFieldId) : undefined;
  const fromField = field ? answerText(field, answers[field.id]).trim() : '';
  const title = fromField || fallback.replace('{form}', form.title);
  return title.slice(0, BOARD_LIMITS.titleLength);
}

function cardBody(form: FormRow, answers: FormAnswers) {
  const lines = form.fields
    .map((f) => {
      const text = answerText(f, answers[f.id]).replace(/\s+/g, ' ');
      return text ? `- ${f.label}: ${text}` : null;
    })
    .filter((l): l is string => l !== null);
  return lines.join('\n').slice(0, BOARD_LIMITS.descriptionLength);
}

/* ----------------------------------- CSV table ----------------------------------- */

const cell = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** All answers as CSV: UTF-8 with BOM so Excel opens Turkish text right. */
export async function csvOf(db: Db, form: FormRow, locale: AppLocale) {
  const t = strings(locale);
  const rows = await allResponses(db, form.id);
  const people = await usersById(
    db,
    rows.map((r) => r.respondentId).filter((v): v is string => !!v),
  );
  const head = [t.csv.submittedAt, t.csv.respondent, ...form.fields.map((f) => f.label)];
  const lines = [head.map(cell).join(',')];
  for (const r of rows) {
    const who = r.respondentId ? (people.get(r.respondentId)?.name ?? '') : t.anonymous;
    lines.push(
      [
        r.submittedAt.toISOString(),
        who,
        ...form.fields.map((f) => answerText(f, r.answers[f.id] ?? null)),
      ]
        .map(cell)
        .join(','),
    );
  }
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Writes bytes as a new Drive file or a new version of `nodeId` (presigned parts, like MCP). */
async function writeDriveFile(
  deps: Deps,
  a: DriveActor,
  target: { spaceId: string; parentId: string | null; name: string; nodeId: string | null },
  bytes: Buffer,
  mime: string,
) {
  const upload = await files.createUpload(
    deps,
    a,
    {
      spaceId: target.spaceId,
      parentId: target.parentId,
      name: target.name,
      mime,
      sizeBytes: bytes.length,
      onConflict: 'version',
      ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    },
    'api',
  );
  const numbers = Array.from({ length: upload.partCount }, (_, i) => i + 1);
  const { parts } = await files.partUrls(deps, a, upload.id, numbers);
  const done: { partNumber: number; etag: string }[] = [];
  try {
    for (const p of parts) {
      const start = (p.partNumber - 1) * upload.partSize;
      const res = await fetch(p.url, {
        method: 'PUT',
        body: bytes.subarray(start, start + upload.partSize),
      });
      if (!res.ok) throw new Error(`part ${p.partNumber}: ${res.status}`);
      done.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' });
    }
  } catch (err) {
    await files.abortUpload(deps, a, upload.id).catch(() => undefined);
    throw err;
  }
  return files.completeUpload(deps, a, upload.id, done);
}

/** Rebuilds the form's CSV table in Drive as the owner; returns the file node. */
export async function exportToDrive(deps: Deps, form: FormRow, a: DriveActor) {
  const locale = await orgLocale(deps.db, form.orgId);
  const csv = Buffer.from(await csvOf(deps.db, form, locale), 'utf8');
  const parentId = form.settings.destinations.drive?.parentId ?? null;
  const name = strings(locale).driveFile.replace('{form}', form.title.replace(/[\\/]/g, '-'));
  let nodeId = form.driveNodeId;
  try {
    const { node } = await writeDriveFile(
      deps,
      a,
      { spaceId: form.spaceId, parentId, name, nodeId },
      csv,
      'text/csv',
    );
    nodeId = node.id;
  } catch (err) {
    // The kept file was trashed or deleted: start a new one.
    if (!nodeId || !(err instanceof AppError) || err.code !== 'not_found') throw err;
    const { node } = await writeDriveFile(
      deps,
      a,
      { spaceId: form.spaceId, parentId, name, nodeId: null },
      csv,
      'text/csv',
    );
    nodeId = node.id;
  }
  if (nodeId !== form.driveNodeId) {
    await deps.db
      .update(forms)
      .set({ driveNodeId: nodeId, updatedAt: sql`${forms.updatedAt}` })
      .where(eq(forms.id, form.id));
  }
  return { nodeId, name };
}

export async function exportJob(deps: JobDeps, formId: string) {
  const [form] = await deps.db.select().from(forms).where(eq(forms.id, formId));
  if (!form || !form.settings.destinations.drive || !(await formsEnabled(deps.db, form.orgId)))
    return;
  const owner = form.ownerId ? await actorFor(deps.db, form.ownerId, form.orgId) : null;
  if (!owner) return;
  try {
    await exportToDrive(serviceDeps(deps), form, owner);
  } catch (err) {
    deps.logger.warn({ err, formId }, 'form drive export failed');
  }
}

/** Hourly: uploads never attached to an answer (abandoned forms) go after a day. */
export async function sweepForms(deps: Pick<JobDeps, 'db' | 'storage' | 'logger'>) {
  const stale = await deps.db
    .delete(formFiles)
    .where(
      and(isNull(formFiles.responseId), lt(formFiles.createdAt, sql`now() - interval '1 day'`)),
    )
    .returning({ key: formFiles.storageKey });
  for (const f of stale) {
    await deps.storage
      ?.delete(f.key)
      .catch((err) => deps.logger.warn({ err }, 'form file delete failed'));
  }
  return { removed: stale.length };
}
