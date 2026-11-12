// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/markdown-viewer/logic.ts. See THIRD_PARTY.md.
import { marked } from 'marked';

marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Convert Markdown to an HTML string. This output is UNSANITIZED, callers that
 * inject it into the DOM must sanitize first (the component uses DOMPurify).
 * Kept pure/sync so it is easy to unit test in Node.
 */
export function markdownToHtml(md: string): string {
  if (!md) return '';
  return marked.parse(md, { async: false }) as string;
}
