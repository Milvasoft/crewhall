import { chatPlainText } from '@crewhall/shared';
import { type Message } from './types';

/**
 * Message text helpers. Mentions travel as `<@userId>`, `<@all>` and `<@here>` tokens so a
 * rename never breaks them; the composer shows them as names and turns them back into tokens.
 */

export const MENTION_RE = /<@([0-9a-zA-Z-]+)>/g;
export const ALL = 'all';
export const HERE = 'here';

export function mentionIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1] ?? ''))].filter(Boolean);
}

export function hasGroupMention(text: string): boolean {
  const ids = mentionIds(text);
  return ids.includes(ALL) || ids.includes(HERE);
}

/**
 * Text for previews, notifications and copy: format markers dropped (chatPlainText). `mention`
 * turns a token's id (or `all`) into the label to show; callers pass names and the translated
 * "@everyone".
 */
export function plainText(
  m: Pick<Message, 'text' | 'card'>,
  mention: (id: string) => string = () => '@…',
): string {
  const base = m.text ? chatPlainText(m.text, mention) : m.card?.title || '';
  return base.replace(/\s+/g, ' ').trim();
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** Group a sorted list so one person's run of messages within 5 minutes shares a header. */
export function startsRun(prev: Message | undefined, m: Message): boolean {
  if (!prev || prev.kind === 'system' || m.kind === 'system') return true;
  const a =
    prev.author?.id ?? prev.webhook?.id ?? prev.remoteAuthor?.address ?? prev.guestAuthor?.name;
  const b = m.author?.id ?? m.webhook?.id ?? m.remoteAuthor?.address ?? m.guestAuthor?.name;
  if (a !== b || !a) return true;
  if (m.replyTo || m.card) return true;
  return Date.parse(m.createdAt) - Date.parse(prev.createdAt) > 5 * 60_000;
}

export function sameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}
