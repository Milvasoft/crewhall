import type { EditorDoc, JSONMark, JSONNode } from '../model';

const sameMarks = (a?: JSONMark[], b?: JSONMark[]) =>
  JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Joins neighbouring text nodes with the same marks (the canonical form of the model). */
function mergeText(nodes: JSONNode[]): JSONNode[] {
  const out: JSONNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text' && n.type === 'text' && sameMarks(prev.marks, n.marks)) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? '') + (n.text ?? '') };
    } else out.push(n);
  }
  return out;
}

function publicNode(node: JSONNode): JSONNode | null {
  if (node.type === 'embed') return null;
  // A Drive file has no address outside the Hub.
  if (node.type === 'video' && String(node.attrs?.src ?? '').startsWith('node:')) return null;
  if (node.type === 'mention') {
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : '';
    if (!label) return null;
    return node.marks?.length
      ? { type: 'text', text: label, marks: node.marks }
      : { type: 'text', text: label };
  }
  if (!node.content) return node;
  const content = mergeText(node.content.map(publicNode).filter((c): c is JSONNode => c !== null));
  if (!content.length && node.content.length) {
    // A block container emptied by a removed embed still needs one block; an emptied
    // paragraph (only empty mentions) has no content at all.
    if (node.content.some((c) => c.type === 'embed')) {
      return { ...node, content: [{ type: 'paragraph' }] };
    }
    const rest: JSONNode = { ...node };
    delete rest.content;
    return rest;
  }
  return { ...node, content };
}

/**
 * The document as it may leave the Hub (portal publish, design 10.13): mentions become their
 * plain label (no `@`, no link to the Hub), embeds of Hub nodes and videos in Drive are removed,
 * toggles stay (a
 * public site renders them as `<details>`). Pure; the input is not changed.
 */
export function toPublicDoc(doc: EditorDoc): EditorDoc {
  const content = mergeText(
    (doc.content ?? []).map(publicNode).filter((c): c is JSONNode => c !== null),
  );
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
