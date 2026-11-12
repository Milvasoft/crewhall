import { type Message } from './types';

/**
 * Message text helpers. Mentions travel as `<@userId>`, `<@all>` and `<@here>` tokens so a
 * rename never breaks them; the composer shows them as names and turns them back into tokens.
 */

export const MENTION_RE = /<@([0-9a-zA-Z-]+)>/g;
export const ALL = 'all';
export const HERE = 'here';

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; userId: string }
  | { kind: 'link'; url: string }
  | { kind: 'code'; text: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

function splitLinks(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const i = m.index;
    if (i > last) out.push({ kind: 'text', text: text.slice(last, i) });
    out.push({ kind: 'link', url: m[0] });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/** Inline `code`, mentions and links; everything else stays plain text (no HTML). */
export function parseText(text: string): TextPart[] {
  const out: TextPart[] = [];
  const segments = text.split(/(`[^`\n]+`)/g);
  for (const seg of segments) {
    if (!seg) continue;
    if (seg.length > 2 && seg.startsWith('`') && seg.endsWith('`')) {
      out.push({ kind: 'code', text: seg.slice(1, -1) });
      continue;
    }
    let last = 0;
    for (const m of seg.matchAll(MENTION_RE)) {
      const i = m.index;
      if (i > last) out.push(...splitLinks(seg.slice(last, i)));
      out.push({ kind: 'mention', userId: m[1] ?? '' });
      last = i + m[0].length;
    }
    if (last < seg.length) out.push(...splitLinks(seg.slice(last)));
  }
  return out;
}

/** Fenced ``` blocks become their own paragraphs (4.1 code sample). */
export function splitBlocks(
  text: string,
): { kind: 'text' | 'code'; text: string; lang?: string }[] {
  const out: { kind: 'text' | 'code'; text: string; lang?: string }[] = [];
  const re = /```([a-zA-Z0-9#+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const before = text.slice(last, m.index).replace(/\n$/, '');
    if (before.trim()) out.push({ kind: 'text', text: before });
    out.push({ kind: 'code', text: (m[2] ?? '').replace(/\n$/, ''), lang: m[1] || undefined });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).replace(/^\n/, '');
  if (rest.trim() || out.length === 0) out.push({ kind: 'text', text: rest });
  return out;
}

export function mentionIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1] ?? ''))].filter(Boolean);
}

export function hasGroupMention(text: string): boolean {
  const ids = mentionIds(text);
  return ids.includes(ALL) || ids.includes(HERE);
}

/**
 * Text for previews, notifications and copy. `mention` turns a token's id (or `all`) into
 * the label to show; callers pass names and the translated "@everyone".
 */
export function plainText(
  m: Pick<Message, 'text' | 'card'>,
  mention: (id: string) => string = () => '@…',
): string {
  const base = m.text || m.card?.title || '';
  return base
    .replace(MENTION_RE, (_, id: string) => mention(id))
    .replace(/```[a-zA-Z0-9#+-]*\n?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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
