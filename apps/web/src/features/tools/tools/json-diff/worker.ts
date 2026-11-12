// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-diff/worker.ts. See THIRD_PARTY.md.
import { handleWorkerMessages } from '@/features/tools/lib/worker/workerClient';
import { diffJson, type JsonDiffResult } from './logic';

handleWorkerMessages<{ a: string; b: string }, JsonDiffResult>((req) => diffJson(req.a, req.b));
