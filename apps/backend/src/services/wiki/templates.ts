import { eq } from 'drizzle-orm';
import { users, type DbOrTx } from '@crewhall/db';
import type { PageTemplate, PageTemplateContent, Template } from '@crewhall/shared';
import { AppError } from '../../http/errors';
import type { DriveActor } from '../drive/access';
import * as gallery from '../templates/service';
import { fillPlaceholders } from './builtin-templates';

/**
 * Page templates (design 5.13) on top of the template gallery (roadmap 8): the wiki's own
 * endpoints keep their shape and see the page kind. Org templates are left out of this list
 * (its scope enum predates them); the gallery endpoints show them, and createPage takes their
 * ids like any other.
 */

export function localeOf(header: string | null | undefined, fallback: 'tr' | 'en' = 'tr') {
  const first = header?.split(',')[0]?.trim().toLowerCase() ?? '';
  if (first.startsWith('en')) return 'en';
  if (first.startsWith('tr')) return 'tr';
  return fallback;
}

function toPageTemplate(t: Template): PageTemplate | null {
  if (t.scope === 'org') return null;
  return {
    id: t.id,
    scope: t.scope,
    spaceId: t.spaceId,
    name: t.name,
    description: t.description,
    category: t.category,
    blockCount: t.summary.blocks ?? 0,
    preview: t.preview,
    createdBy: t.createdBy,
  };
}

/** Built-in, the caller's personal ones and those of reachable spaces (or one space). */
export async function listTemplates(
  db: DbOrTx,
  a: DriveActor,
  locale: 'tr' | 'en',
  spaceId?: string,
): Promise<PageTemplate[]> {
  const { items } = await gallery.listTemplates(db, a, locale, { kind: 'page', spaceId });
  return items.map(toPageTemplate).filter((t): t is PageTemplate => t !== null);
}

/** Template body with «tarih» / «yazar» filled, checked against what the caller may use. */
export async function templateMarkdown(
  db: DbOrTx,
  a: DriveActor,
  templateId: string,
  locale: 'tr' | 'en',
  spaceId: string,
) {
  const t = await gallery.resolveTemplate(db, a, templateId, locale, spaceId);
  if (t.kind !== 'page') throw new AppError('not_found', { field: 'templateId' });
  const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, a.userId));
  const values = {
    date: new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
    author: me?.name ?? '',
  };
  return fillPlaceholders((t.content as PageTemplateContent).markdown, values);
}

export async function createTemplate(
  db: DbOrTx,
  a: DriveActor,
  input: {
    nodeId: string;
    name: string;
    description: string;
    category: string;
    scope: 'space' | 'personal';
  },
) {
  const t = await gallery.createTemplate(db, a, { kind: 'page', ...input });
  return toPageTemplate(t)!;
}

export async function deleteTemplate(db: DbOrTx, a: DriveActor, templateId: string) {
  await gallery.deleteTemplate(db, a, templateId);
}
