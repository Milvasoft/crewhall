import * as Y from 'yjs';
import { DrawingElement } from '@crewhall/shared';

/**
 * Yjs helpers for the module's two documents (doc 17 §6):
 *
 * - `card:<id>`: the card description as the ProseMirror fragment `default` (the shape
 *   y-prosemirror and the Tiptap editor use), so the block editor can bind to it as is.
 * - `drawing:<nodeId>`: Excalidraw elements in the map `elements`, keyed by element id,
 *   each value the element's JSON. Merging is per element: the higher `version` wins and a
 *   tie is broken by the lower `versionNonce`, the rule Excalidraw's own reconciler uses.
 */

export const DESCRIPTION_FRAGMENT = 'default';
export const ELEMENTS_MAP = 'elements';

export function docFrom(state: Uint8Array | null | undefined): Y.Doc {
  const doc = new Y.Doc();
  if (state && state.length) Y.applyUpdate(doc, state);
  return doc;
}

export const encode = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc));

/* -------------------------------- descriptions -------------------------------- */

function textOfNode(node: Y.XmlElement | Y.XmlText | Y.XmlHook): string {
  if (node instanceof Y.XmlText) return node.toString().replace(/<[^>]+>/g, '');
  if (node instanceof Y.XmlElement) {
    const inner = node
      .toArray()
      .map((c) => textOfNode(c as Y.XmlElement | Y.XmlText))
      .join(isBlock(node.nodeName) ? '\n' : '');
    return node.nodeName === 'listItem' ? `• ${inner}` : inner;
  }
  return '';
}

const isBlock = (name: string) =>
  ['bulletList', 'orderedList', 'taskList', 'blockquote', 'listItem', 'taskItem'].includes(name);

/** Plain text of a description document (desc_text, search, excerpts). */
export function descriptionText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment(DESCRIPTION_FRAGMENT);
  return fragment
    .toArray()
    .map((n) => textOfNode(n as Y.XmlElement | Y.XmlText))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Replaces the description with plain text: paragraphs per line, `- ` / `• ` lines as a
 * bullet list. Applied as a Yjs change, so open editors receive it like any edit.
 */
export function setDescription(doc: Y.Doc, text: string) {
  const fragment = doc.getXmlFragment(DESCRIPTION_FRAGMENT);
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    // Built before insertion (prelim types), so emptiness is tracked here, not read back.
    const blocks: { el: Y.XmlElement; empty: boolean }[] = [];
    let list: Y.XmlElement | null = null;
    for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
      const bullet = /^\s*[-•*]\s+(.*)$/.exec(raw);
      if (bullet) {
        if (!list) {
          list = new Y.XmlElement('bulletList');
          blocks.push({ el: list, empty: false });
        }
        const item = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText(bullet[1])]);
        item.insert(0, [p]);
        list.push([item]);
        continue;
      }
      list = null;
      const p = new Y.XmlElement('paragraph');
      if (raw.length) p.insert(0, [new Y.XmlText(raw)]);
      blocks.push({ el: p, empty: raw.length === 0 });
    }
    while (blocks.length && blocks.at(-1)!.empty) blocks.pop();
    fragment.insert(
      0,
      blocks.map((b) => b.el),
    );
  });
}

/** Text of a description state for an API response (`description`). */
export function descriptionOfState(state: Uint8Array | null | undefined): string {
  if (!state || state.length === 0) return '';
  return descriptionText(docFrom(state));
}

/* ----------------------------------- scenes ----------------------------------- */

export type Element = DrawingElement & Record<string, unknown>;

function newer(a: Element, b: Element | undefined) {
  if (!b) return true;
  if (a.version !== b.version) return a.version > b.version;
  return (a.versionNonce ?? 0) < (b.versionNonce ?? 0);
}

/** Elements of a scene document in z-order (fractional `index`, then id). */
export function sceneElements(doc: Y.Doc, opts: { includeDeleted?: boolean } = {}): Element[] {
  const map = doc.getMap<Element>(ELEMENTS_MAP);
  const out: Element[] = [];
  for (const value of map.values()) {
    const parsed = DrawingElement.safeParse(value);
    if (!parsed.success) continue;
    if (!opts.includeDeleted && parsed.data.isDeleted) continue;
    out.push(value);
  }
  return out.sort((x, y) => {
    const ix = x.index ?? '';
    const iy = y.index ?? '';
    if (ix !== iy) return ix < iy ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

/** Writes the elements that are newer than what the map holds; returns how many changed. */
export function mergeElements(doc: Y.Doc, elements: Element[], origin?: unknown): number {
  const map = doc.getMap<Element>(ELEMENTS_MAP);
  let changed = 0;
  doc.transact(() => {
    for (const el of elements) {
      if (newer(el, map.get(el.id))) {
        map.set(el.id, el);
        changed++;
      }
    }
  }, origin);
  return changed;
}

/** Elements that are not deleted (the "element count" of Drive and the editor's empty state). */
export function liveCount(doc: Y.Doc): number {
  let n = 0;
  for (const v of doc.getMap<Element>(ELEMENTS_MAP).values()) if (v && !v.isDeleted) n++;
  return n;
}

/** File ids referenced by live image elements. */
export function referencedFiles(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  for (const el of sceneElements(doc)) {
    if (el.type === 'image' && typeof el.fileId === 'string') ids.add(el.fileId);
  }
  return ids;
}
