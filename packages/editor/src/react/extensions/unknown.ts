import { Mark, Node } from '@tiptap/core';
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Forward compatibility of shared documents. A client older than the document meets node types
 * and marks its schema does not have, and the Yjs binding gives up on the whole page when it
 * cannot build one: the page opens empty and read-only.
 *
 * Here such content is shown as a placeholder node instead. The placeholder is only this
 * client's view: the shared Y element stays as it was, because the binding keeps an element it
 * has mapped to a node for as long as the node object stays in the document. A newer client
 * still sees the real content.
 */

export const UNKNOWN_BLOCK = 'unknownBlock';
export const UNKNOWN_MARK = 'unknownMark';

/** Stands in for a mark this schema does not have; its text then becomes a placeholder. */
export const UnknownMark = Mark.create({
  name: UNKNOWN_MARK,

  parseHTML() {
    return [];
  },

  renderHTML() {
    return ['span', 0];
  },
});

const hasUnknown = (content: Fragment, schema: Schema) => {
  let found = false;
  content.forEach((child) => {
    if (child.type.name === UNKNOWN_BLOCK) found = true;
    if (child.marks.some((m) => m.type === schema.marks[UNKNOWN_MARK])) found = true;
  });
  return found;
};

const tolerant = new WeakSet<Schema>();

/**
 * Makes the calls the Yjs binding uses to build nodes accept what the schema does not know. The
 * binding has no hook for this, and it asks the schema by name, so these two methods are it.
 * The smallest ancestor that stays valid is what becomes the placeholder: an unknown inline node
 * takes its paragraph with it, an unknown first block its to-do.
 */
function tolerateUnknownContent(schema: Schema): void {
  if (tolerant.has(schema)) return;
  tolerant.add(schema);
  const node = schema.node.bind(schema);
  const mark = schema.mark.bind(schema);
  const placeholder = (name: string) => node(UNKNOWN_BLOCK, { nodeName: name });

  schema.mark = (type, attrs) =>
    typeof type === 'string' && !schema.marks[type] ? mark(UNKNOWN_MARK) : mark(type, attrs);

  schema.node = (type, attrs, content, marks) => {
    if (typeof type !== 'string') return node(type, attrs, content, marks);
    const nodeType = schema.nodes[type];
    if (!nodeType) return placeholder(type);
    const children = Fragment.from(content);
    if (!hasUnknown(children, schema)) return node(type, attrs, content, marks);
    const textBlock = nodeType.inlineContent;
    if (textBlock || !nodeType.validContent(children)) return placeholder(type);
    return node(type, attrs, content, marks);
  };
}

interface Placed {
  node: PMNode;
  index: number;
  /** The types around it, outermost first. */
  path: string;
}

function unknownBlocks(doc: PMNode): { all: PMNode[]; placed: Placed[] } {
  const all: PMNode[] = [];
  const placed: Placed[] = [];
  const walk = (parent: PMNode, path: string) => {
    parent.forEach((child) => {
      if (child.type.name === UNKNOWN_BLOCK) {
        placed.push({ node: child, index: all.length, path });
      }
      all.push(child);
      walk(child, `${path}/${child.type.name}`);
    });
  };
  walk(doc, '');
  return { all, placed };
}

/**
 * A move, a copy or a new wrapper around a placeholder would make the binding create a new
 * element from it, and the real content would be gone for everyone. Deleting it stays possible.
 */
export function keepsUnknownInPlace(before: PMNode, after: PMNode): boolean {
  const was = unknownBlocks(before);
  const now = unknownBlocks(after);
  if (!was.placed.length && !now.placed.length) return true;

  const counts = new Map<PMNode, number>();
  for (const { node } of was.placed) counts.set(node, (counts.get(node) ?? 0) + 1);
  for (const { node } of now.placed) {
    const left = counts.get(node) ?? 0;
    if (left === 0) return false;
    counts.set(node, left - 1);
  }

  const indexNow = new Map<PMNode, number>();
  now.all.forEach((node, i) => {
    if (!indexNow.has(node)) indexNow.set(node, i);
  });
  for (const placed of now.placed) {
    const old = was.placed.find((p) => p.node === placed.node);
    if (!old || old.path !== placed.path) return false;
    for (let i = 0; i < was.all.length; i++) {
      const at = indexNow.get(was.all[i]!);
      if (at === undefined || i === old.index) continue;
      if (i < old.index !== at < placed.index) return false;
    }
  }
  return true;
}

/** The placeholder for content this client cannot show. */
export const UnknownBlock = Node.create({
  name: UNKNOWN_BLOCK,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { nodeName: { default: null, rendered: false } };
  },

  // Never read back from a clipboard: a copy could not bring the real content along.
  parseHTML() {
    return [];
  },

  renderHTML() {
    return ['div', { 'data-type': 'unknown-block' }];
  },

  addProseMirrorPlugins() {
    tolerateUnknownContent(this.editor.schema);
    return [
      new Plugin({
        key: new PluginKey('chUnknownBlock'),
        filterTransaction: (tr) =>
          !tr.docChanged ||
          Boolean(tr.getMeta('y-sync$')) ||
          keepsUnknownInPlace(tr.before, tr.doc),
      }),
    ];
  },
});
