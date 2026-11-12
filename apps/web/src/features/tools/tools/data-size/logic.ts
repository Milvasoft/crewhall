// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/data-size/logic.ts. See THIRD_PARTY.md.
/**
 * Data-size unit conversion. Everything is normalized through a canonical
 * value in **bytes**, then re-expressed in every other unit. Pure and
 * dependency-free so it runs entirely in the browser.
 */

export interface SizeUnit {
  id: string;
  label: string;
  /** How many bytes one of this unit represents. */
  bytes: number;
  group: 'decimal' | 'binary' | 'bits';
}

export const SIZE_UNITS: SizeUnit[] = [
  { id: 'bit', label: 'bit', bytes: 1 / 8, group: 'bits' },
  { id: 'kbit', label: 'Kbit', bytes: 1e3 / 8, group: 'bits' },
  { id: 'mbit', label: 'Mbit', bytes: 1e6 / 8, group: 'bits' },
  { id: 'gbit', label: 'Gbit', bytes: 1e9 / 8, group: 'bits' },

  { id: 'b', label: 'Byte', bytes: 1, group: 'decimal' },
  { id: 'kb', label: 'KB', bytes: 1e3, group: 'decimal' },
  { id: 'mb', label: 'MB', bytes: 1e6, group: 'decimal' },
  { id: 'gb', label: 'GB', bytes: 1e9, group: 'decimal' },
  { id: 'tb', label: 'TB', bytes: 1e12, group: 'decimal' },
  { id: 'pb', label: 'PB', bytes: 1e15, group: 'decimal' },

  { id: 'kib', label: 'KiB', bytes: 1024, group: 'binary' },
  { id: 'mib', label: 'MiB', bytes: 1024 ** 2, group: 'binary' },
  { id: 'gib', label: 'GiB', bytes: 1024 ** 3, group: 'binary' },
  { id: 'tib', label: 'TiB', bytes: 1024 ** 4, group: 'binary' },
  { id: 'pib', label: 'PiB', bytes: 1024 ** 5, group: 'binary' },
];

const UNIT_MAP = new Map(SIZE_UNITS.map((u) => [u.id, u]));

export function unitById(id: string): SizeUnit | undefined {
  return UNIT_MAP.get(id);
}

/** Convert `value` of unit `fromId` into bytes. Throws on unknown unit. */
export function toBytes(value: number, fromId: string): number {
  const unit = UNIT_MAP.get(fromId);
  if (!unit) throw new Error(`Unknown unit: ${fromId}`);
  return value * unit.bytes;
}

/** Express a byte count in unit `toId`. */
export function fromBytes(bytes: number, toId: string): number {
  const unit = UNIT_MAP.get(toId);
  if (!unit) throw new Error(`Unknown unit: ${toId}`);
  return bytes / unit.bytes;
}

export interface ConversionRow {
  unit: SizeUnit;
  value: number;
}

/** Convert `value`/`fromId` into every known unit. */
export function convertAll(value: number, fromId: string): ConversionRow[] {
  const bytes = toBytes(value, fromId);
  return SIZE_UNITS.map((unit) => ({ unit, value: bytes / unit.bytes }));
}

/**
 * Format a number for display: avoids scientific notation for human-scale
 * values, trims trailing zeros, and keeps large/small magnitudes readable.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-6) return n.toExponential(4).replace(/\.?0+e/, 'e');
  // Up to 6 significant decimals, then strip trailing zeros.
  const fixed = n.toFixed(abs >= 1 ? 4 : 8);
  return fixed.replace(/\.?0+$/, '');
}

/**
 * Human-readable "best fit" size (e.g. 1536 bytes → "1.5 KiB"), used for the
 * headline readout. `binary` picks 1024-based units (IEC), otherwise decimal.
 */
export function humanize(bytes: number, binary = true): string {
  if (bytes === 0) return '0 B';
  const base = binary ? 1024 : 1000;
  const units = binary
    ? ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
    : ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(base)));
  const val = bytes / base ** i;
  return `${formatNumber(val)} ${units[i]}`;
}
