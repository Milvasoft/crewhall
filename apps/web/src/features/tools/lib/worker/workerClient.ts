// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/worker/workerClient.ts. See THIRD_PARTY.md.
/**
 * Minimal request/response wrapper around a dedicated Web Worker.
 *
 * Heavy tools (large diffs, big JSON, image work) offload their PURE logic to a
 * worker so the UI thread never freezes. Tiny transformations should stay on
 * the main thread, spinning up a worker for a few bytes is wasteful.
 *
 * Usage from a tool component:
 *   const worker = useMemo(
 *     () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
 *     [],
 *   );
 *   const client = useMemo(() => new WorkerClient(worker), [worker]);
 *   const result = await client.call(input);
 */
export class WorkerClient<Req, Res> {
  private seq = 0;
  private pending = new Map<number, { resolve: (r: Res) => void; reject: (e: unknown) => void }>();

  constructor(private worker: Worker) {
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onError);
  }

  private onMessage = (event: MessageEvent) => {
    const { id, result, error } = event.data as {
      id: number;
      result?: Res;
      error?: string;
    };
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (error) entry.reject(new Error(error));
    else entry.resolve(result as Res);
  };

  private onError = (event: ErrorEvent) => {
    for (const { reject } of this.pending.values()) reject(event.error ?? event.message);
    this.pending.clear();
  };

  call(request: Req): Promise<Res> {
    const id = ++this.seq;
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, request });
    });
  }

  terminate(): void {
    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.terminate();
    this.pending.clear();
  }
}

/**
 * Companion helper used INSIDE a worker module to handle the message protocol.
 *
 *   // worker.ts
 *   import { handleWorkerMessages } from "@/features/tools/lib/worker/workerClient";
 *   import { compute } from "./logic";
 *   handleWorkerMessages<Req, Res>((req) => compute(req));
 */
export function handleWorkerMessages<Req, Res>(handler: (request: Req) => Res): void {
  self.addEventListener('message', (event: MessageEvent) => {
    const { id, request } = event.data as { id: number; request: Req };
    try {
      const result = handler(request);
      (self as unknown as Worker).postMessage({ id, result });
    } catch (error) {
      (self as unknown as Worker).postMessage({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
