import type * as Y from 'yjs';

/**
 * Excalidraw ⇄ Yjs binding for `drawing:<nodeId>` (doc 17 §6). The document keeps every
 * element (deleted ones as tombstones) in the map `elements`, keyed by id, valued with the
 * element's JSON. Per element the higher `version` wins and a tie goes to the lower
 * `versionNonce`, Excalidraw's own reconcile rule. Yjs resolves two concurrent writes of a
 * key by client id instead, so a client whose local element is newer than what arrived
 * writes it again: every client converges on the highest version.
 *
 * y-excalidraw (MIT) targets Excalidraw 0.17; this is the same idea for 0.18, small and ours.
 */

export const ELEMENTS_MAP = 'elements';
export const LOCAL = 'excalidraw-local';

export interface SceneElement {
  id: string;
  version: number;
  versionNonce?: number;
  isDeleted?: boolean;
  index?: string | null;
  [key: string]: unknown;
}

export function isNewer(a: SceneElement, b: SceneElement | undefined): boolean {
  if (!b) return true;
  if (a.version !== b.version) return a.version > b.version;
  return (a.versionNonce ?? 0) < (b.versionNonce ?? 0);
}

const same = (a: SceneElement, b: { version: number; versionNonce?: number } | undefined) =>
  !!b && a.version === b.version && (a.versionNonce ?? 0) === (b.versionNonce ?? 0);

/** Z-order: fractional index, then id (stable across clients). */
export function sortScene<T extends SceneElement>(elements: T[]): T[] {
  return elements.sort((x, y) => {
    const ix = x.index ?? '';
    const iy = y.index ?? '';
    if (ix !== iy) return ix < iy ? -1 : 1;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

export class SceneSync {
  private readonly map: Y.Map<SceneElement>;
  /** Version of every element as last written or applied by this client. */
  private readonly seen = new Map<string, { version: number; versionNonce?: number }>();
  private readonly observer: (e: Y.YMapEvent<SceneElement>, tx: Y.Transaction) => void;

  constructor(
    private readonly doc: Y.Doc,
    private readonly getLocal: () => readonly SceneElement[],
    private readonly apply: (elements: SceneElement[], changedIds: string[]) => void,
  ) {
    this.map = doc.getMap<SceneElement>(ELEMENTS_MAP);
    for (const [k, v] of this.map) {
      this.seen.set(k, { version: v.version, versionNonce: v.versionNonce });
    }
    this.observer = (event, tx) => {
      if (tx.origin === LOCAL) return;
      this.onRemote([...event.keysChanged]);
    };
    this.map.observe(this.observer);
  }

  /** Every element currently in the document, z-ordered (initial scene). */
  elements(): SceneElement[] {
    return sortScene([...this.map.values()]);
  }

  /** Writes local elements that changed since this client last saw them. Returns the count. */
  pushLocal(elements: readonly SceneElement[]): number {
    const changed: SceneElement[] = [];
    for (const el of elements) {
      if (same(el, this.seen.get(el.id))) continue;
      if (isNewer(el, this.map.get(el.id))) changed.push(el);
      this.seen.set(el.id, { version: el.version, versionNonce: el.versionNonce });
    }
    if (changed.length) {
      this.doc.transact(() => {
        for (const el of changed) this.map.set(el.id, toPlain(el));
      }, LOCAL);
    }
    return changed.length;
  }

  private onRemote(keys: string[]) {
    const local = new Map(this.getLocal().map((e) => [e.id, e]));
    const reassert: SceneElement[] = [];
    const incoming: string[] = [];
    for (const key of keys) {
      const remote = this.map.get(key);
      const mine = local.get(key);
      if (!remote) continue;
      if (mine && isNewer(mine, remote) && !same(mine, remote)) {
        reassert.push(mine);
      } else {
        incoming.push(key);
        this.seen.set(key, { version: remote.version, versionNonce: remote.versionNonce });
      }
    }
    if (reassert.length) {
      // After the current transaction: Yjs does not allow nested writes from observers.
      queueMicrotask(() =>
        this.doc.transact(() => {
          for (const el of reassert) this.map.set(el.id, toPlain(el));
        }, LOCAL),
      );
    }
    if (!incoming.length) return;
    const merged = new Map(local);
    for (const key of incoming) merged.set(key, this.map.get(key)!);
    this.apply(sortScene([...merged.values()]), incoming);
  }

  destroy() {
    this.map.unobserve(this.observer);
  }
}

/** Excalidraw elements are frozen objects with no prototypes worth keeping; Yjs stores JSON. */
function toPlain(el: SceneElement): SceneElement {
  return JSON.parse(JSON.stringify(el)) as SceneElement;
}

/** Elements whose version differs from a previous snapshot (HTTP fallback saves). */
export function changedSince(
  elements: readonly SceneElement[],
  previous: Map<string, number>,
): SceneElement[] {
  return elements.filter((e) => previous.get(e.id) !== e.version);
}
