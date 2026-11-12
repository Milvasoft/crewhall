// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/list-converter/logic.ts. See THIRD_PARTY.md.
/**
 * Transform a list of lines: trim, filter, sort, dedupe, case, affixes and a
 * custom join. Pure and local.
 */

export interface ListOptions {
  trim: boolean;
  removeEmpty: boolean;
  dedupe: boolean;
  sort: 'none' | 'asc' | 'desc' | 'numeric' | 'length';
  reverse: boolean;
  caseTransform: 'none' | 'lower' | 'upper';
  prefix: string;
  suffix: string;
  separator: string; // between items in the output
}

export const DEFAULT_OPTIONS: ListOptions = {
  trim: true,
  removeEmpty: true,
  dedupe: false,
  sort: 'none',
  reverse: false,
  caseTransform: 'none',
  prefix: '',
  suffix: '',
  separator: '\n',
};

export function transformList(input: string, opts: ListOptions): string {
  let lines = input.split(/\r?\n/);

  if (opts.trim) lines = lines.map((l) => l.trim());
  if (opts.removeEmpty) lines = lines.filter((l) => l.length > 0);
  if (opts.caseTransform === 'lower') lines = lines.map((l) => l.toLowerCase());
  else if (opts.caseTransform === 'upper') lines = lines.map((l) => l.toUpperCase());
  if (opts.dedupe) lines = [...new Set(lines)];

  switch (opts.sort) {
    case 'asc':
      lines = [...lines].sort((a, b) => a.localeCompare(b));
      break;
    case 'desc':
      lines = [...lines].sort((a, b) => b.localeCompare(a));
      break;
    case 'numeric':
      lines = [...lines].sort((a, b) => parseFloat(a) - parseFloat(b));
      break;
    case 'length':
      lines = [...lines].sort((a, b) => a.length - b.length);
      break;
  }

  if (opts.reverse) lines = [...lines].reverse();

  if (opts.prefix || opts.suffix) {
    lines = lines.map((l) => `${opts.prefix}${l}${opts.suffix}`);
  }

  return lines.join(opts.separator);
}

/** Quick stats for the input list. */
export function listStats(input: string): { lines: number; unique: number } {
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { lines: lines.length, unique: new Set(lines).size };
}
