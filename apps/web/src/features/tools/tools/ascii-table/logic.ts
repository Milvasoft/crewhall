// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-table/logic.ts. See THIRD_PARTY.md.
/**
 * ASCII reference data (0–127). Pure and local, the table is generated once
 * and filtered client-side.
 */

/** Human names + descriptions for the 33 non-printable control codes. */
const CONTROL: Record<number, { name: string; desc: string }> = {
  0: { name: 'NUL', desc: 'Null' },
  1: { name: 'SOH', desc: 'Start of Heading' },
  2: { name: 'STX', desc: 'Start of Text' },
  3: { name: 'ETX', desc: 'End of Text' },
  4: { name: 'EOT', desc: 'End of Transmission' },
  5: { name: 'ENQ', desc: 'Enquiry' },
  6: { name: 'ACK', desc: 'Acknowledge' },
  7: { name: 'BEL', desc: 'Bell' },
  8: { name: 'BS', desc: 'Backspace' },
  9: { name: 'HT', desc: 'Horizontal Tab' },
  10: { name: 'LF', desc: 'Line Feed' },
  11: { name: 'VT', desc: 'Vertical Tab' },
  12: { name: 'FF', desc: 'Form Feed' },
  13: { name: 'CR', desc: 'Carriage Return' },
  14: { name: 'SO', desc: 'Shift Out' },
  15: { name: 'SI', desc: 'Shift In' },
  16: { name: 'DLE', desc: 'Data Link Escape' },
  17: { name: 'DC1', desc: 'Device Control 1 (XON)' },
  18: { name: 'DC2', desc: 'Device Control 2' },
  19: { name: 'DC3', desc: 'Device Control 3 (XOFF)' },
  20: { name: 'DC4', desc: 'Device Control 4' },
  21: { name: 'NAK', desc: 'Negative Acknowledge' },
  22: { name: 'SYN', desc: 'Synchronous Idle' },
  23: { name: 'ETB', desc: 'End of Transmission Block' },
  24: { name: 'CAN', desc: 'Cancel' },
  25: { name: 'EM', desc: 'End of Medium' },
  26: { name: 'SUB', desc: 'Substitute' },
  27: { name: 'ESC', desc: 'Escape' },
  28: { name: 'FS', desc: 'File Separator' },
  29: { name: 'GS', desc: 'Group Separator' },
  30: { name: 'RS', desc: 'Record Separator' },
  31: { name: 'US', desc: 'Unit Separator' },
  32: { name: 'SP', desc: 'Space' },
  127: { name: 'DEL', desc: 'Delete' },
};

export interface AsciiRow {
  dec: number;
  hex: string;
  oct: string;
  binary: string;
  /** Printable glyph, or the control mnemonic (e.g. "NUL"). */
  glyph: string;
  /** True when the code has a visible glyph (33–126). */
  printable: boolean;
  name: string;
  desc: string;
}

export const ASCII_TABLE: AsciiRow[] = Array.from({ length: 128 }, (_, dec) => {
  const control = CONTROL[dec];
  const printable = dec > 32 && dec < 127;
  const char = String.fromCharCode(dec);
  return {
    dec,
    hex: dec.toString(16).toUpperCase().padStart(2, '0'),
    oct: dec.toString(8).padStart(3, '0'),
    binary: dec.toString(2).padStart(8, '0'),
    glyph: printable ? char : (control?.name ?? ''),
    printable,
    name: control?.name ?? char,
    desc: control?.desc ?? `Character "${char}"`,
  };
});

/** Filter rows by a free-text query across code, char, name and description. */
export function filterAscii(query: string): AsciiRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return ASCII_TABLE;
  return ASCII_TABLE.filter((r) => {
    return (
      String(r.dec) === q ||
      r.hex.toLowerCase() === q ||
      r.hex.toLowerCase() === q.replace(/^0x/, '') ||
      r.glyph.toLowerCase() === q ||
      r.name.toLowerCase().includes(q) ||
      r.desc.toLowerCase().includes(q)
    );
  });
}
