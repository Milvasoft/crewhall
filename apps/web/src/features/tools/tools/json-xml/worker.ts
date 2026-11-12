// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-xml/worker.ts. See THIRD_PARTY.md.
import { handleWorkerMessages } from '@/features/tools/lib/worker/workerClient';
import type { BiConverterRequest } from '@/features/tools/components/tool/BiConverter';
import { jsonToXml, xmlToJson } from './logic';

handleWorkerMessages<BiConverterRequest, string>((r) =>
  !r.input.trim() ? '' : r.dir === 'forward' ? jsonToXml(r.input) : xmlToJson(r.input),
);
