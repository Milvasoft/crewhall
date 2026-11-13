import { chatPlainText } from '@crewhall/shared';

/**
 * Message text: plain UTF-8 with mention tokens `<@userId>`, `<@all>`, `<@here>`
 * (schemas/chat Mention). Clients render markdown-ish code blocks themselves.
 */

const TOKEN = /<@(all|here|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

export interface ParsedMentions {
  userIds: string[];
  all: boolean;
  here: boolean;
}

export function parseMentions(text: string): ParsedMentions {
  const userIds = new Set<string>();
  let all = false;
  let here = false;
  for (const m of text.matchAll(TOKEN)) {
    const v = m[1]!.toLowerCase();
    if (v === 'all') all = true;
    else if (v === 'here') here = true;
    else userIds.add(v);
  }
  return { userIds: [...userIds], all, here };
}

/** Mentions as names ("@Elif Yıldız"); unknown people become "@?". */
export function plainText(text: string, names: Map<string, string>) {
  return text.replace(TOKEN, (_, v: string) => {
    const key = v.toLowerCase();
    if (key === 'all' || key === 'here') return `@${key}`;
    return `@${names.get(key) ?? '?'}`;
  });
}

/**
 * One line for notifications, e-mails, the chat list and reply quotes: format markers
 * (`*bold*`, `_italic_`, lists) are dropped, mentions become names.
 */
export function excerpt(text: string, names: Map<string, string>, max = 200) {
  const flat = plainText(chatPlainText(text), names).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Mentioned user ids across many texts, for one name lookup. */
export function mentionedIds(texts: string[]) {
  const ids = new Set<string>();
  for (const t of texts) for (const id of parseMentions(t).userIds) ids.add(id);
  return [...ids];
}
