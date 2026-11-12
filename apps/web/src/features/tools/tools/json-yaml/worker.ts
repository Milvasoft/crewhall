// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/json-yaml/worker.ts. See THIRD_PARTY.md.
import { handleWorkerMessages } from '@/features/tools/lib/worker/workerClient';
import type { BiConverterRequest } from '@/features/tools/components/tool/BiConverter';
import { jsonToYaml, yamlToJson } from './logic';

handleWorkerMessages<BiConverterRequest, string>((r) =>
  !r.input.trim() ? '' : r.dir === 'forward' ? jsonToYaml(r.input) : yamlToJson(r.input),
);
