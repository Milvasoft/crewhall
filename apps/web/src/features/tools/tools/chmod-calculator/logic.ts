// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/chmod-calculator/logic.ts. See THIRD_PARTY.md.
/**
 * Unix file-permission (chmod) math. Pure and local.
 */

export interface Perm {
  read: boolean;
  write: boolean;
  execute: boolean;
}

export interface Permissions {
  owner: Perm;
  group: Perm;
  other: Perm;
}

function permToDigit(p: Perm): number {
  return (p.read ? 4 : 0) + (p.write ? 2 : 0) + (p.execute ? 1 : 0);
}

function digitToPerm(d: number): Perm {
  return { read: (d & 4) !== 0, write: (d & 2) !== 0, execute: (d & 1) !== 0 };
}

/** Three-digit octal string, e.g. "755". */
export function toOctal(p: Permissions): string {
  return `${permToDigit(p.owner)}${permToDigit(p.group)}${permToDigit(p.other)}`;
}

/** Symbolic notation, e.g. "rwxr-xr-x". */
export function toSymbolic(p: Permissions): string {
  const part = (x: Perm) => `${x.read ? 'r' : '-'}${x.write ? 'w' : '-'}${x.execute ? 'x' : '-'}`;
  return part(p.owner) + part(p.group) + part(p.other);
}

/** Parse "755" or "0755" into permissions. Throws on bad input. */
export function fromOctal(input: string): Permissions {
  const s = input.trim().replace(/^0o?/i, '');
  if (!/^[0-7]{3}$/.test(s)) throw new Error('Enter three octal digits (0–7), e.g. 755.');
  return {
    owner: digitToPerm(Number(s[0])),
    group: digitToPerm(Number(s[1])),
    other: digitToPerm(Number(s[2])),
  };
}

/** Parse "rwxr-xr-x" into permissions. Throws on bad input. */
export function fromSymbolic(input: string): Permissions {
  const s = input.trim();
  if (!/^[rwx-]{9}$/.test(s)) {
    throw new Error('Symbolic notation is 9 chars from r, w, x, -.');
  }
  const parse = (chunk: string): Perm => ({
    read: chunk[0] === 'r',
    write: chunk[1] === 'w',
    execute: chunk[2] === 'x',
  });
  return {
    owner: parse(s.slice(0, 3)),
    group: parse(s.slice(3, 6)),
    other: parse(s.slice(6, 9)),
  };
}
