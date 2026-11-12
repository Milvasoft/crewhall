import { createHmac } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { formFiles, formResponses, forms, newId, organizations, type DbOrTx } from '@crewhall/db';
import {
  FORM_LIMITS,
  can,
  checkAnswers,
  ratingScale,
  type FormAnswers,
  type FormFieldStats,
  type FormFile,
  type FormResponse,
  type FormStats,
  type FormToFill,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { usersById } from '../chat/views';
import { requireStorage } from '../drive/files';
import type { DriveActor } from '../drive/access';
import { orgContext } from '../membership';
import {
  accepting,
  canForm,
  formsEnabled,
  loadForm,
  requireForm,
  type FormAccess,
  type FormRow,
} from './access';
import { touchLastResponse } from './forms';
import { allow } from './limit';
import { afterResponse } from './deliver';
import { formAnswered } from '../automations/sources';

/** Answering forms (org and public link), uploads, results and statistics (roadmap 16). */

type FileRow = typeof formFiles.$inferSelect;

/** Keyed hash of a respondent: enforces "one answer" without storing who an anonymous one was. */
function keyOf(secret: string, formId: string, who: string) {
  return createHmac('sha256', secret).update(`form:${formId}:${who}`).digest('base64url');
}

const userWho = (userId: string) => `user:${userId}`;
const browserWho = (token: string) => `browser:${token}`;

const EXECUTABLE = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-elf',
  'application/x-mach-binary',
  'application/vnd.microsoft.portable-executable',
]);

/* --------------------------------- who answers --------------------------------- */

/** May this org member answer? Org members (not guests) always; space members too. */
function canRespond(a: DriveActor, access: FormAccess) {
  return (
    can(a.actor, 'forms.respond', { type: 'org', org: orgContext(a.org) }) || access.role !== null
  );
}

async function loadForAnswer(db: DbOrTx, a: DriveActor, formId: string) {
  const access = await loadForm(db, a, formId);
  // Drafts are only for the builders' preview.
  if (access.form.status === 'draft' && !canForm(a, access.role, 'forms.manage')) {
    throw new AppError('not_found');
  }
  if (!canRespond(a, access)) throw new AppError('not_found');
  return access;
}

async function hasAnswered(db: DbOrTx, formId: string, key: string) {
  const [row] = await db
    .select({ id: formResponses.id })
    .from(formResponses)
    .where(and(eq(formResponses.formId, formId), eq(formResponses.respondentKey, key)));
  return Boolean(row);
}

function toFill(form: FormRow, orgName: string, alreadyResponded: boolean): FormToFill {
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    fields: form.fields,
    anonymous: form.settings.anonymous,
    oneResponse: form.settings.oneResponse,
    alreadyResponded,
    accepting: accepting(form),
    orgName,
  };
}

export async function formToFill(deps: Pick<Deps, 'db' | 'env'>, a: DriveActor, formId: string) {
  const { form } = await loadForAnswer(deps.db, a, formId);
  const answered = form.settings.oneResponse
    ? await hasAnswered(deps.db, form.id, keyOf(deps.env.AUTH_SECRET, form.id, userWho(a.userId)))
    : false;
  return toFill(form, a.org.name, answered);
}

/** A form behind a public link; 404 for unknown tokens, org-only forms and drafts. */
async function loadPublic(db: DbOrTx, token: string) {
  const [row] = await db
    .select({ form: forms, orgName: organizations.name })
    .from(forms)
    .innerJoin(organizations, eq(organizations.id, forms.orgId))
    .where(eq(forms.publicToken, token));
  if (!row || row.form.settings.access !== 'public' || row.form.status === 'draft') {
    throw new AppError('not_found');
  }
  if (!(await formsEnabled(db, row.form.orgId))) {
    throw new AppError('module_disabled', { module: 'forms' });
  }
  return row;
}

export async function publicForm(deps: Pick<Deps, 'db'>, token: string) {
  const { form, orgName } = await loadPublic(deps.db, token);
  return toFill(form, orgName, false);
}

/* ------------------------------------ files ------------------------------------ */

const DATA_URL = /^data:([^;,]*)(;base64)?,(.*)$/s;

