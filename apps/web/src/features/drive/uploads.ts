import { type DriveNode } from '@crewhall/shared';
import { type QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, isApiError } from '@/lib/api';
import { newId } from '@/lib/ids';
import { invalidateDrive } from './api';

/**
 * Upload manager (doc 17 §8, design 3.7): presigned multipart, 16 MiB parts, four PUTs in
 * parallel, progress per byte. A dropped connection pauses the file; it resumes from the
 * parts the store already has (getUpload), also after a reload once the file is picked again.
 */

export const PARALLEL_PARTS = 4;
const PART_RETRIES = 3;
const STORAGE_KEY = 'crewhall.uploads';

export type ConflictChoice = 'version' | 'replace' | 'rename';

export type UploadStatus =
  | 'queued'
  | 'uploading'
  | 'paused'
  | 'conflict'
  | 'done'
  | 'error'
  | 'canceled'
  /** Known from a previous page load; the File must be picked again to resume. */
  | 'interrupted';

export interface UploadItem {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  spaceId: string;
  parentId: string | null;
  /** Folder name for "Sunumlar" in the row. */
  folderName: string;
  /** New version of an existing node instead of a new file. */
  nodeId?: string;
  status: UploadStatus;
  loaded: number;
  /** Bytes per second, smoothed. */
  speed: number;
  uploadId: string | null;
  error: string | null;
  /** Existing node when the name is taken (3.14). */
  conflictNodeId: string | null;
  onConflict: 'ask' | ConflictChoice;
  result: DriveNode | null;
  file: File | null;
  lastModified: number;
}

interface Persisted {
  id: string;
  name: string;
  sizeBytes: number;
  mime: string;
  spaceId: string;
  parentId: string | null;
  folderName: string;
  nodeId?: string;
  uploadId: string;
  lastModified: number;
}

let items: UploadItem[] = loadInterrupted();
let panelOpen = items.length > 0;
let queryClient: QueryClient | null = null;
const listeners = new Set<() => void>();
const controllers = new Map<string, AbortController>();
let snapshot = { items, panelOpen };

function emit() {
  snapshot = { items, panelOpen };
  listeners.forEach((l) => l());
}

function patch(id: string, p: Partial<UploadItem>) {
  items = items.map((x) => (x.id === id ? { ...x, ...p } : x));
  emit();
}

function get(id: string): UploadItem | undefined {
  return items.find((x) => x.id === id);
}

/** Chat attachments follow their uploads outside React (outbox). */
export function getUpload(id: string): UploadItem | undefined {
  return get(id);
}

export function subscribeUploads(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useUploads() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** The app root hands over its QueryClient so finished uploads refresh the lists. */
export function bindUploads(qc: QueryClient): void {
  queryClient = qc;
}

export function setUploadPanelOpen(v: boolean): void {
  panelOpen = v;
  emit();
}

/** Tests: start from an empty manager. */
export function resetUploads(): void {
  for (const c of controllers.values()) c.abort();
  controllers.clear();
  items = [];
  panelOpen = false;
  persist();
  emit();
}

// ---- persistence of unfinished uploads ----

function persist() {
  try {
    const keep: Persisted[] = items
      .filter((x) => x.uploadId && ['uploading', 'paused', 'interrupted'].includes(x.status))
      .map((x) => ({
        id: x.id,
        name: x.name,
        sizeBytes: x.sizeBytes,
        mime: x.mime,
        spaceId: x.spaceId,
        parentId: x.parentId,
        folderName: x.folderName,
        nodeId: x.nodeId,
        uploadId: x.uploadId!,
        lastModified: x.lastModified,
      }));
    if (keep.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(keep));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best effort */
  }
}

function loadInterrupted(): UploadItem[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as Persisted[]) : [];
    return list.map((p) => ({
      ...p,
      status: 'interrupted' as const,
      loaded: 0,
      speed: 0,
      error: null,
      conflictNodeId: null,
      onConflict: 'ask' as const,
      result: null,
      file: null,
    }));
  } catch {
    return [];
  }
}

// ---- queue ----

export interface UploadTarget {
  spaceId: string;
  parentId: string | null;
  folderName: string;
}

/**
 * Queues files and returns their upload ids. Chat attachments pass `onConflict: 'rename'`
 * (no conflict prompt for a message) and `quiet` so the Drive upload panel stays closed.
 */
export function addUploads(
  files: File[],
  target: UploadTarget,
  opts: { nodeId?: string; onConflict?: ConflictChoice; quiet?: boolean } = {},
): string[] {
  const added: UploadItem[] = files.map((file) => ({
    id: newId(),
    name: file.name,
    sizeBytes: file.size,
    mime: file.type,
    ...target,
    nodeId: opts.nodeId,
    status: 'queued',
    loaded: 0,
    speed: 0,
    uploadId: null,
    error: null,
    conflictNodeId: null,
    onConflict: opts.onConflict ?? 'ask',
    result: null,
    file,
    lastModified: file.lastModified,
  }));
  items = [...items, ...added];
  if (!opts.quiet) panelOpen = true;
  emit();
  pump();
  return added.map((x) => x.id);
}

/** Two files at a time; each sends four parts in parallel. */
function pump() {
  const active = items.filter((x) => x.status === 'uploading').length;
  const next = items.filter((x) => x.status === 'queued').slice(0, Math.max(0, 2 - active));
  for (const it of next) void run(it.id);
}

