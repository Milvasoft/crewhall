import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ApiClient } from '@crewhall/api-client';
import type { DriveChangesPage, DriveNode } from '@crewhall/shared';
import { isCaseInsensitive, joinPath, localNameProblem, type SyncPlatform } from './names';
import type { RemoteEntry, SkippedItem, Snapshot } from './types';

/** A Drive node as the sync sees it; pages, boards and drawings are `other` and never synced. */
export interface RemoteNode {
  id: string;
  name: string;
  kind: 'file' | 'folder' | 'other';
  size: number;
  version: number | null;
  updatedAt: string;
  trashed: boolean;
}

/** The Drive operations the sync needs; the app uses the HTTP API, tests an in-memory fake. */
export interface RemoteDrive {
  getNode(nodeId: string): Promise<RemoteNode | null>;
  list(spaceId: string, parentId: string | null): Promise<RemoteNode[]>;
  createFolder(spaceId: string, parentId: string | null, name: string): Promise<RemoteNode>;
  /** `nodeId`: store as a new version of that file. */
  upload(
    spaceId: string,
    parentId: string | null,
    name: string,
    file: { path: string; size: number },
    nodeId?: string,
    /** A new file whose name is taken: stop and ask (the default), or keep both. */
    onTaken?: 'ask' | 'rename',
  ): Promise<RemoteNode>;
  /**
   * Renames and/or moves a node, keeping its id, versions and shares. `target`: another folder;
   * `name`: another name. Null where that does not change.
   */
  move(
    nodeId: string,
    target: { spaceId: string; parentId: string | null } | null,
    name: string | null,
  ): Promise<void>;
  /** Writes the current version of a file to `dest`. */
  download(nodeId: string, dest: string): Promise<void>;
  trash(nodeId: string): Promise<void>;
}

export function toRemoteNode(n: DriveNode): RemoteNode {
  return {
    id: n.id,
    name: n.name,
    kind: n.type === 'file' ? 'file' : n.type === 'folder' ? 'folder' : 'other',
    size: n.sizeBytes,
    version: n.version,
    updatedAt: n.updatedAt,
    trashed: n.deletedAt !== null,
  };
}

export interface RemoteScan {
  entries: Snapshot<RemoteEntry>;
  skipped: SkippedItem[];
}

/**
 * Lists the synced folder recursively. Names this computer cannot hold, and the second of two
 * names that differ only in case on Windows and macOS, are skipped. A listing error throws:
 * a missing listing must never read as "everything was deleted".
 */