async function storeFile(
  deps: Pick<Deps, 'db' | 'storage'>,
  form: FormRow,
  input: { fieldId: string; name: string; dataURL: string },
  uploaderKey: string,
): Promise<FormFile> {
  const field = form.fields.find((f) => f.id === input.fieldId);
  if (!field || field.type !== 'file') throw new AppError('form_file_invalid', { reason: 'field' });
  const m = DATA_URL.exec(input.dataURL);
  if (!m || !m[2]) throw new AppError('form_file_invalid', { reason: 'data_url' });
  const bytes = Buffer.from(m[3]!, 'base64');
  if (bytes.length === 0) throw new AppError('form_file_invalid', { reason: 'empty' });
  if (bytes.length > FORM_LIMITS.fileBytes) {
    throw new AppError('form_file_too_large', { maxBytes: FORM_LIMITS.fileBytes });
  }
  const detected = (await fileTypeFromBuffer(bytes))?.mime;
  if (detected && EXECUTABLE.has(detected))
    throw new AppError('form_file_invalid', { reason: 'executable' });
  const mime = (detected ?? m[1]) || 'application/octet-stream';
  const storage = requireStorage(deps);
  const id = newId();
  const storageKey = `orgs/${form.orgId}/forms/${form.id}/${id}`;
  await storage.put(storageKey, bytes, mime);
  const [row] = await deps.db
    .insert(formFiles)
    .values({
      id,
      orgId: form.orgId,
      formId: form.id,
      fieldId: field.id,
      uploaderKey,
      name: input.name,
      mime,
      sizeBytes: bytes.length,
      storageKey,
    })
    .returning();
  return fileOut(row!);
}

const fileOut = (r: FileRow): FormFile => ({
  fileId: r.id,
  name: r.name,
  mime: r.mime,
  sizeBytes: r.sizeBytes,
});

export async function uploadFile(
  deps: Pick<Deps, 'db' | 'storage' | 'env'>,
  a: DriveActor,
  formId: string,
  input: { fieldId: string; name: string; dataURL: string },
) {
  const { form } = await loadForAnswer(deps.db, a, formId);
  if (!accepting(form)) throw new AppError('form_closed');
  return storeFile(deps, form, input, keyOf(deps.env.AUTH_SECRET, form.id, userWho(a.userId)));
}

export async function uploadPublicFile(
  deps: Pick<Deps, 'db' | 'storage' | 'env'>,
  token: string,
  input: { fieldId: string; name: string; dataURL: string; clientToken?: string },
  req: RequestInfo,
) {
  const { form } = await loadPublic(deps.db, token);
  if (!accepting(form)) throw new AppError('form_closed');
  if (!input.clientToken) throw new AppError('form_file_invalid', { reason: 'client_token' });
  if (!allow(`upload:${req.ip ?? 'unknown'}`, FORM_LIMITS.publicUploadsPerIp, 600_000)) {
    throw new AppError('rate_limited');
  }
  return storeFile(
    deps,
    form,
    input,
    keyOf(deps.env.AUTH_SECRET, form.id, browserWho(input.clientToken)),
  );
}

