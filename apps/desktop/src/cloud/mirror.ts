import type { DriveChange, DriveChangesPage, DriveNode } from '@crewhall/shared';
import { toRemoteNode, type RemoteDrive, type RemoteNode } from '../sync/remote';

/** The Drive change feed; `page()` without a cursor gives the current head and no items. */
export interface ChangeFeed {
  page(cursor?: string): Promise<DriveChangesPage>;
}

export type Lister = Pick<RemoteDrive, 'list'>;

interface MirrorNode extends RemoteNode {
  parentId: string | null;
}

/** One space's tree, by id, with what each folder holds. */
class SpaceTree {
  readonly nodes = new Map<string, MirrorNode>();
  private readonly kids = new Map<string | null, Set<string>>();

  put(node: MirrorNode): void {
    const old = this.nodes.get(node.id);
    if (old && old.parentId !== node.parentId) this.kids.get(old.parentId)?.delete(node.id);
    this.nodes.set(node.id, node);
    let siblings = this.kids.get(node.parentId);
    if (!siblings) this.kids.set(node.parentId, (siblings = new Set()));
    siblings.add(node.id);
  }

  remove(id: string): void {
    for (const kid of [...(this.kids.get(id) ?? [])]) this.remove(kid);
    this.kids.delete(id);
    const node = this.nodes.get(id);
    if (node) this.kids.get(node.parentId)?.delete(id);
    this.nodes.delete(id);
  }

  list(parentId: string | null): RemoteNode[] {
    return [...(this.kids.get(parentId) ?? [])].map((id) => this.nodes.get(id)!);
  }
}

export interface PollResult {
  /** Spaces whose files changed. */
  changed: Set<string>;
  /** A space was added, removed or renamed: the list of spaces needs reading again. */
  spacesChanged: boolean;
}

function isExpired(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 410;
}

function mirrorNode(n: DriveNode): MirrorNode {
  return { ...toRemoteNode(n), parentId: n.parentId };
}

/**
 * The server's tree kept current from the change feed, so a pass need not list every folder.
 *
 * A pass reads this instead of the server, and reads a missing item as deleted there. So nothing
 * may go missing here: what this computer changes is written in right away (the feed is seconds
 * behind), a listing replaces data only once it is complete, and a space not loaded refuses to
 * answer rather than reading as empty.
 */
export class RemoteMirror implements Lister {
  private readonly trees = new Map<string, SpaceTree>();
  private cursor: string | null = null;
  /** Writes made while a listing runs, which that listing may not have seen. */
  private journal: Array<() => void> = [];
  private listings = 0;

  constructor(
    private readonly server: Lister,
    private readonly feed: ChangeFeed,
  ) {}

  /** Head first: what changes during the listing then arrives through the feed. */
  async start(spaceIds: string[]): Promise<void> {
    this.cursor = (await this.feed.page()).nextCursor;
    await Promise.all(spaceIds.map((id) => this.load(id)));
  }

  async setSpaces(spaceIds: string[]): Promise<void> {
    for (const id of this.trees.keys()) if (!spaceIds.includes(id)) this.trees.delete(id);
    await Promise.all(spaceIds.filter((id) => !this.trees.has(id)).map((id) => this.load(id)));
  }

  list(spaceId: string, parentId: string | null): Promise<RemoteNode[]> {
    const tree = this.trees.get(spaceId);
    if (!tree) return Promise.reject(new Error(`space not loaded: ${spaceId}`));
    return Promise.resolve(tree.list(parentId));
  }

  /** Reads the feed to its end. A failure keeps the cursor of the last page applied. */
  async poll(): Promise<PollResult> {
    const result: PollResult = { changed: new Set(), spacesChanged: false };
    if (this.cursor === null) throw new Error('not started');
    try {
      for (;;) {
        const page = await this.feed.page(this.cursor);
        for (const change of page.items) await this.apply(change, result);
        this.cursor = page.nextCursor;
        if (!page.hasMore) return result;
      }
    } catch (err) {
      if (!isExpired(err)) throw err;
    }
    await this.start([...this.trees.keys()]);
    return { changed: new Set(this.trees.keys()), spacesChanged: true };
  }

