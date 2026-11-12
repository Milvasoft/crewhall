import type { CloudFetchEvent, CloudFilesNative } from './native';

/** Where the bytes of a file come from: the app reads the server, tests a fake. */
export interface ContentSource {
  /** The current version of the file from byte `from` to its end. */
  read(nodeId: string, from: number, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
}

export interface FetchProgress {
  path: string;
  /** Bytes of the file that are here so far. */
  done: number;
  total: number;
  state: 'running' | 'done' | 'failed';
}

export interface FetchServerOptions {
  native: Pick<CloudFilesNative, 'transfer' | 'transferFail'>;
  /** Of the connection that asked; it may have been replaced since. */
  connection: () => string;
  source: ContentSource;
  onProgress?: (progress: FetchProgress) => void;
  /** A download without a new byte for this long fails, so the program reading it is not stuck. */
  stallMs?: number;
  maxRunning?: number;
  pieceBytes?: number;
}

/** Windows takes data in multiples of this, except at the end of the file. */
export const TRANSFER_ALIGN = 4096;

/** NTSTATUS the program reading the file gets, as a read error. */
export const FetchStatus = {
  networkUnavailable: 0xc000cf11,
  unsuccessful: 0xc000cf12,
  accessDenied: 0xc000cf18,
} as const;

/** Well under the minute after which Windows gives up on a provider that sends nothing. */
const STALL_MS = 30_000;
/** Opening a folder of photos must not start hundreds of downloads. */
const MAX_RUNNING = 4;
const PIECE_BYTES = 1024 * 1024;

class SizeMismatch extends Error {}
class Stalled extends Error {}

/** Cuts a stream into pieces Windows accepts: aligned, and only the last one may be short. */
export async function* alignedPieces(
  source: AsyncIterable<Uint8Array>,
  pieceBytes = PIECE_BYTES,
): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    held.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    bytes += chunk.byteLength;
    if (bytes < pieceBytes) continue;
    const all = Buffer.concat(held, bytes);
    const whole = all.length - (all.length % TRANSFER_ALIGN);
    yield all.subarray(0, whole);
    const rest = all.subarray(whole);
    held = rest.length > 0 ? [rest] : [];
    bytes = rest.length;
  }
  if (bytes > 0) yield Buffer.concat(held, bytes);
}

export function statusOf(err: unknown): number {
  if (err instanceof SizeMismatch) return FetchStatus.unsuccessful;
  if (err instanceof Stalled) return FetchStatus.networkUnavailable;
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return FetchStatus.accessDenied;
  // An answer from the server means the network works; no answer means it does not.
  return typeof status === 'number' ? FetchStatus.unsuccessful : FetchStatus.networkUnavailable;
}

/** Rejects when `work` takes too long or the download is dropped, whatever `work` does then. */
function bounded<T>(work: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const { signal } = controller;
    const onAbort = () => finish(() => reject(new Stalled('dropped')));
    const timer = setTimeout(() => {
      finish(() => reject(new Stalled(`nothing for ${ms} ms`)));
      controller.abort();
    }, ms);
    const finish = (then: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      then();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    work.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err as Error)),
    );
  });
}

async function* boundedStream(
  open: () => Promise<AsyncIterable<Uint8Array>>,
  ms: number,
  controller: AbortController,
): AsyncGenerator<Uint8Array> {
  const source = await bounded(open(), ms, controller);
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await bounded(iterator.next(), ms, controller);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

interface Job {
  event: CloudFetchEvent;
  controller: AbortController;
  /** Nobody waits any more: no read error to give. */
  dropped: boolean;
}

/**
 * Answers Windows when something reads a file that is not here yet. Always the rest of the whole
 * file: a closed program sends no prompt cancel, and a part left behind would hold up the next
 * reader until Windows times it out.
 */
export class FetchServer {
  private readonly jobs = new Map<string, Job>();
  private readonly waiting: Job[] = [];
  private running = 0;

  constructor(private readonly options: FetchServerOptions) {}

  handle(event: CloudFetchEvent): void {
    this.drop(event.transferKey);
    if (event.type === 'cancel') return;
    const job: Job = { event, controller: new AbortController(), dropped: false };
    this.jobs.set(event.transferKey, job);
    this.waiting.push(job);
    this.pump();
  }

  /** Everything still going fails now rather than when Windows times it out. */
  stop(): void {
    this.waiting.length = 0;
    for (const job of this.jobs.values()) {
      job.dropped = true;
      job.controller.abort();
      void this.fail(job, new Stalled('stopped'));
    }
    this.jobs.clear();
  }

  private drop(transferKey: string): void {
    const job = this.jobs.get(transferKey);
    if (!job) return;
    job.dropped = true;
    job.controller.abort();
    this.jobs.delete(transferKey);
    const queued = this.waiting.indexOf(job);
    if (queued >= 0) this.waiting.splice(queued, 1);
  }

  private pump(): void {
    const max = this.options.maxRunning ?? MAX_RUNNING;
    while (this.running < max) {
      const job = this.waiting.shift();
      if (!job) return;
      this.running++;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      await this.serve(job);
    } catch (err) {
      if (!job.dropped) await this.fail(job, err);
    } finally {
      this.running--;
      if (this.jobs.get(job.event.transferKey) === job) this.jobs.delete(job.event.transferKey);
      this.pump();
    }
  }

  private async serve(job: Job): Promise<void> {
    const { native, source, connection, onProgress } = this.options;
    const { event, controller } = job;
    const { path, identity, transferKey, fileSize } = event;
    const stream = boundedStream(
      () => source.read(identity, event.offset, controller.signal),
      this.options.stallMs ?? STALL_MS,
      controller,
    );
    let at = event.offset;
    for await (const piece of alignedPieces(stream, this.options.pieceBytes)) {
      // The placeholder promises this size: more or less is another version than it stands for.
      if (at + piece.length > fileSize) throw new SizeMismatch(`more than ${fileSize} bytes`);
      if (job.dropped) return;
      await native.transfer(connection(), transferKey, piece, at, fileSize);
      at += piece.length;
      onProgress?.({ path, done: at, total: fileSize, state: 'running' });
    }
    if (at !== fileSize) throw new SizeMismatch(`${at} of ${fileSize} bytes`);
    onProgress?.({ path, done: at, total: fileSize, state: 'done' });
  }

  private async fail(job: Job, err: unknown): Promise<void> {
    const { native, connection, onProgress } = this.options;
    const { path, transferKey, offset, length, fileSize } = job.event;
    onProgress?.({ path, done: offset, total: fileSize, state: 'failed' });
    // Fails too when the connection is gone, and Windows has then already told the program.
    await native
      .transferFail(connection(), transferKey, offset, length, statusOf(err))
      .catch(() => undefined);
  }
}
