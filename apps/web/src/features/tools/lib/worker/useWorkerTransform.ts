// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/lib/worker/useWorkerTransform.ts. See THIRD_PARTY.md.
import { useEffect, useRef, useState } from 'react';
import { WorkerClient } from './workerClient';

interface Params<Req, Res> {
  /** Factory for the tool's dedicated worker. Omit to always run on the main thread. */
  createWorker?: () => Worker;
  /** Build the request from current state (read fresh when the effect runs). */
  buildRequest: () => Req;
  /** Main-thread implementation, used for small inputs and as a worker fallback. */
  compute: (req: Req) => Res;
  /** Input size metric (e.g. text length) used to decide worker vs main thread. */
  size: number;
  /** Values that should trigger recomputation (like a useEffect dependency list). */
  deps: React.DependencyList;
  /** Above this size, run in the worker. Default 40k. */
  threshold?: number;
}

interface State<Res> {
  result: Res | null;
  error: string | null;
  pending: boolean;
}

/**
 * Runs a pure transform, transparently offloading to a Web Worker when the
 * input is large enough (keeps the UI responsive), with a main-thread fallback.
 * Small inputs run synchronously on the main thread, spinning up a worker for a
 * few bytes is wasteful.
 *
 * Functions are read through refs so they don't need to be stable; invalidation
 * is controlled entirely by `deps` + `size`, avoiding render loops.
 */
export function useWorkerTransform<Req, Res>({
  createWorker,
  buildRequest,
  compute,
  size,
  deps,
  threshold = 40_000,
}: Params<Req, Res>): State<Res> {
  const clientRef = useRef<WorkerClient<Req, Res> | null>(null);
  const fns = useRef({ createWorker, buildRequest, compute });

  const [state, setState] = useState<State<Res>>({
    result: null,
    error: null,
    pending: false,
  });

  // Keep the latest callbacks without making them effect dependencies.
  useEffect(() => {
    fns.current = { createWorker, buildRequest, compute };
  });

  useEffect(() => () => clientRef.current?.terminate(), []);

  useEffect(() => {
    let cancelled = false;
    const { createWorker: mk, buildRequest: build, compute: run } = fns.current;
    const request = build();

    const runMain = () => {
      try {
        const result = run(request);
        if (!cancelled) setState({ result, error: null, pending: false });
      } catch (e) {
        if (!cancelled) {
          setState({
            result: null,
            error: e instanceof Error ? e.message : 'Failed.',
            pending: false,
          });
        }
      }
    };

    if (mk && size > threshold) {
      if (!clientRef.current) clientRef.current = new WorkerClient(mk());
      setState((s) => ({ ...s, pending: true }));
      clientRef.current
        .call(request)
        .then((result) => {
          if (!cancelled) setState({ result, error: null, pending: false });
        })
        .catch((e) => {
          if (cancelled) return;
          // Worker threw (e.g. invalid input) or failed to spawn → fall back.
          try {
            const result = run(request);
            setState({ result, error: null, pending: false });
          } catch {
            setState({
              result: null,
              error: e instanceof Error ? e.message : 'Failed.',
              pending: false,
            });
          }
        });
    } else {
      runMain();
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, size, threshold]);

  return state;
}
