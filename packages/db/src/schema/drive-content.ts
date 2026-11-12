import { sql } from 'drizzle-orm';
import { boolean, customType, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { blobs } from './drive';
import { organizations } from './org';
import { timestamps, tz } from './types';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * Text of a stored file for full-text search (roadmap 10). One row per blob: content is
 * deduplicated per org, so copies and restored versions share it, and a new version is a
 * new blob with its own row. The worker's `content.extract` job fills it; `content.backfill`
 * finds files stored before the indexer. Search reads the current version's blob.
 *
 * Owned by the drive session; the AI module (roadmap 11) reads it through
 * `apps/backend/src/services/drive/content`.
 */
export const blobContents = pgTable(
  'blob_contents',
  {
    blobId: uuid('blob_id')
      .primaryKey()
      .references(() => blobs.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** ready: text extracted (maybe empty, e.g. a scanned PDF); skipped: type not indexed. */
    status: text('status', { enum: ['ready', 'skipped', 'failed'] }).notNull(),
    /** Extractor that produced the text (text, pdf, docx, xlsx, pptx, odf, html). */
    kind: text('kind'),
    content: text('content').notNull().default(''),
    truncated: boolean('truncated').notNull().default(false),
    chars: integer('chars').notNull().default(0),
    error: text('error'),
    /** Both stemmers, like page search: Turkish and English queries match the same row. */
    search: tsvector('search').generatedAlwaysAs(
      sql.raw(
        `to_tsvector('turkish'::regconfig, "content") || to_tsvector('english'::regconfig, "content")`,
      ),
    ),
    extractedAt: tz('extracted_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    index('blob_contents_search_gin').using('gin', t.search),
    index('blob_contents_org_idx').on(t.orgId),
  ],
);
