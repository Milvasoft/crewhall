import { docToMarkdown, markdownToDoc, type EditorDoc } from '@crewhall/editor';

/**
 * Quick notes (2.6) keep their text as line-based Markdown, which mobile shows and edits as
 * plain text: every line is its own block, list lines follow each other, a ``` fence holds
 * code. The web card edits them with the shared block editor; these turn one into the other
 * without changing what a note says.
 */

const LIST_LINE = /^\s*([-*+]\s|\d+[.)]\s)/;
const TASK_LINE = /^\s*[-*+]\s\[[ xX]\]\s/;
const QUOTE_LINE = /^\s*>/;
const FENCE = /^\s*(```|~~~)/;

/** Same kind of list line: "- [ ] a" and "- b" are two lists, as the note shows them. */
const sameList = (a: string, b: string) =>
  LIST_LINE.test(a) && LIST_LINE.test(b) && TASK_LINE.test(a) === TASK_LINE.test(b);

/** Note text → the Markdown of each block (each line one block, lists and fences together). */
export function noteBlocks(text: string): string[] {
  const blocks: string[][] = [];
  let inFence = false;
  let prev: string | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (inFence) {
      blocks.at(-1)!.push(line);
      if (FENCE.test(line)) inFence = false;
      continue;
    }
    if (!line.trim()) {
      prev = null;
      continue;
    }
    const sameBlock =
      prev !== null &&
      (sameList(prev, line) ||
        (QUOTE_LINE.test(line) && QUOTE_LINE.test(prev)) ||
        // Indented lines continue a list item (nested lists, wrapped text).
        (/^\s+\S/.test(line) && LIST_LINE.test(prev)));
    if (sameBlock) blocks.at(-1)!.push(line);
    else blocks.push([line]);
    if (FENCE.test(line)) inFence = true;
    prev = line;
  }
  return blocks.map((b) => b.join('\n'));
}

export function noteToDoc(text: string): EditorDoc {
  const content = noteBlocks(text).flatMap((md) => markdownToDoc(md).doc.content ?? []);
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Editor document → note text: one block per line, line breaks inside a block become lines. */
export function noteFromDoc(doc: EditorDoc): string {
  const lines: string[] = [];
  for (const block of doc.content ?? []) {
    const md = docToMarkdown({ type: 'doc', content: [block] }).trim();
    if (!md) continue;
    const isCode = block.type === 'codeBlock' || block.type === 'mermaid';
    // Tight lists and hard breaks (`\` at the end of a line) read as plain lines.
    lines.push(isCode ? md : md.replace(/\\\n/g, '\n').replace(/\n\n+/g, '\n'));
  }
  return lines.join('\n');
}
