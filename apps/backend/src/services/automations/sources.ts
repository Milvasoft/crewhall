import { eq, inArray } from 'drizzle-orm';
import { boardCards, boardColumns, boards, nodes, spaces, users, type Db } from '@crewhall/db';
import { answerText, type FormAnswers, paths } from '@crewhall/shared';
import type { Jobs } from '../../jobs/queue';
import type { Logger } from '../../logger';
import type { DriveActor } from '../drive/access';
import type { FormRow } from '../forms/access';
import { emitAutomationEvent } from './emit';

/**
 * The events other modules hand to automations (roadmap 17), built after their write committed.
 * Each is one call from the module's route or service, and never fails the caller.
 */

type SourceDeps = { db: Db; jobs: Jobs; logger: Logger };

const label = (id: string) => id.replaceAll('-', '');
const idOf = (l: string) =>
  `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`;

async function nameOf(db: Db, userId: string | null) {
  if (!userId) return null;
  const [u] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  return u ?? null;
}

/** Column of a card before a move (the route reads it, then moves). */
export async function cardColumn(db: Db, cardId: string) {
  const [row] = await db
    .select({ columnId: boardCards.columnId })
    .from(boardCards)
    .where(eq(boardCards.id, cardId));
  return row?.columnId ?? null;
}

/** `boards.card_moved`, only when the column changed. */
export async function cardMoved(
  deps: SourceDeps,
  a: DriveActor,
  card: { id: string; boardId: string; columnId: string; number: number; title: string },
  fromColumnId: string | null,
) {
  if (!fromColumnId || fromColumnId === card.columnId) return;
  try {
    const [board] = await deps.db
      .select({ node: nodes, board: boards })
      .from(boards)
      .innerJoin(nodes, eq(nodes.id, boards.nodeId))
      .where(eq(boards.nodeId, card.boardId));
    if (!board) return;
    const cols = await deps.db
      .select()
      .from(boardColumns)
      .where(inArray(boardColumns.id, [fromColumnId, card.columnId]));
    const from = cols.find((c) => c.id === fromColumnId);
    const to = cols.find((c) => c.id === card.columnId);
    const ref = `${board.board.settings.key}-${card.number}`;
    const actor = await nameOf(deps.db, a.userId);
    await emitAutomationEvent(deps, {
      orgId: a.org.id,
      spaceId: board.node.spaceId,
      type: 'boards.card_moved',
      data: {
        card: { id: card.id, ref, title: card.title, url: paths.boardCard(card.boardId, ref) },
        board: { id: card.boardId, name: board.node.name },
        from: { id: fromColumnId, name: from?.name ?? '' },
        to: { id: card.columnId, name: to?.name ?? '', done: to?.isDone ?? false },
        actor,
      },
      match: { boardId: card.boardId, fromColumnId, toColumnId: card.columnId },
    });
  } catch (err) {
    deps.logger.warn({ err, cardId: card.id }, 'card move event not built');
  }
}

/** `drive.file_uploaded`: a new file or a new version. */
export async function fileUploaded(
  deps: SourceDeps,
  a: DriveActor,
  node: {
    id: string;
    spaceId: string;
    parentId: string | null;
    name: string;
    mime: string | null;
    sizeBytes: number;
  },
  version: number,
) {
  try {
    const [row] = await deps.db
      .select({ path: nodes.path, slug: spaces.slug })
      .from(nodes)
      .innerJoin(spaces, eq(spaces.id, nodes.spaceId))
      .where(eq(nodes.id, node.id));
    if (!row) return;
    const folderIds = row.path
      .split('.')
      .filter((l) => l !== label(node.id))
      .map(idOf);
    const [parent] = node.parentId
      ? await deps.db
          .select({ id: nodes.id, name: nodes.name })
          .from(nodes)
          .where(eq(nodes.id, node.parentId))
      : [];
    const where = node.parentId
      ? paths.driveFolder(row.slug, node.parentId)
      : paths.driveSpace(row.slug);
    await emitAutomationEvent(deps, {
      orgId: a.org.id,
      spaceId: node.spaceId,
      type: 'drive.file_uploaded',
      data: {
        file: {
          id: node.id,
          name: node.name,
          mime: node.mime,
          size: node.sizeBytes,
          version,
          url: where,
        },
        folder: parent ?? null,
        actor: await nameOf(deps.db, a.userId),
      },
      match: { folderIds },
    });
  } catch (err) {
    deps.logger.warn({ err, nodeId: node.id }, 'upload event not built');
  }
}

/** Answers as text by field id, and `_text`: "Soru: cevap" lines of the answered ones. */
function answersData(form: FormRow, answers: FormAnswers) {
  const byId = Object.fromEntries(form.fields.map((f) => [f.id, answerText(f, answers[f.id])]));
  const lines = form.fields
    .filter((f) => byId[f.id])
    .map((f) => `${f.label}: ${byId[f.id]!.replace(/\s*\n\s*/g, ' ')}`);
  return { ...byId, _text: lines.join('\n') };
}

/** `forms.response_submitted`: answers as text by field id. */
export async function formAnswered(
  deps: SourceDeps,
  form: FormRow,
  responseId: string,
  respondentId: string | null,
  answers: FormAnswers,
) {
  try {
    const who = form.settings.anonymous ? null : await nameOf(deps.db, respondentId);
    await emitAutomationEvent(deps, {
      orgId: form.orgId,
      spaceId: form.spaceId,
      type: 'forms.response_submitted',
      data: {
        form: { id: form.id, title: form.title, url: paths.formResults(form.id) },
        response: { id: responseId, url: paths.formResults(form.id) },
        respondent: { name: who?.name ?? '' },
        answers: answersData(form, answers),
      },
      match: { formId: form.id },
    });
  } catch (err) {
    deps.logger.warn({ err, formId: form.id }, 'form answer event not built');
  }
}