export function resolveConflict(
  id: string,
  choice: ConflictChoice | 'skip',
  applyToRest = false,
): void {
  const targets = applyToRest
    ? items.filter((x) => x.status === 'conflict').map((x) => x.id)
    : [id];
  for (const t of targets) {
    if (choice === 'skip') patch(t, { status: 'canceled', conflictNodeId: null });
    else patch(t, { status: 'queued', onConflict: choice, conflictNodeId: null });
  }
  pump();
}

export function cancelUpload(id: string): void {
  const it = get(id);
  if (!it) return;
  controllers.get(id)?.abort();
  if (it.uploadId && it.status !== 'done') {
    void api.call('abortUpload', { params: { uploadId: it.uploadId } }).catch(() => undefined);
  }
  patch(id, { status: 'canceled' });
  persist();
  pump();
}

export function cancelAllConflicts(): void {
  for (const it of items.filter((x) => x.status === 'conflict')) {
    patch(it.id, { status: 'canceled' });
  }
  pump();
}

export function retryUpload(id: string): void {
  const it = get(id);
  if (!it || !it.file) return;
  patch(id, { status: 'queued', error: null });
  pump();
}

/** After a reload: the person picks the same file again and the upload continues. */
export function resumeWithFile(id: string, file: File): boolean {
  const it = get(id);
  if (!it || file.name !== it.name || file.size !== it.sizeBytes) return false;
  patch(id, { file, status: 'queued', error: null });
  pump();
  return true;
}

export function clearFinished(): void {
  items = items.filter((x) => !['done', 'canceled', 'error'].includes(x.status));
  if (!items.length) panelOpen = false;
  emit();
}

// ---- one file ----

async function run(id: string) {
  const it = get(id);
  if (!it || !it.file) return;
  const file = it.file;
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  patch(id, { status: 'uploading', error: null });
  try {
    let upload = it.uploadId
      ? await api.call('getUpload', { params: { uploadId: it.uploadId } })
      : null;
    if (!upload || upload.status !== 'uploading') {
      upload = await api.call('createUpload', {
        body: {
          spaceId: it.spaceId,
          parentId: it.parentId,
          name: it.name,
          sizeBytes: it.sizeBytes,
          mime: it.mime || undefined,
          onConflict: it.onConflict,
          nodeId: it.nodeId,
        },
      });
      patch(id, { uploadId: upload.id });
      persist();
    }

    const done = new Map(upload.uploadedParts.map((p) => [p.partNumber, p.etag]));
    const partSize = upload.partSize;
    const sizeOf = (n: number) => Math.min(partSize, it.sizeBytes - (n - 1) * partSize);
    const progress = new Map<number, number>();
    for (const n of done.keys()) progress.set(n, sizeOf(n));
    const started = Date.now();
    const base = [...progress.values()].reduce((a, b) => a + b, 0);
    const report = () => {
      const loaded = [...progress.values()].reduce((a, b) => a + b, 0);
      const secs = Math.max(0.25, (Date.now() - started) / 1000);
      patch(id, { loaded, speed: (loaded - base) / secs });
    };
    report();

    const todo = Array.from({ length: upload.partCount }, (_, i) => i + 1).filter(
      (n) => !done.has(n),
    );
    const urls = new Map<number, string>();
    for (let i = 0; i < todo.length; i += 100) {
      const batch = todo.slice(i, i + 100);
      const res = await api.call('getUploadPartUrls', {
        params: { uploadId: upload.id },
        body: { partNumbers: batch },
        signal: ctrl.signal,
      });
      for (const p of res.parts) urls.set(p.partNumber, p.url);
    }

    let cursor = 0;
    const worker = async () => {
      while (cursor < todo.length) {
        const n = todo[cursor++]!;
        const body = file.slice((n - 1) * partSize, (n - 1) * partSize + sizeOf(n));
        const etag = await putPart(urls.get(n)!, body, ctrl.signal, (b) => {
          progress.set(n, b);
          report();
        });
        done.set(n, etag);
        progress.set(n, body.size);
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, todo.length) }, worker));

    const res = await api.call('completeUpload', {
      params: { uploadId: upload.id },
      body: {
        parts: [...done.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([partNumber, etag]) => ({ partNumber, etag })),
      },
    });
    patch(id, { status: 'done', loaded: it.sizeBytes, result: res.node, file: null });
    if (queryClient) invalidateDrive(queryClient);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    if (isApiError(e, 'node_name_taken')) {
      const details = e.details as { nodeId?: string } | undefined;
      patch(id, { status: 'conflict', conflictNodeId: details?.nodeId ?? null });
    } else if (e instanceof NetworkError || (e instanceof TypeError && !navigator.onLine)) {
      // Keep the upload: the parts already sent stay on the server.
      patch(id, { status: 'paused', error: 'network' });
    } else {
      patch(id, { status: 'error', error: isApiError(e) ? e.code : 'internal' });
    }
  } finally {
    controllers.delete(id);
    persist();
    pump();
  }
}

class NetworkError extends Error {}

/** PUT one part with progress; retries with backoff before giving up as a network error. */
export async function putPart(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await xhrPut(url, body, signal, onProgress);
    } catch (e) {
      if (signal.aborted || attempt >= PART_RETRIES - 1) throw e;
      onProgress(0);
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

function xhrPut(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress: (b: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(new NetworkError(`part ${xhr.status}`));
    };
    xhr.onerror = () => reject(new NetworkError('network'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

// Resume paused uploads when the connection comes back.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    for (const it of items.filter((x) => x.status === 'paused' && x.file)) {
      patch(it.id, { status: 'queued', error: null });
    }
    pump();
  });
}
