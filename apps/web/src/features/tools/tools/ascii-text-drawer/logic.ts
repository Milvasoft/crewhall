// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/ascii-text-drawer/logic.ts. See THIRD_PARTY.md.
import figlet, { type FontName } from 'figlet';
import Standard from 'figlet/importable-fonts/Standard.js';
import Big from 'figlet/importable-fonts/Big.js';
import Small from 'figlet/importable-fonts/Small.js';
import Slant from 'figlet/importable-fonts/Slant.js';
import Banner from 'figlet/importable-fonts/Banner.js';
import Shadow from 'figlet/importable-fonts/Shadow.js';
import Mini from 'figlet/importable-fonts/Mini.js';
import Doom from 'figlet/importable-fonts/Doom.js';
import Ghost from 'figlet/importable-fonts/Ghost.js';
import Block from 'figlet/importable-fonts/Block.js';

/**
 * ASCII-art text (figlet) rendering with a bundled set of fonts, so it runs
 * fully offline. Pure and local.
 */

const FONT_DATA: Record<string, string> = {
  Standard,
  Big,
  Small,
  Slant,
  Banner,
  Shadow,
  Mini,
  Doom,
  Ghost,
  Block,
};

export const FONTS = Object.keys(FONT_DATA);

let registered = false;
function ensureFonts() {
  if (registered) return;
  for (const [name, data] of Object.entries(FONT_DATA)) {
    figlet.parseFont(name, data);
  }
  registered = true;
}

export function renderAscii(text: string, font = 'Standard', width = 80): string {
  ensureFonts();
  if (!FONT_DATA[font]) throw new Error(`Unknown font "${font}".`);
  return figlet.textSync(text, {
    font: font as FontName,
    width,
    whitespaceBreak: true,
  });
}
