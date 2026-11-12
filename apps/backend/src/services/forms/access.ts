import { and, eq } from 'drizzle-orm';
import { forms, spaces, type DbOrTx } from '@crewhall/db';
import { can, type Form, type FormSettings, type SpaceAction, type SpaceRole, paths } from '@crewhall/shared';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import { usersById } from '../chat/views';
import { spaceRoleOf, type DriveActor } from '../drive/access';
import { invalidateModules, isModuleEnabled } from '../identity/modules';
import { orgContext } from '../membership';

export type FormRow = typeof forms.$inferSelect;

/**
 * Is the forms module on for the org (OrgSettings.modules, absent key = on)? Endpoints are
 * blocked centrally (MODULE_OF_ENDPOINT); this covers the CSV route and the jobs.
 */
export function formsEnabled(db: DbOrTx, orgId: string): Promise<boolean> {
  return isModuleEnabled(db, orgId, 'forms');
}

export function forgetFormsSwitch(orgId?: string) {
  invalidateModules(orgId);
}

export interface FormAccess {
  form: FormRow;
  space: typeof spaces.$inferSelect;
  role: SpaceRole | null;
}

/** A form of the active org with the caller's space role; 404 when gone. */
export async function loadForm(
  db: DbOrTx,
  a: DriveActor,
  formId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<FormAccess> {
  const q = db
    .select({ form: forms, space: spaces })
    .from(forms)
    .innerJoin(spaces, eq(spaces.id, forms.spaceId))
    .where(and(eq(forms.id, formId), eq(forms.orgId, a.org.id)));
  const [row] = opts.forUpdate ? await q.for('update', { of: forms }) : await q;
  if (!row || row.space.deletedAt) throw new AppError('not_found');
  return { ...row, role: await spaceRoleOf(db, row.space.id, a.userId) };
}

export function canForm(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  return can(a.actor, action, { type: 'space', org: orgContext(a.org), myRole: role });
}

/** Builders and result readers are space editors; others do not see the form exists. */
export function requireForm(a: DriveActor, role: SpaceRole | null, action: SpaceAction) {
  if (!canForm(a, role, action)) {
    throw new AppError(
      role === null || !canForm(a, role, 'space.view') ? 'not_found' : 'forbidden',
    );
  }
}

export const publicFormUrl = (env: Pick<Env, 'HUB_URL'>, token: string) =>
  `${env.HUB_URL.replace(/\/$/, '')}/f/${token}`;

export const fillPath = (formId: string) => paths.formEdit(formId);

/** Accepting answers right now? Drafts, closed forms and past closesAt refuse. */
export function accepting(form: Pick<FormRow, 'status' | 'settings'>, now = new Date()) {
  if (form.status !== 'open') return false;
  const closes = form.settings.closesAt ? new Date(form.settings.closesAt) : null;
  return !closes || closes > now;
}

/** Stored settings in the contract's shape (rows older than a destination lack its key). */
export const settingsOf = (s: FormRow['settings']): FormSettings => ({
  ...s,
  destinations: { ...s.destinations, table: s.destinations.table ?? null },
});

export async function toForms(
  db: DbOrTx,
  env: Pick<Env, 'HUB_URL'>,
  rows: FormRow[],
  counts: Map<string, number>,
): Promise<Form[]> {
  const people = await usersById(
    db,
    rows.map((r) => r.ownerId).filter((v): v is string => !!v),
  );
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.spaceId,
    title: r.title,
    description: r.description,
    fields: r.fields,
    settings: settingsOf(r.settings),
    status: r.status,
    publicUrl: r.settings.access === 'public' ? publicFormUrl(env, r.publicToken) : null,
    fillPath: fillPath(r.id),
    responseCount: counts.get(r.id) ?? 0,
    lastResponseAt: r.lastResponseAt?.toISOString() ?? null,
    driveNodeId: r.driveNodeId,
    owner: r.ownerId ? (people.get(r.ownerId) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}
