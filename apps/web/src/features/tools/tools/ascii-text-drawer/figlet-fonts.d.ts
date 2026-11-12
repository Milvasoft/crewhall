// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-text-drawer/figlet-fonts.d.ts. See THIRD_PARTY.md.
// figlet ships each importable font as a JS module exporting the raw FLF string.
declare module 'figlet/importable-fonts/*' {
  const font: string;
  export default font;
}
