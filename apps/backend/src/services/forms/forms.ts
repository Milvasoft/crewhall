import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, inArray, max, sql } from 'drizzle-orm';
import { boardColumns, formFiles, formResponses, forms, type DbOrTx } from '@crewhall/db';
import {
  CreateForm,
  FORM_LIMITS,
  FormSettings,
  formDefinitionIssues,
  type FormField,
  type FormSummary,
  UpdateForm,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { RequestInfo } from '../../http/types';
import { audit } from '../audit';
import { loadBoard, requireRole } from '../boards/access';
import { loadTable } from '../tables/access';
import { loadNode, loadSpace, requireNodeAction, type DriveActor } from '../drive/access';
import { canForm, loadForm, requireForm, settingsOf, toForms, type FormRow } from './access';

/** Forms of a space, their definitions and sharing (roadmap 16). */

const newToken = () => randomBytes(18).toString('base64url');

export async function responseCounts(db: DbOrTx, formIds: string[]) {
  if (formIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ formId: formResponses.formId, n: count() })
    .from(formResponses)
    .where(inArray(formResponses.formId, formIds))
    .groupBy(formResponses.formId);
  return new Map(rows.map((r) => [r.formId, Number(r.n)]));
}

export async function formOut(deps: Pick<Deps, 'db' | 'env'>, row: FormRow) {
  const [out] = await toForms(deps.db, deps.env, [row], await responseCounts(deps.db, [row.id]));
  return out!;
}

function assertDefinition(fields: FormField[]) {
  const issues = formDefinitionIssues(fields);
  if (issues.length) throw new AppError('form_definition_invalid', { issues });
}

