// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-viewer/logic.ts. See THIRD_PARTY.md.
export interface JsonError {
  message: string;
  line?: number;
  column?: number;
  position?: number;
}

export interface JsonStats {
  objects: number;
  arrays: number;
  keys: number;
  values: number;
  depth: number;
}

function positionToLineCol(text: string, pos: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/** Parse JSON, returning a structured error (with line/column) instead of throwing. */
export function parseJson(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: JsonError } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid JSON';
    // Engines vary: some report "at position N", others "line L column C".
    const lineColMatch = message.match(/line (\d+) column (\d+)/i);
    if (lineColMatch) {
      return {
        ok: false,
        error: {
          message,
          line: Number(lineColMatch[1]),
          column: Number(lineColMatch[2]),
        },
      };
    }
    const posMatch = message.match(/position (\d+)/i);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const { line, column } = positionToLineCol(text, pos);
      return { ok: false, error: { message, line, column, position: pos } };
    }
    return { ok: false, error: { message } };
  }
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export interface FormatOptions {
  indent?: number | '\t';
  sortKeys?: boolean;
}

export function formatJson(text: string, opts: FormatOptions = {}): string {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new Error(formatError(parsed.error));
  const value = opts.sortKeys ? sortDeep(parsed.value) : parsed.value;
  const indent = opts.indent ?? 2;
  return JSON.stringify(value, null, indent);
}

export function minifyJson(text: string): string {
  const parsed = parseJson(text);
  if (!parsed.ok) throw new Error(formatError(parsed.error));
  return JSON.stringify(parsed.value);
}

export function formatError(error: JsonError): string {
  if (error.line !== undefined) {
    return `${error.message} (line ${error.line}, column ${error.column})`;
  }
  return error.message;
}

export function computeStats(value: unknown): JsonStats {
  const stats: JsonStats = { objects: 0, arrays: 0, keys: 0, values: 0, depth: 0 };
  const walk = (node: unknown, depth: number) => {
    stats.depth = Math.max(stats.depth, depth);
    if (Array.isArray(node)) {
      stats.arrays++;
      node.forEach((n) => walk(n, depth + 1));
    } else if (node && typeof node === 'object') {
      stats.objects++;
      const entries = Object.entries(node as Record<string, unknown>);
      stats.keys += entries.length;
      entries.forEach(([, v]) => walk(v, depth + 1));
    } else {
      stats.values++;
    }
  };
  walk(value, 1);
  return stats;
}
