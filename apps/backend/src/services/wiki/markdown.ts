import {
  docToMarkdown as editorDocToMarkdown,
  markdownToDoc as editorMarkdownToDoc,
  type EditorDoc,
} from '@crewhall/editor';
import type { PMDoc } from './doc';

/**
 * Markdown ↔ page document, through `@crewhall/editor` (the same conversion as the portal):
 * GFM plus directives for `:::note[Title]` admonitions, `:::toggle[Summary]` and
 * `::embed{node="<id>"}`; mentions stay links, `[@label](mention:<kind>:<id>)`, so they survive a
 * round trip (MCP read → write). Front matter of an
 * imported file is dropped (pages have no front matter).
 */

export function markdownToDoc(markdown: string): PMDoc {
  const { doc } = editorMarkdownToDoc(markdown);
  const content = (doc.content ?? []) as PMDoc['content'];
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Without the final newline (stored, diffed and returned to MCP clients as is). */
export const docToMarkdown = (doc: PMDoc): string =>
  editorDocToMarkdown(doc as EditorDoc).replace(/\n+$/, '');
