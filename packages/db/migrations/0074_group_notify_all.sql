-- Group messages now notify by default (2026-11-05). The level was stored at join, so a row at
-- "mentions" is either that old default or someone's choice. A row never changed since it was
-- created is the default; a pin or a "clear for me" also changes the row without saying anything
-- about notifications. A row with a mute (past or present), or archived by this person, stays.
UPDATE "conversation_members" AS cm
SET "notify" = 'all'
FROM "conversations" AS c
WHERE c."id" = cm."conversation_id"
  AND c."type" = 'group'
  AND cm."notify" = 'mentions'
  AND cm."muted_until" IS NULL
  AND cm."archived_at" IS NULL
  AND (
    cm."updated_at" = cm."created_at"
    OR cm."pinned_at" IS NOT NULL
    OR cm."pin_position" IS NOT NULL
    OR cm."cleared_at_seq" IS NOT NULL
  );
