// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/sql-formatter/worker.ts. See THIRD_PARTY.md.
import { handleWorkerMessages } from '@/features/tools/lib/worker/workerClient';
import { formatSql, type SqlFormatOptions } from './logic';

handleWorkerMessages<{ sql: string; options: SqlFormatOptions }, string>((req) =>
  req.sql.trim() ? formatSql(req.sql, req.options) : '',
);