export async function scanRemote(
  drive: Pick<RemoteDrive, 'list'>,
  spaceId: string,
  rootId: string | null,
  platform: SyncPlatform,
): Promise<RemoteScan> {
  const entries: Snapshot<RemoteEntry> = new Map();
  const skipped: SkippedItem[] = [];
  const queue: Array<[rel: string, id: string | null]> = [['', rootId]];

  while (queue.length > 0) {
    const [rel, parentId] = queue.shift()!;
    const children = (await drive.list(spaceId, parentId))
      .filter((n) => !n.trashed && n.kind !== 'other')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const seen = new Set<string>();
    for (const n of children) {
      const path = joinPath(rel, n.name);
      const problem = localNameProblem(n.name, platform);
      if (problem) {
        skipped.push({ path, side: 'remote', reason: problem });
        continue;
      }
      const key = isCaseInsensitive(platform) ? n.name.toLowerCase() : n.name;
      if (seen.has(key)) {
        skipped.push({ path, side: 'remote', reason: 'case_clash' });
        continue;
      }
      seen.add(key);
      entries.set(path, {
        kind: n.kind === 'folder' ? 'folder' : 'file',
        nodeId: n.id,
        size: n.size,
        version: n.version,
        updatedAt: n.updatedAt,
      });
      if (n.kind === 'folder') queue.push([path, n.id]);
    }
  }
  return { entries, skipped };
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** RemoteDrive over the /api/v1 Drive endpoints (multipart upload, signed download URLs). */
export function createApiDrive(api: ApiClient, fetchFn: Fetch): RemoteDrive {
  return {
    async getNode(nodeId) {
      try {
        return toRemoteNode(await api.call('getNode', { params: { nodeId } }));
      } catch (err) {
        if (isStatus(err, 404) || isStatus(err, 403)) return null;
        throw err;
      }
    },

    async list(spaceId, parentId) {
      const out: RemoteNode[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.call('listNodes', {
          params: { spaceId },
          query: { parentId: parentId ?? undefined, limit: 100, cursor },
        });
        out.push(...page.items.map(toRemoteNode));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return out;
    },

    async createFolder(spaceId, parentId, name) {
      const node = await api.call('createFolder', {
        params: { spaceId },
        body: { parentId, name },
      });
      return toRemoteNode(node);
    },

    async upload(spaceId, parentId, name, file, nodeId, onTaken = 'ask') {
      const upload = await api.call('createUpload', {
        body: {
          spaceId,
          parentId,
          name,
          sizeBytes: file.size,
          ...(nodeId ? { nodeId, onConflict: 'version' as const } : { onConflict: onTaken }),
        },
      });
      try {
        const handle = await open(file.path, 'r');
        const parts: Array<{ partNumber: number; etag: string }> = [];
        try {
          for (let first = 1; first <= upload.partCount; first += 100) {
            const numbers = Array.from(
              { length: Math.min(100, upload.partCount - first + 1) },
              (_, i) => first + i,
            );
            const { parts: urls } = await api.call('getUploadPartUrls', {
              params: { uploadId: upload.id },
              body: { partNumbers: numbers },
            });
            for (const { partNumber, url } of urls) {
              const start = (partNumber - 1) * upload.partSize;
              const length = Math.max(0, Math.min(upload.partSize, file.size - start));
              const buffer = Buffer.alloc(length);
              if (length > 0) await handle.read(buffer, 0, length, start);
              const res = await fetchFn(url, { method: 'PUT', body: buffer });
              if (!res.ok) throw new Error(`part ${partNumber}: HTTP ${res.status}`);
              const etag = res.headers.get('etag');
              if (!etag) throw new Error(`part ${partNumber}: no ETag`);
              parts.push({ partNumber, etag });
            }
          }
        } finally {
          await handle.close();
        }
        const done = await api.call('completeUpload', {
          params: { uploadId: upload.id },
          body: { parts },
        });
        return toRemoteNode(done.node);
      } catch (err) {
        await api.call('abortUpload', { params: { uploadId: upload.id } }).catch(() => undefined);
        throw err;
      }
    },

    async download(nodeId, dest) {
      const { url } = await api.call('getDownloadUrl', {
        params: { nodeId },
        query: { disposition: 'attachment' },
      });
      const res = await fetchFn(url);
      if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(dest),
      );
    },

    async trash(nodeId) {
      await api.call('trashNodes', { body: { nodeIds: [nodeId] } });
    },

    async move(nodeId, target, name) {
      const relocate = async () => {
        if (target) await api.call('moveNodes', { body: { nodeIds: [nodeId], target } });
      };
      const rename = async () => {
        if (name) await api.call('updateNode', { params: { nodeId }, body: { name } });
      };
      try {
        await relocate();
        await rename();
      } catch (err) {
        // The old name is taken in the new folder: the other order gets through.
        if (!target || !name || !isStatus(err, 409)) throw err;
        await rename();
        await relocate();
      }
    },
  };
}

/** The Drive change feed, for what the sync handles. Other node types are left out by the server. */
export function createChangeFeed(api: ApiClient): {
  page(cursor?: string): Promise<DriveChangesPage>;
} {
  return {
    page: (cursor) =>
      api.call('listDriveChanges', { query: { cursor, limit: 200, types: 'folder,file' } }),
  };
}

/** The bytes of a file from `from` on, for the virtual drive; a server without ranges works too. */
export function createContentSource(
  api: ApiClient,
  fetchFn: Fetch,
): {
  read(nodeId: string, from: number, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
} {
  return {
    async read(nodeId, from, signal) {
      const { url } = await api.call('getDownloadUrl', {
        params: { nodeId },
        query: { disposition: 'attachment' },
      });
      const res = await fetchFn(url, {
        signal,
        ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {}),
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw Object.assign(new Error(`download: HTTP ${res.status}`), { status: res.status });
      }
      const body = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
      return res.status === 206 || from === 0 ? body : skipBytes(body, from);
    },
  };
}

async function* skipBytes(
  source: AsyncIterable<Uint8Array>,
  count: number,
): AsyncGenerator<Uint8Array> {
  let left = count;
  for await (const chunk of source) {
    if (left >= chunk.byteLength) {
      left -= chunk.byteLength;
      continue;
    }
    yield left > 0 ? chunk.subarray(left) : chunk;
    left = 0;
  }
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;
}
