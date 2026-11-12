// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/text-compare/worker.ts. See THIRD_PARTY.md.
import { handleWorkerMessages } from '@/features/tools/lib/worker/workerClient';
import { diffText, type DiffRequest, type DiffResult } from './logic';

// Runs the (potentially expensive) diff off the main thread for large inputs.
handleWorkerMessages<DiffRequest, DiffResult>((req) => diffText(req.a, req.b, req.options));
