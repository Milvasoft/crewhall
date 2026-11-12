import type { Canon, ConflictRule, Direction } from './types';

/**
 * Field-by-field three-way merge: what each side has now against what they agreed on last time.
 * A field only one side changed goes to the other; a field both changed differently is a
 * conflict, settled by the sync's rule. Every run recomputes this from current state, so a run
 * that stopped halfway is simply finished by the next one.
 */

export const CANON_FIELDS = [
  'title',
  'description',
  'column',
  'assignee',
  'priority',
  'dueDate',
  'startDate',
  'labels',
  'points',
] as const satisfies readonly (keyof Canon)[];

export type CanonView = { [K in keyof Canon]: Canon[K] | undefined };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface MergeInput {
  base: Canon;
  /** `undefined`: that side cannot say anything about this field. */
  external: CanonView;
  card: CanonView;
  direction: Direction;
  conflict: ConflictRule;
  /** For the `newest` rule. */
  externalIsNewer: boolean;
}

export interface MergeResult {
  toCard: Partial<Canon>;
  toExternal: Partial<Canon>;
  conflicts: (keyof Canon)[];
  next: Canon;
}

export function merge(input: MergeInput): MergeResult {
  const { base, external, card, direction, conflict, externalIsNewer } = input;
  const toCard: Record<string, unknown> = {};
  const toExternal: Record<string, unknown> = {};
  const next: Record<string, unknown> = { ...base };
  const conflicts: (keyof Canon)[] = [];

  for (const f of CANON_FIELDS) {
    const b = base[f];
    const e = external[f];
    const c = card[f];
    if (e === undefined && c === undefined) continue;
    if (e === undefined) {
      // Only the card can speak for it.
      next[f] = direction === 'to_crewhall' ? b : c;
      continue;
    }
    if (c === undefined) {
      next[f] = direction === 'to_external' ? b : e;
      continue;
    }
    if (same(e, c)) {
      next[f] = e;
      continue;
    }
    // One-way syncs: the source always wins, whatever happened on the other side.
    if (direction === 'to_crewhall') {
      toCard[f] = e;
      next[f] = e;
      continue;
    }
    if (direction === 'to_external') {
      toExternal[f] = c;
      next[f] = c;
      continue;
    }
    const eChanged = !same(e, b);
    const cChanged = !same(c, b);
    let useExternal: boolean;
    if (eChanged && cChanged) {
      conflicts.push(f);
      useExternal =
        conflict === 'external' ? true : conflict === 'crewhall' ? false : externalIsNewer;
    } else {
      useExternal = eChanged;
    }
    if (useExternal) {
      toCard[f] = e;
      next[f] = e;
    } else {
      toExternal[f] = c;
      next[f] = c;
    }
  }
  return {
    toCard: toCard as Partial<Canon>,
    toExternal: toExternal as Partial<Canon>,
    conflicts,
    next: next as unknown as Canon,
  };
}
