/**
 * Version diff (design 5.10): top-level blocks are compared by content; a block replaced by
 * one of the same type is shown word by word (added green, removed red struck through).
 */

export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

export type BlockOp =
  | { op: 'same'; block: PMNode }
  | { op: 'add'; block: PMNode }
  | { op: 'del'; block: PMNode }
  | { op: 'mod'; before: PMNode; after: PMNode; words: WordOp[] };

export type WordOp = { op: 'same' | 'add' | 'del'; text: string };

const key = (n: PMNode) => JSON.stringify(n);

export function blockText(n: PMNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  if (n.type === 'mention') return `@${String(n.attrs?.label ?? '')}`;
  return (n.content ?? []).map(blockText).join(n.type === 'tableRow' ? ' | ' : '');
}

/** Longest common subsequence over two sequences with an equality test. */
function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean) {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = eq(a[i]!, b[j]!)
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { op: 'same' | 'add' | 'del'; a?: T; b?: T }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (eq(a[i]!, b[j]!)) {
      out.push({ op: 'same', a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: 'del', a: a[i] });
      i++;
    } else {
      out.push({ op: 'add', b: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ op: 'del', a: a[i++] });
  while (j < n) out.push({ op: 'add', b: b[j++] });
  return out;
}

export function wordDiff(before: string, after: string): WordOp[] {
  const tok = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];
  const raw = lcs(tok(before), tok(after), (x, y) => x === y);
  const out: WordOp[] = [];
  for (const r of raw) {
    const text = (r.op === 'add' ? r.b : r.a) ?? '';
    const last = out.at(-1);
    if (last && last.op === r.op) last.text += text;
    else out.push({ op: r.op, text });
  }
  return out;
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading']);

export function diffBlocks(before: PMNode[], after: PMNode[]): BlockOp[] {
  const raw = lcs(before, after, (x, y) => key(x) === key(y));
  const ops: BlockOp[] = raw.map((r) =>
    r.op === 'same'
      ? { op: 'same', block: r.b! }
      : r.op === 'add'
        ? { op: 'add', block: r.b! }
        : { op: 'del', block: r.a! },
  );
  // In each run of changes, the n-th removed block and the n-th added block of the same
  // text kind are one edit.
  const merged: BlockOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op === 'same') {
      merged.push(ops[i]!);
      i++;
      continue;
    }
    const dels: PMNode[] = [];
    const adds: PMNode[] = [];
    while (i < ops.length && ops[i]!.op !== 'same') {
      const o = ops[i]!;
      if (o.op === 'del') dels.push(o.block);
      else if (o.op === 'add') adds.push(o.block);
      i++;
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a2 = adds[k];
      if (k < pairs && d && a2 && d.type === a2.type && TEXT_BLOCKS.has(d.type)) {
        merged.push({
          op: 'mod',
          before: d,
          after: a2,
          words: wordDiff(blockText(d), blockText(a2)),
        });
      } else {
        if (d) merged.push({ op: 'del', block: d });
        if (a2) merged.push({ op: 'add', block: a2 });
      }
    }
  }
  return merged;
}

export const changeCount = (ops: BlockOp[]) => ops.filter((o) => o.op !== 'same').length;
