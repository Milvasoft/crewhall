import { getSchema } from '@tiptap/core';
import { Node as PMNode, type Schema } from '@tiptap/pm/model';
import type { EditorDoc, JSONNode } from '../model';
import { createExtensions } from './extensions';
import { UNKNOWN_BLOCK, UNKNOWN_MARK } from './extensions/unknown';

let schema: Schema | null = null;

/** The schema of the headless extension set (built once). */
export function editorSchema(): Schema {
  schema ??= getSchema(createExtensions());
  return schema;
}

function unknownAttribute(s: Schema, node: JSONNode): string | null {
  const type = s.nodes[node.type];
  if (type) {
    for (const key of Object.keys(node.attrs ?? {})) {
      if (!(key in (type.spec.attrs ?? {}))) return `${node.type}.${key}`;
    }
  }
  for (const mark of node.marks ?? []) {
    const markType = s.marks[mark.type];
    for (const key of Object.keys(mark.attrs ?? {})) {
      if (markType && !(key in (markType.spec.attrs ?? {}))) return `${mark.type}.${key}`;
    }
  }
  for (const child of node.content ?? []) {
    const found = unknownAttribute(s, child);
    if (found) return found;
  }
  return null;
}

/** The placeholders for unknown content exist only in an open editor, never in a document. */
function hasPlaceholder(node: JSONNode): boolean {
  return (
    node.type === UNKNOWN_BLOCK ||
    (node.marks ?? []).some((m) => m.type === UNKNOWN_MARK) ||
    (node.content ?? []).some(hasPlaceholder)
  );
}

/**
 * Checks a document against the editor schema: node and mark names, attributes and content
 * rules (e.g. a list item starts with a paragraph). Use it before saving imported content.
 */
export function validateDoc(doc: EditorDoc): { ok: true } | { ok: false; error: string } {
  const s = editorSchema();
  try {
    if (doc.type !== 'doc') return { ok: false, error: 'Top node must be "doc"' };
    if (hasPlaceholder(doc as JSONNode)) {
      return { ok: false, error: 'A placeholder for unknown content is not document content' };
    }
    const unknown = unknownAttribute(s, doc as JSONNode);
    if (unknown) return { ok: false, error: `Unknown attribute ${unknown}` };
    PMNode.fromJSON(s, doc).check();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