  /** The same drive; what it changes on the server is written here as well. */
  tracking(drive: RemoteDrive): RemoteDrive {
    const write = (change: () => void): void => {
      change();
      if (this.listings > 0) this.journal.push(change);
    };
    return {
      getNode: (id) => drive.getNode(id),
      list: (spaceId, parentId) => drive.list(spaceId, parentId),
      download: (id, dest) => drive.download(id, dest),
      createFolder: async (spaceId, parentId, name) => {
        const node = await drive.createFolder(spaceId, parentId, name);
        write(() => this.trees.get(spaceId)?.put({ ...node, parentId }));
        return node;
      },
      upload: async (spaceId, parentId, name, file, nodeId, onTaken) => {
        const node = await drive.upload(spaceId, parentId, name, file, nodeId, onTaken);
        write(() => this.trees.get(spaceId)?.put({ ...node, parentId }));
        return node;
      },
      move: async (nodeId, target, name) => {
        await drive.move(nodeId, target, name);
        write(() => {
          const tree = this.treeOf(nodeId);
          const node = tree?.nodes.get(nodeId);
          if (!node) return;
          tree!.put({
            ...node,
            parentId: target ? target.parentId : node.parentId,
            name: name ?? node.name,
          });
        });
      },
      trash: async (nodeId) => {
        await drive.trash(nodeId);
        write(() => this.treeOf(nodeId)?.remove(nodeId));
      },
    };
  }

  private treeOf(nodeId: string): SpaceTree | undefined {
    return [...this.trees.values()].find((t) => t.nodes.has(nodeId));
  }

  /** Everything under `parentId`, read before anything here changes. */
  private async read(spaceId: string, parentId: string | null): Promise<MirrorNode[]> {
    const out: MirrorNode[] = [];
    const queue = [parentId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const n of await this.server.list(spaceId, parent)) {
        if (n.trashed || n.kind === 'other') continue;
        out.push({ ...n, parentId: parent });
        if (n.kind === 'folder') queue.push(n.id);
      }
    }
    return out;
  }

  /** Writes from this computer made meanwhile go on top: the listing may have missed them. */
  private async listing(work: () => Promise<() => void>): Promise<void> {
    this.listings++;
    try {
      const swap = await work();
      swap();
      for (const change of this.journal) change();
    } finally {
      if (--this.listings === 0) this.journal = [];
    }
  }

  private load(spaceId: string): Promise<void> {
    return this.listing(async () => {
      const nodes = await this.read(spaceId, null);
      return () => {
        const tree = new SpaceTree();
        for (const node of nodes) tree.put(node);
        this.trees.set(spaceId, tree);
      };
    });
  }

  private reload(spaceId: string, folder: MirrorNode): Promise<void> {
    return this.listing(async () => {
      const nodes = await this.read(spaceId, folder.id);
      return () => {
        const tree = this.trees.get(spaceId);
        if (!tree) return;
        tree.remove(folder.id);
        tree.put(folder);
        for (const node of nodes) tree.put(node);
      };
    });
  }

  private async apply(change: DriveChange, result: PollResult): Promise<void> {
    const { type, spaceId, nodeId, node } = change;
    const tree = this.trees.get(spaceId);
    switch (type) {
      case 'created':
      case 'updated':
      case 'moved':
      case 'accessGained': {
        if (!node) {
          // The whole space came into view.
          result.spacesChanged = true;
          if (tree) await this.load(spaceId);
          result.changed.add(spaceId);
          return;
        }
        const previous = this.treeOf(node.id);
        const next = mirrorNode(node);
        if (previous && previous !== tree) {
          previous.remove(node.id);
          for (const [id, t] of this.trees) if (t === previous) result.changed.add(id);
        }
        if (!tree) return;
        result.changed.add(spaceId);
        if (next.trashed) {
          tree.remove(node.id);
        } else if (
          next.kind === 'folder' &&
          (type === 'accessGained' || (type === 'moved' && previous !== tree))
        ) {
          await this.reload(spaceId, next);
        } else if (next.kind !== 'other') {
          tree.put(next);
        }
        return;
      }
      case 'deleted':
      case 'accessLost': {
        if (nodeId) {
          const holder = this.treeOf(nodeId);
          holder?.remove(nodeId);
          if (holder) for (const [id, t] of this.trees) if (t === holder) result.changed.add(id);
          return;
        }
        result.spacesChanged = true;
        this.trees.delete(spaceId);
        return;
      }
      case 'accessChanged': {
        // Only shares inside the space remain: what can be seen is no longer the same.
        const role = node ? node.myRole : change.space?.myRole;
        if (role === null) {
          result.spacesChanged = true;
          if (tree) await this.load(spaceId);
          result.changed.add(spaceId);
        }
        return;
      }
      case 'spaceUpdated':
        result.spacesChanged = true;
        return;
      case 'spaceRemoved':
        result.spacesChanged = true;
        this.trees.delete(spaceId);
        return;
    }
  }
}
