// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/lorem-ipsum/logic.ts. See THIRD_PARTY.md.
const WORDS = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud ' +
  'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute ' +
  'irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur ' +
  'excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt ' +
  'mollit anim id est laborum'
).split(' ');

export type LoremUnit = 'words' | 'sentences' | 'paragraphs';

function rand(max: number): number {
  return Math.floor(Math.random() * max);
}

function makeSentence(): string {
  const len = 6 + rand(10);
  const words = Array.from({ length: len }, () => WORDS[rand(WORDS.length)]);
  const s = words.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function makeParagraph(): string {
  const len = 3 + rand(4);
  return Array.from({ length: len }, makeSentence).join(' ');
}

export function generateLorem(count: number, unit: LoremUnit, startWithLorem = true): string {
  const n = Math.max(1, Math.min(count, 1000));
  if (unit === 'words') {
    const words = Array.from({ length: n }, () => WORDS[rand(WORDS.length)]);
    if (startWithLorem) words.splice(0, 2, 'lorem', 'ipsum');
    const s = words.slice(0, n).join(' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (unit === 'sentences') {
    const arr = Array.from({ length: n }, makeSentence);
    if (startWithLorem) arr[0] = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    return arr.join(' ');
  }
  const arr = Array.from({ length: n }, makeParagraph);
  if (startWithLorem) {
    arr[0] = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' + arr[0];
  }
  return arr.join('\n\n');
}
