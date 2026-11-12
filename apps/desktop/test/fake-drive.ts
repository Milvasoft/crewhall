import { readFile, writeFile } from 'node:fs/promises';
import type { RemoteDrive, RemoteNode } from '../src/sync/remote';

interface FakeNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder' | 'other';
  content: Buffer;
  version: number | null;
  updatedAt: string;
  trashed: boolean;
}

/** In-memory Drive of one space with the server's rules that matter to the sync. */
export class FakeDrive implements RemoteDrive {
  readonly nodes = new Map<string, FakeNode>();
  readonly calls: string[] = [];
  /** Names the server refuses to move or rename, like a network or permission failure. */
  readonly failMoves = new Set<string>();
  private seq = 0;
  private clock = Date.parse('2026-10-22T10:00:00.000Z');

  constructor(readonly spaceId = 'space-1') {}

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private view(n: FakeNode): RemoteNode {
    return {
      id: n.id,
      name: n.name,
      kind: n.kind,
      size: n.content.length,
      version: n.version,
      updatedAt: n.updatedAt,
      trashed: n.trashed,
    };
  }

  private child(parentId: string | null, name: string): FakeNode | undefined {
    return [...this.nodes.values()].find(
      (n) => n.parentId === parentId && n.name === name && !n.trashed,
    );
  }

  private add(
    parentId: string | null,
    name: string,
    kind: FakeNode['kind'],
    content = '',
  ): FakeNode {
    if (this.child(parentId, name))
      throw Object.assign(new Error('node_name_taken'), { status: 409 });
    const node: FakeNode = {
      id: `n${++this.seq}`,
      parentId,
      name,
      kind,
      content: Buffer.from(content),
      version: kind === 'file' ? 1 : null,
      updatedAt: this.tick(),
      trashed: false,
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /** Test helpers address nodes by path ("docs/a.txt"), creating parent folders. */
  find(path: string): FakeNode | undefined {
    let parent: string | null = null;
    let node: FakeNode | undefined;
    for (const name of path.split('/')) {
      node = this.child(parent, name);
      if (!node) return undefined;
      parent = node.id;
    }
    return node;
  }

  mkdir(path: string): FakeNode {
    let parent: string | null = null;
    let node: FakeNode | undefined;
    for (const name of path.split('/')) {
      node = this.child(parent, name) ?? this.add(parent, name, 'folder');
      parent = node.id;
    }
    return node!;
  }

  put(path: string, content: string): FakeNode {
    const i = path.lastIndexOf('/');
    const parent = i < 0 ? null : this.mkdir(path.slice(0, i)).id;
    const existing = this.find(path);
    if (existing) {
      existing.content = Buffer.from(content);
      existing.version = (existing.version ?? 0) + 1;
      existing.updatedAt = this.tick();
      return existing;
    }
    return this.add(parent, path.slice(i + 1), 'file', content);
  }

  /** Someone renamed or moved it on the server: the same node, the same version. */
  relocate(path: string, to: string): FakeNode {
    const node = this.find(path)!;
    const i = to.lastIndexOf('/');
    node.parentId = i < 0 ? null : this.mkdir(to.slice(0, i)).id;
    node.name = to.slice(i + 1);
    node.updatedAt = this.tick();
    return node;
  }

  remove(path: string): void {
    const node = this.find(path);
    if (node) this.trashTree(node.id);
  }

  read(path: string): string | undefined {
    return this.find(path)?.content.toString();
  }

  /** "docs/", "docs/a.txt=hello" lines of the live tree, sorted. */
  tree(): string[] {
    const out: string[] = [];
    const walk = (parentId: string | null, prefix: string) => {
      for (const n of this.nodes.values()) {
        if (n.parentId !== parentId || n.trashed || n.kind === 'other') continue;
        const path = prefix + n.name;
        if (n.kind === 'folder') {
          out.push(`${path}/`);
          walk(n.id, `${path}/`);
        } else out.push(`${path}=${n.content.toString()}`);
      }
    };
    walk(null, '');
    return out.sort();
  }

  private trashTree(id: string): void {
    for (const n of this.nodes.values()) {
      if (n.id === id || n.parentId === id) {
        if (n.id !== id) this.trashTree(n.id);
        n.trashed = true;
      }
    }
  }

  // ---- RemoteDrive ----

  async getNode(nodeId: string) {
    const n = this.nodes.get(nodeId);
    return n ? this.view(n) : null;
  }

  async list(_spaceId: string, parentId: string | null) {
    this.calls.push(`list ${parentId ?? 'root'}`);
    return [...this.nodes.values()].filter((n) => n.parentId === parentId).map((n) => this.view(n));
  }

  async createFolder(_spaceId: string, parentId: string | null, name: string) {
    this.calls.push(`mkdir ${name}`);
    return this.view(this.add(parentId, name, 'folder'));
  }

  async upload(
    _spaceId: string,
    parentId: string | null,
    name: string,
    file: { path: string; size: number },
    nodeId?: string,
  ) {
    this.calls.push(`upload ${name}${nodeId ? ' (version)' : ''}`);
    const content = await readFile(file.path);
    if (nodeId) {
      const n = this.nodes.get(nodeId)!;
      n.content = content;
      n.version = (n.version ?? 0) + 1;
      n.updatedAt = this.tick();
      return this.view(n);
    }
    const n = this.add(parentId, name, 'file');
    n.content = content;
    return this.view(n);
  }

  async move(
    nodeId: string,
    target: { spaceId: string; parentId: string | null } | null,
    name: string | null,
  ) {
    const n = this.nodes.get(nodeId)!;
    this.calls.push(`move ${n.name}${target ? ' (folder)' : ''}${name ? ` -> ${name}` : ''}`);
    if (this.failMoves.has(n.name)) throw new Error('move refused');
    const parentId = target ? target.parentId : n.parentId;
    const newName = name ?? n.name;
    if (this.child(parentId, newName))
      throw Object.assign(new Error('node_name_taken'), { status: 409 });
    n.parentId = parentId;
    n.name = newName;
  }

  async download(nodeId: string, dest: string) {
    this.calls.push(`download ${this.nodes.get(nodeId)!.name}`);
    await writeFile(dest, this.nodes.get(nodeId)!.content);
  }

  async trash(nodeId: string) {
    this.calls.push(`trash ${this.nodes.get(nodeId)!.name}`);
    this.trashTree(nodeId);
  }
}
