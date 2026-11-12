// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/id-generator/logic.ts. See THIRD_PARTY.md.
/**
 * Local ID generation. Uses the platform CSPRNG (crypto.getRandomValues), no
 * network, no third party. UUID v7 and ULID are implemented here because they
 * are small and avoid extra dependencies.
 */

export type IdKind = 'uuid4' | 'uuid7' | 'ulid' | 'guid';

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

const hex: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b.subarray(0, 16), (x) => hex[x]!).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function uuidV4(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40; // version 4
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  return bytesToUuid(b);
}

export function uuidV7(now = Date.now()): string {
  const b = randomBytes(16);
  // 48-bit big-endian Unix millisecond timestamp.
  b[0] = (now / 2 ** 40) & 0xff;
  b[1] = (now / 2 ** 32) & 0xff;
  b[2] = (now / 2 ** 24) & 0xff;
  b[3] = (now / 2 ** 16) & 0xff;
  b[4] = (now / 2 ** 8) & 0xff;
  b[5] = now & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant
  return bytesToUuid(b);
}

// Crockford's Base32 (excludes I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number): string {
  let out = '';
  for (let i = 9; i >= 0; i--) {
    out = CROCKFORD[now % 32] + out;
    now = Math.floor(now / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

export function ulid(now = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function generate(kind: IdKind): string {
  switch (kind) {
    case 'uuid4':
      return uuidV4();
    case 'guid':
      return uuidV4().toUpperCase();
    case 'uuid7':
      return uuidV7();
    case 'ulid':
      return ulid();
  }
}

export interface GenerateOptions {
  count: number;
  uppercase?: boolean;
  hyphens?: boolean; // UUID/GUID only
  braces?: boolean; // GUID {…}
}

export function generateMany(kind: IdKind, opts: GenerateOptions): string[] {
  const { count } = opts;
  const out: string[] = [];
  for (let i = 0; i < Math.max(0, Math.min(count, 10000)); i++) {
    let id = generate(kind);
    if (kind === 'uuid4' || kind === 'uuid7' || kind === 'guid') {
      if (opts.hyphens === false) id = id.replace(/-/g, '');
      if (opts.uppercase) id = id.toUpperCase();
      else if (kind !== 'guid') id = id.toLowerCase();
      if (opts.braces) id = `{${id}}`;
    } else if (opts.uppercase === false) {
      id = id.toLowerCase();
    }
    out.push(id);
  }
  return out;
}
