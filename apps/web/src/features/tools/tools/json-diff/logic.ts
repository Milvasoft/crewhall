// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-diff/logic.ts. See THIRD_PARTY.md.
export type ChangeType = 'added' | 'removed' | 'changed';

export interface JsonChange {
  path: string;
  type: ChangeType;
  left?: unknown; // value in A (removed/changed)
  right?: unknown; // value in B (added/changed)
}

export interface JsonDiffResult {
  changes: JsonChange[];
  added: number;
  removed: number;
  changed: number;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function childPath(parent: string, key: string | number): string {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return IDENT.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural, order-insensitive (for object keys) deep diff of two values. */
export function diffValues(a: unknown, b: unknown, path = '$'): JsonChange[] {
  if (Object.is(a, b)) return [];

  const aObj = isObject(a);
  const bObj = isObject(b);
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);

  if (aObj && bObj) {
    const changes: JsonChange[] = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const inA = key in a;
      const inB = key in b;
      const cp = childPath(path, key);
      if (inA && !inB) changes.push({ path: cp, type: 'removed', left: a[key] });
      else if (!inA && inB) changes.push({ path: cp, type: 'added', right: b[key] });
      else changes.push(...diffValues(a[key], b[key], cp));
    }
    return changes;
  }

  if (aArr && bArr) {
    const changes: JsonChange[] = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
      const cp = childPath(path, i);
      if (i >= a.length) changes.push({ path: cp, type: 'added', right: b[i] });
      else if (i >= b.length) changes.push({ path: cp, type: 'removed', left: a[i] });
      else changes.push(...diffValues(a[i], b[i], cp));
    }
    return changes;
  }

  // Different types or differing primitives.
  return [{ path, type: 'changed', left: a, right: b }];
}

export function diffJson(aText: string, bText: string): JsonDiffResult {
  const a = JSON.parse(aText) as unknown;
  const b = JSON.parse(bText) as unknown;
  const changes = diffValues(a, b);
  return {
    changes,
    added: changes.filter((c) => c.type === 'added').length,
    removed: changes.filter((c) => c.type === 'removed').length,
    changed: changes.filter((c) => c.type === 'changed').length,
  };
}
