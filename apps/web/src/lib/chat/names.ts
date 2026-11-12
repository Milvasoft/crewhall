import { type UserSummary } from '@crewhall/shared';
import { ALL, HERE, plainText } from './text';
import { type Message } from './types';

/**
 * Names of people seen so far (org members, message authors), so previews written on the
 * client read "@Elif" like the server's. The translated "@herkes"/"@burada" come from i18n.
 */

const names = new Map<string, string>();
let groupLabels = { all: '@all', here: '@here' };

export function rememberPeople(people: Iterable<Pick<UserSummary, 'id' | 'name'>>): void {
  for (const p of people) names.set(p.id, p.name);
}

export function nameOf(id: string): string | null {
  return names.get(id) ?? null;
}

export function setGroupMentionLabels(labels: { all: string; here: string }): void {
  groupLabels = labels;
}

export function mentionLabel(id: string): string {
  if (id === ALL) return groupLabels.all;
  if (id === HERE) return groupLabels.here;
  return `@${names.get(id) ?? '…'}`;
}

export function excerptOf(
  m: Pick<Message, 'text' | 'card'> & Partial<Pick<Message, 'gif' | 'refs'>>,
): string {
  // A GIF-only message reads "GIF", a reference-only one a link sign, as the server's list does.
  return plainText(m, mentionLabel) || (m.gif ? 'GIF' : '') || (m.refs?.length ? '🔗' : '');
}
