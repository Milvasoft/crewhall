// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-compare/logic.ts. See THIRD_PARTY.md.
import { diffArrays } from 'diff';

export interface DiffOptions {
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
  trim?: boolean;
}

export type DiffRowType = 'equal' | 'added' | 'removed' | 'modified';

export interface DiffRow {
  left: string | null;
  right: string | null;
  leftNo: number | null;
  rightNo: number | null;
  type: DiffRowType;
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  changed: number;
}

export interface DiffRequest {
  a: string;
  b: string;
  options: DiffOptions;
}

function makeTransform(o: DiffOptions): (line: string) => string {
  return (line: string) => {
    let t = line;
    if (o.trim) t = t.trim();
    if (o.ignoreWhitespace) t = t.replace(/\s+/g, '');
    if (o.ignoreCase) t = t.toLowerCase();
    return t;
  };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split(/\r\n|\r|\n/);
}

/**
 * Line-oriented diff aligned into side-by-side rows. Comparison honors the
 * ignore options while the displayed text stays original. Pure and worker-safe.
 */
export function diffText(a: string, b: string, options: DiffOptions = {}): DiffResult {
  const transform = makeTransform(options);
  const aLines = splitLines(a);
  const bLines = splitLines(b);

  const parts = diffArrays(aLines, bLines, {
    comparator: (l, r) => transform(l) === transform(r),
  });

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;
  let leftNo = 1;
  let rightNo = 1;

  let dels: string[] = [];
  let adds: string[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const left = i < dels.length ? dels[i]! : null;
      const right = i < adds.length ? adds[i]! : null;
      if (left !== null && right !== null) {
        rows.push({
          left,
          right,
          leftNo: leftNo++,
          rightNo: rightNo++,
          type: 'modified',
        });
        changed++;
      } else if (left !== null) {
        rows.push({ left, right: null, leftNo: leftNo++, rightNo: null, type: 'removed' });
        removed++;
      } else {
        rows.push({ left: null, right, leftNo: null, rightNo: rightNo++, type: 'added' });
        added++;
      }
    }
    dels = [];
    adds = [];
  };

  for (const part of parts) {
    if (part.added) {
      adds.push(...part.value);
    } else if (part.removed) {
      dels.push(...part.value);
    } else {
      flush();
      for (const line of part.value) {
        rows.push({
          left: line,
          right: line,
          leftNo: leftNo++,
          rightNo: rightNo++,
          type: 'equal',
        });
      }
    }
  }
  flush();

  return { rows, added, removed, changed };
}
