// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-to-nato/logic.ts. See THIRD_PARTY.md.
/**
 * Spell text using the NATO phonetic alphabet (plus digits and a few marks).
 * Pure and local.
 */

export const NATO: Record<string, string> = {
  a: 'Alfa',
  b: 'Bravo',
  c: 'Charlie',
  d: 'Delta',
  e: 'Echo',
  f: 'Foxtrot',
  g: 'Golf',
  h: 'Hotel',
  i: 'India',
  j: 'Juliett',
  k: 'Kilo',
  l: 'Lima',
  m: 'Mike',
  n: 'November',
  o: 'Oscar',
  p: 'Papa',
  q: 'Quebec',
  r: 'Romeo',
  s: 'Sierra',
  t: 'Tango',
  u: 'Uniform',
  v: 'Victor',
  w: 'Whiskey',
  x: 'X-ray',
  y: 'Yankee',
  z: 'Zulu',
  '0': 'Zero',
  '1': 'One',
  '2': 'Two',
  '3': 'Three',
  '4': 'Four',
  '5': 'Five',
  '6': 'Six',
  '7': 'Seven',
  '8': 'Eight',
  '9': 'Nine',
  '.': 'Stop',
  ',': 'Comma',
  '-': 'Dash',
  '@': 'At',
  ' ': '(space)',
};

/**
 * Convert text to NATO words. Each recognized character becomes its code word;
 * unknown characters are wrapped in brackets so nothing is silently dropped.
 */
export function textToNato(input: string, separator = ' '): string {
  return Array.from(input.toLowerCase())
    .map((ch) => NATO[ch] ?? `[${ch}]`)
    .join(separator);
}
