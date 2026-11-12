// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/html-markdown/logic.ts. See THIRD_PARTY.md.
import TurndownService from 'turndown';

const service = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});

/** Convert HTML to Markdown. Pure and deterministic. */
export function htmlToMarkdown(html: string): string {
  return service.turndown(html).trim();
}
