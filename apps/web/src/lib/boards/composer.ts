import { type BoardLabel, type UserSummary } from '@crewhall/shared';

/**
 * Quick card entry (design 6.8 placeholder "#etiket, @kişi"): `#Backend` adds the label
 * of that name, `@Can` assigns the person whose first name or e-mail starts so; the
 * tokens are taken out of the title.
 */
export function parseQuickCard(
  input: string,
  labels: BoardLabel[],
  people: UserSummary[],
): { title: string; labels: string[]; assigneeIds: string[] } {
  const fold = (v: string) => v.toLocaleLowerCase('tr');
  const labelIds: string[] = [];
  const assigneeIds: string[] = [];
  const rest: string[] = [];
  for (const word of input.split(/\s+/)) {
    if (word.length > 1 && word.startsWith('#')) {
      const name = fold(word.slice(1));
      const l =
        labels.find((x) => fold(x.name) === name) ??
        labels.find((x) => fold(x.name).startsWith(name));
      if (l) {
        if (!labelIds.includes(l.id)) labelIds.push(l.id);
        continue;
      }
    }
    if (word.length > 1 && word.startsWith('@')) {
      const name = fold(word.slice(1));
      const p = people.find(
        (x) => fold(x.name.split(' ')[0] ?? '') === name || fold(x.email).startsWith(name),
      );
      if (p) {
        if (!assigneeIds.includes(p.id)) assigneeIds.push(p.id);
        continue;
      }
    }
    rest.push(word);
  }
  return { title: rest.join(' ').trim(), labels: labelIds, assigneeIds };
}