export async function listForms(
  db: DbOrTx,
  a: DriveActor,
  spaceId: string,
): Promise<{ items: FormSummary[] }> {
  const { role } = await loadSpace(db, a, spaceId);
  requireForm(a, role, 'space.view');
  const editor = canForm(a, role, 'forms.manage');
  const rows = await db
    .select()
    .from(forms)
    .where(
      and(
        eq(forms.spaceId, spaceId),
        eq(forms.orgId, a.org.id),
        // Viewers see the open forms they can answer; editors see drafts and closed ones too.
        editor ? undefined : eq(forms.status, 'open'),
      ),
    )
    .orderBy(desc(forms.updatedAt));
  const counts = editor
    ? await responseCounts(
        db,
        rows.map((r) => r.id),
      )
    : new Map();
  return {
    items: rows.map((r) => ({
      id: r.id,
      spaceId: r.spaceId,
      title: r.title,
      status: r.status,
      access: r.settings.access,
      fieldCount: r.fields.length,
      responseCount: counts.get(r.id) ?? 0,
      lastResponseAt: editor ? (r.lastResponseAt?.toISOString() ?? null) : null,
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

export async function createForm(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor,
  spaceId: string,
  input: z.output<typeof CreateForm>,
  req: RequestInfo,
) {
  const { db } = deps;
  const { space, role } = await loadSpace(db, a, spaceId);
  requireForm(a, role, 'forms.manage');
  if (space.archivedAt) throw new AppError('forbidden', { reason: 'space_archived' });
  assertDefinition(input.fields);
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(forms)
    .where(eq(forms.spaceId, spaceId));
  if (Number(n) >= FORM_LIMITS.formsPerSpace) {
    throw new AppError('form_limit_reached', { forms: FORM_LIMITS.formsPerSpace });
  }
  const [row] = await db
    .insert(forms)
    .values({
      orgId: a.org.id,
      spaceId,
      title: input.title,
      description: input.description ?? null,
      fields: input.fields,
      settings: FormSettings.parse({}),
      publicToken: newToken(),
      ownerId: a.userId,
    })
    .returning();
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'form.create',
      targetType: 'form',
      targetId: row!.id,
    },
    req,
  );
  return formOut(deps, row!);
}

export async function getForm(deps: Pick<Deps, 'db' | 'env'>, a: DriveActor, formId: string) {
  const { form, role } = await loadForm(deps.db, a, formId);
  requireForm(a, role, 'forms.manage');
  return formOut(deps, form);
}

/** Destinations are written on the saver's behalf, so the saver must be able to write there. */
async function assertDestinations(
  db: DbOrTx,
  a: DriveActor,
  form: FormRow,
  settings: z.output<typeof FormSettings>,
  fields: FormField[],
) {
  const { board, drive, table } = settings.destinations;
  if (table) {
    const access = await loadTable(db, a, table.tableId, 'tables.edit').catch(() => {
      throw new AppError('form_destination_invalid', { destination: 'table' });
    });
    if (access.table.spaceId !== form.spaceId) {
      throw new AppError('form_destination_invalid', { destination: 'table' });
    }
  }
  if (board) {
    const access = await loadBoard(db, a, board.boardId).catch(() => {
      throw new AppError('form_destination_invalid', { destination: 'board' });
    });
    requireRole(a, access.role, 'edit');
    const [col] = await db
      .select({ id: boardColumns.id })
      .from(boardColumns)
      .where(and(eq(boardColumns.id, board.columnId), eq(boardColumns.boardNodeId, board.boardId)));
    if (!col) throw new AppError('form_destination_invalid', { destination: 'board_column' });
    if (board.titleFieldId && !fields.some((f) => f.id === board.titleFieldId)) {
      throw new AppError('form_destination_invalid', { destination: 'board_title_field' });
    }
  }
  if (drive?.parentId) {
    const access = await loadNode(db, a, drive.parentId).catch(() => {
      throw new AppError('form_destination_invalid', { destination: 'drive' });
    });
    if (access.node.type !== 'folder' || access.node.spaceId !== form.spaceId) {
      throw new AppError('form_destination_invalid', { destination: 'drive' });
    }
    requireNodeAction(a, access.role, 'space.edit_content');
  }
}

export async function updateForm(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor,
  formId: string,
  input: z.output<typeof UpdateForm>,
  req: RequestInfo,
) {
  const { db } = deps;
  return db.transaction(async (tx) => {
    const { form, role } = await loadForm(tx, a, formId, { forUpdate: true });
    requireForm(a, role, 'forms.manage');
    const fields = input.fields ?? form.fields;
    if (input.fields) assertDefinition(fields);
    const settings = input.settings ?? settingsOf(form.settings);
    const status = input.status ?? form.status;
    if (status === 'open' && fields.length === 0) {
      throw new AppError('form_definition_invalid', { issues: ['fields: empty'] });
    }
    const goesPublic = settings.access === 'public' && form.settings.access !== 'public';
    if (goesPublic && !canForm(a, role, 'space.share_link')) {
      throw new AppError('forbidden', { reason: 'public_links' });
    }
    let ownerId = form.ownerId;
    const destinationsChanged =
      input.settings &&
      JSON.stringify(input.settings.destinations) !== JSON.stringify(form.settings.destinations);
    if (input.settings) await assertDestinations(tx, a, form, settings, fields);
    else if (input.fields && settings.destinations.board?.titleFieldId) {
      await assertDestinations(tx, a, form, settings, fields);
    }
    // Whoever (re)points the destinations is checked above and writes there from now on.
    if (destinationsChanged) ownerId = a.userId;
    const [row] = await tx
      .update(forms)
      .set({
        title: input.title ?? form.title,
        description: input.description !== undefined ? input.description : form.description,
        fields,
        settings,
        status,
        ownerId,
        // A new Drive location starts a new table.
        ...(input.settings &&
        input.settings.destinations.drive?.parentId !== form.settings.destinations.drive?.parentId
          ? { driveNodeId: null }
          : {}),
      })
      .where(eq(forms.id, formId))
      .returning();
    if (status === 'open' && form.status !== 'open') {
      await audit(
        tx,
        {
          orgId: a.org.id,
          actorId: a.userId,
          action: 'form.publish',
          targetType: 'form',
          targetId: formId,
          meta: { access: settings.access },
        },
        req,
      );
    }
    return formOut({ db: tx, env: deps.env }, row!);
  });
}

export async function regenerateLink(
  deps: Pick<Deps, 'db' | 'env'>,
  a: DriveActor,
  formId: string,
  req: RequestInfo,
) {
  const { form, role } = await loadForm(deps.db, a, formId);
  requireForm(a, role, 'forms.manage');
  if (!canForm(a, role, 'space.share_link'))
    throw new AppError('forbidden', { reason: 'public_links' });
  const [row] = await deps.db
    .update(forms)
    .set({ publicToken: newToken() })
    .where(eq(forms.id, form.id))
    .returning();
  await audit(
    deps.db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'form.link.regenerate',
      targetType: 'form',
      targetId: formId,
    },
    req,
  );
  return formOut(deps, row!);
}

export async function deleteForm(
  deps: Pick<Deps, 'db' | 'storage' | 'logger'>,
  a: DriveActor,
  formId: string,
  req: RequestInfo,
) {
  const { db } = deps;
  const { form, role } = await loadForm(db, a, formId);
  requireForm(a, role, 'forms.manage');
  const files = await db
    .select({ key: formFiles.storageKey })
    .from(formFiles)
    .where(eq(formFiles.formId, formId));
  await db.delete(forms).where(eq(forms.id, formId));
  await audit(
    db,
    {
      orgId: a.org.id,
      actorId: a.userId,
      action: 'form.delete',
      targetType: 'form',
      targetId: formId,
      meta: { title: form.title, files: files.length },
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

/** Latest answer time, kept on the form for lists. */
export async function touchLastResponse(db: DbOrTx, formId: string) {
  const [r] = await db
    .select({ at: max(formResponses.submittedAt) })
    .from(formResponses)
    .where(eq(formResponses.formId, formId));
  await db
    .update(forms)
    // An answer is not an edit: keep updatedAt.
    .set({ lastResponseAt: r?.at ?? null, updatedAt: sql`${forms.updatedAt}` })
    .where(eq(forms.id, formId));
}
