import { asc, eq } from 'drizzle-orm';
import { boardColumns, newId } from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import {
  BOARD_LIMITS,
  CHAT_LIMITS,
  paths,
  type SavedToCrewhall,
  type SaveToCrewhall,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import type { OrgRow } from '../../http/types';
import { createCard } from '../boards/cards';
import { inBoardsTx } from '../boards/integrations';
import { sendMessage } from '../chat/messages';
import type { DriveActor } from '../drive/access';
import { createPage } from '../wiki/pages';
import { requireIntegration } from './app';

/**
 * "Crewhall'a kaydet" from Outlook (a mail) and Teams (a message): a page, a card or a chat
 * message with who sent it, when, and a link back. Each target applies its own rights and
 * DLP rules, exactly as if the person wrote it in Crewhall.
 */

/** Markdown special characters of plain text, so a mail never turns into headings or links. */
const escapeMd = (text: string) => text.replace(/([\\`*_{}[\]<>#|~])/g, '\\$1');

function header(input: SaveToCrewhall, locale: 'tr' | 'en') {
  const t = resources[locale].email.microsoft.save;
  const lines: string[] = [];
  if (input.from && (input.from.name || input.from.email)) {
    const who = [input.from.name, input.from.email ? `<${input.from.email}>` : null]
      .filter(Boolean)
      .join(' ');
    lines.push(`**${t.from}:** ${escapeMd(who)}`);
  }
  if (input.sentAt) {
    const when = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(new Date(input.sentAt));
    lines.push(`**${t.date}:** ${when} UTC`);
  }
  if (input.link) lines.push(`[${t.original}](${input.link})`);
  lines.push(`_${t[input.source]}_`);
  return lines;
}

/** Plain text as markdown paragraphs (blank lines kept, single breaks as hard breaks). */
const bodyMarkdown = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => escapeMd(p.trim()).replace(/\n/g, '  \n'))
    .filter(Boolean)
    .join('\n\n');

export async function saveToCrewhall(
  deps: Deps,
  a: DriveActor & { org: OrgRow },
  input: SaveToCrewhall,
): Promise<SavedToCrewhall> {
  requireIntegration(a.org, input.source);
  const locale = a.org.settings.defaultLocale;
  const head = header(input, locale);
  const markdown = [head.join('  \n'), '---', bodyMarkdown(input.text)]
    .filter(Boolean)
    .join('\n\n');
  const target = input.target;

  if (target.kind === 'page') {
    const page = await createPage(
      deps,
      a,
      target.spaceId,
      { parentId: target.parentId ?? null, name: input.title.slice(0, 200), markdown },
      { source: 'api', locale },
    );
    return { kind: 'page', id: page.id, path: paths.page(page.id) };
  }

  if (target.kind === 'card') {
    let columnId = target.columnId;
    if (!columnId) {
      const [first] = await deps.db
        .select({ id: boardColumns.id })
        .from(boardColumns)
        .where(eq(boardColumns.boardNodeId, target.boardId))
        .orderBy(asc(boardColumns.position))
        .limit(1);
      if (!first) throw new AppError('not_found');
      columnId = first.id;
    }
    const card = await inBoardsTx(deps, (tx) =>
      createCard(tx, a, target.boardId, {
        columnId,
        afterId: null,
        beforeId: null,
        title: input.title.slice(0, BOARD_LIMITS.titleLength),
        top: false,
        description: markdown.slice(0, BOARD_LIMITS.descriptionLength),
        labels: [],
        assigneeIds: [],
        dueAt: null,
      }),
    );
    return {
      kind: 'card',
      id: card.id,
      path: paths.boardCard(target.boardId, String(card.number)),
    };
  }

  const text = [`**${escapeMd(input.title)}**`, head.join('\n'), bodyMarkdown(input.text)]
    .filter(Boolean)
    .join('\n\n');
  const message = await sendMessage(deps, a, target.conversationId, {
    clientMsgId: newId(),
    text: text.slice(0, CHAT_LIMITS.messageChars),
    attachmentNodeIds: [],
  });
  return {
    kind: 'chat',
    id: message.id,
    path: paths.chatConversation(target.conversationId),
  };
}
