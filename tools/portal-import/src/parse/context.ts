import fs from 'node:fs';
import path from 'node:path';
import type { ImportEntry } from '../bundle';
import { toPosix } from './rules';

/** Shared state of one parse run: the checkout root and the report rows collected so far. */
export class ParseContext {
  readonly entries: ImportEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(readonly root: string) {}

  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  exists(rel: string): boolean {
    return rel !== '' && fs.existsSync(this.abs(rel));
  }

  isFile(rel: string): boolean {
    try {
      return fs.statSync(this.abs(rel)).isFile();
    } catch {
      return false;
    }
  }

  isDir(rel: string): boolean {
    try {
      return fs.statSync(this.abs(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  read(rel: string): string {
    return fs.readFileSync(this.abs(rel), 'utf8');
  }

  readJson(rel: string): unknown {
    try {
      return JSON.parse(this.read(rel).replace(/^\uFEFF/, '')) as unknown;
    } catch {
      return null;
    }
  }

  /** Every file below `dir` (repo-relative, posix), sorted; hidden entries and node_modules left out. */
  files(dir: string): string[] {
    if (!this.isDir(dir)) return [];
    const out: string[] = [];
    const walk = (rel: string) => {
      const names = fs.readdirSync(this.abs(rel)).sort(compareNames);
      for (const name of names) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const child = rel ? `${rel}/${name}` : name;
        if (this.isDir(child)) walk(child);
        else out.push(child);
      }
    };
    walk(toPosix(dir));
    return out;
  }

  /** Adds a report row once (same type, source and action). */
  report(entry: ImportEntry): void {
    const key = `${entry.type}\u0000${entry.source}\u0000${entry.action}\u0000${JSON.stringify(entry.target)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.entries.push(entry);
  }
}

/** Stable name order, like a sorted directory listing. */
export const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Repo-relative posix join that resolves `.` and `..`; null when it leaves the root. */
export function joinRel(dir: string, rel: string): string | null {
  const parts = dir && dir !== '.' ? dir.split('/') : [];
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.join('/');
}

export const dirOf = (rel: string) => {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
};