/** Swaps each file answer for the stored file the same respondent uploaded to that field. */
async function resolveFiles(db: DbOrTx, form: FormRow, answers: FormAnswers, uploaderKey: string) {
  const ids: string[] = [];
  for (const f of form.fields) {
    const v = answers[f.id];
    if (f.type === 'file' && Array.isArray(v)) {
      for (const x of v) if (typeof x === 'object' && x) ids.push(x.fileId);
    }
  }
  if (ids.length === 0) return { answers, fileIds: [] };
  const rows = await db
    .select()
    .from(formFiles)
    .where(
      and(
        inArray(formFiles.id, ids),
        eq(formFiles.formId, form.id),
        eq(formFiles.uploaderKey, uploaderKey),
        isNull(formFiles.responseId),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: FormAnswers = { ...answers };
  for (const f of form.fields) {
    const v = answers[f.id];
    if (f.type !== 'file' || !Array.isArray(v)) continue;
    const files: FormFile[] = [];
    for (const x of v) {
      const row = typeof x === 'object' && x ? byId.get(x.fileId) : undefined;
      if (!row || row.fieldId !== f.id) throw new AppError('form_file_invalid', { fieldId: f.id });
      files.push(fileOut(row));
    }
    out[f.id] = files;
  }
  return { answers: out, fileIds: ids };
}

/* ------------------------------------ submit ------------------------------------ */

interface SubmitInput {
  answers: FormAnswers;
  clientToken?: string;
  website?: string;
}

async function submit(
  deps: Deps,
  form: FormRow,
  input: SubmitInput,
  who: { userId: string | null; key: string; channel: 'org' | 'public' },
) {
  const confirmation = form.settings.confirmation;
  // Honeypot filled: answer like a success, store nothing.
  if (input.website) return { id: newId(), confirmation };
  if (!accepting(form)) throw new AppError('form_closed');
  const { clean, errors } = checkAnswers(form.fields, input.answers);
  if (Object.keys(errors).length) throw new AppError('form_answers_invalid', { fields: errors });
  const respondentKey = form.settings.oneResponse
    ? keyOf(deps.env.AUTH_SECRET, form.id, who.key)
    : null;

  const id = await deps.db.transaction(async (tx) => {
    const resolved = await resolveFiles(
      tx,
      form,
      clean,
      keyOf(deps.env.AUTH_SECRET, form.id, who.key),
    );
    const [row] = await tx
      .insert(formResponses)
      .values({
        orgId: form.orgId,
        formId: form.id,
        respondentId: form.settings.anonymous ? null : who.userId,
        respondentKey,
        answers: resolved.answers,
        channel: who.channel,
      })
      .onConflictDoNothing()
      .returning({ id: formResponses.id });
    if (!row) throw new AppError('form_already_answered');
    if (resolved.fileIds.length) {
      await tx
        .update(formFiles)
        .set({ responseId: row.id })
        .where(inArray(formFiles.id, resolved.fileIds));
    }
    await touchLastResponse(tx, form.id);
    return row.id;
  });
  await afterResponse(deps, form, id, who.userId);
  await formAnswered(deps, form, id, form.settings.anonymous ? null : who.userId, clean);
  return { id, confirmation };
}

export async function submitForm(deps: Deps, a: DriveActor, formId: string, input: SubmitInput) {
  const { form } = await loadForAnswer(deps.db, a, formId);
  return submit(deps, form, input, { userId: a.userId, key: userWho(a.userId), channel: 'org' });
}

export async function submitPublic(
  deps: Deps,
  token: string,
  input: SubmitInput,
  req: RequestInfo,
) {
  const { form } = await loadPublic(deps.db, token);
  const ip = req.ip ?? 'unknown';
  if (
    !allow(`form:${form.id}`, FORM_LIMITS.publicSubmitsPerMinute, 60_000) ||
    !allow(`submit:${form.id}:${ip}`, FORM_LIMITS.publicSubmitsPerIp, 600_000)
  ) {
    throw new AppError('rate_limited');
  }
  // Without a browser token the answer cannot be tied to anyone: one-answer forms need it.
  if (form.settings.oneResponse && !input.clientToken) {
    throw new AppError('form_answers_invalid', { reason: 'client_token' });
  }
  return submit(deps, form, input, {
    userId: null,
    key: browserWho(input.clientToken ?? newId()),
    channel: 'public',
  });
}

/* ----------------------------------- results ----------------------------------- */

async function loadResults(db: DbOrTx, a: DriveActor, formId: string) {
  const access = await loadForm(db, a, formId);
  requireForm(a, access.role, 'forms.view_results');
  return access;
}

type ResponseRow = typeof formResponses.$inferSelect;

async function toResponses(db: DbOrTx, rows: ResponseRow[]): Promise<FormResponse[]> {
  const people = await usersById(
    db,
    rows.map((r) => r.respondentId).filter((v): v is string => !!v),
  );
  return rows.map((r) => ({
    id: r.id,
    respondent: r.respondentId ? (people.get(r.respondentId) ?? null) : null,
    answers: r.answers,
    submittedAt: r.submittedAt.toISOString(),
  }));
}

const encodeCursor = (r: ResponseRow) =>
  Buffer.from(`${r.submittedAt.toISOString()}|${r.id}`).toString('base64url');

function decodeCursor(cursor: string) {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) throw new AppError('bad_request', { reason: 'cursor' });
  return { at: date, id };
}

export async function listResponses(
  db: DbOrTx,
  a: DriveActor,
  formId: string,
  q: { cursor?: string; limit: number },
) {
  await loadResults(db, a, formId);
  const after = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await db
    .select()
    .from(formResponses)
    .where(
      and(
        eq(formResponses.formId, formId),
        after
          ? or(
              lt(formResponses.submittedAt, after.at),
              and(eq(formResponses.submittedAt, after.at), lt(formResponses.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(formResponses.submittedAt), desc(formResponses.id))
    .limit(q.limit + 1);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  return {
    items: await toResponses(db, page),
    nextCursor: more ? encodeCursor(page[page.length - 1]!) : null,
  };
}

export async function deleteResponse(
  deps: Pick<Deps, 'db' | 'storage' | 'logger'>,
  a: DriveActor,
  responseId: string,
  req: RequestInfo,
) {
  const [row] = await deps.db
    .select({ formId: formResponses.formId })
    .from(formResponses)
    .where(and(eq(formResponses.id, responseId), eq(formResponses.orgId, a.org.id)));
  if (!row) throw new AppError('not_found');
  const { role } = await loadForm(deps.db, a, row.formId);
  requireForm(a, role, 'forms.manage');
  const files = await deps.db
    .select({ key: formFiles.storageKey })
    .from(formFiles)
    .where(eq(formFiles.responseId, responseId));
  await deps.db.delete(formResponses).where(eq(formResponses.id, responseId));
  await touchLastResponse(deps.db, row.formId);
  await audit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'form.response.delete',
      targetType: 'form',
      targetId: row.formId,
      meta: { responseId },
    },
    req,
  );
  for (const f of files) {
    await deps.storage
      ?.delete(f.key)
      .catch((err) => deps.logger.warn({ err }, 'form file delete failed'));
  }
  return {};
}

export async function fileUrl(deps: Pick<Deps, 'db' | 'storage'>, a: DriveActor, fileId: string) {
  const [row] = await deps.db
    .select()
    .from(formFiles)
    .where(and(eq(formFiles.id, fileId), eq(formFiles.orgId, a.org.id)));
  if (!row || !row.responseId) throw new AppError('not_found');
  await loadResults(deps.db, a, row.formId);
  // Always a download: uploaded content never renders on our origin.
  const signed = await requireStorage(deps).presignGet(row.storageKey, {
    fileName: row.name,
    inline: false,
  });
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

/** Every answer of a form, oldest first (CSV, Drive table, statistics). */
export async function allResponses(db: DbOrTx, formId: string) {
  return db
    .select()
    .from(formResponses)
    .where(eq(formResponses.formId, formId))
    .orderBy(formResponses.submittedAt, formResponses.id);
}

export function statsOf(form: FormRow, rows: Pick<ResponseRow, 'answers'>[]): FormFieldStats[] {
  return form.fields.map((f) => {
    const counts: Record<string, number> = {};
    const nums: number[] = [];
    let answered = 0;
    for (const r of rows) {
      const v = r.answers[f.id];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))
        continue;
      answered++;
      if (f.type === 'single_choice' && typeof v === 'string') counts[v] = (counts[v] ?? 0) + 1;
      if (f.type === 'multi_choice' && Array.isArray(v)) {
        for (const id of v) if (typeof id === 'string') counts[id] = (counts[id] ?? 0) + 1;
      }
      if ((f.type === 'number' || f.type === 'rating') && typeof v === 'number') {
        nums.push(v);
        if (f.type === 'rating') counts[String(v)] = (counts[String(v)] ?? 0) + 1;
      }
    }
    if (f.type === 'single_choice' || f.type === 'multi_choice') {
      for (const c of f.choices) counts[c.id] ??= 0;
    }
    if (f.type === 'rating') {
      for (let i = 1; i <= ratingScale(f); i++) counts[String(i)] ??= 0;
    }
    return {
      fieldId: f.id,
      type: f.type,
      answered,
      counts,
      average: nums.length
        ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100
        : null,
      min: nums.length ? Math.min(...nums) : null,
      max: nums.length ? Math.max(...nums) : null,
    };
  });
}

export async function formStats(db: DbOrTx, a: DriveActor, formId: string): Promise<FormStats> {
  const { form } = await loadResults(db, a, formId);
  const rows = await db
    .select({ answers: formResponses.answers })
    .from(formResponses)
    .where(eq(formResponses.formId, formId));
  const daily = await db
    .select({
      date: sql<string>`to_char(${formResponses.submittedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(formResponses)
    .where(
      and(
        eq(formResponses.formId, formId),
        sql`${formResponses.submittedAt} > now() - interval '30 days'`,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  return { total: rows.length, daily, fields: statsOf(form, rows) };
}

export { loadResults };
