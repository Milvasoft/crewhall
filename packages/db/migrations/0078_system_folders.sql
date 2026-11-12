DROP INDEX "nodes_live_name_uq";--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "system_role" text;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_system_role_uq" ON "nodes" USING btree ("space_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"system_role") WHERE "nodes"."deleted_at" is null and "nodes"."system_role" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_live_name_uq" ON "nodes" USING btree ("space_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"name") WHERE "nodes"."deleted_at" is null and "nodes"."system_role" is null;--> statement-breakpoint
-- Folders the app made before system_role existed: found by their (Turkish or English) names.
-- One per space and place for the shared ones; per board and table for attachments.
UPDATE "nodes" SET "system_role" = 'page_images' WHERE "id" IN (
  SELECT DISTINCT ON ("space_id") "id" FROM "nodes"
  WHERE "type" = 'folder' AND "parent_id" IS NULL AND "deleted_at" IS NULL
    AND "name" IN ('Sayfa görselleri', 'Page images')
  ORDER BY "space_id", "created_at"
);--> statement-breakpoint
UPDATE "nodes" SET "system_role" = 'page_attachments' WHERE "id" IN (
  SELECT DISTINCT ON ("space_id") "id" FROM "nodes"
  WHERE "type" = 'folder' AND "parent_id" IS NULL AND "deleted_at" IS NULL
    AND "name" IN ('Sayfa ekleri', 'Page attachments')
  ORDER BY "space_id", "created_at"
);--> statement-breakpoint
UPDATE "nodes" SET "system_role" = 'import_attachments' WHERE "id" IN (
  SELECT DISTINCT ON ("space_id", coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)) "id" FROM "nodes"
  WHERE "type" = 'folder' AND "deleted_at" IS NULL
    AND "name" IN ('İçe aktarılan ekler', 'Imported attachments')
  ORDER BY "space_id", coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid), "created_at"
);--> statement-breakpoint
UPDATE "nodes" AS f SET "system_role" = 'table_attachments:' || t."id"
FROM "data_tables" AS t
WHERE f."id" = t."attachment_folder_id" AND f."system_role" IS NULL;--> statement-breakpoint
UPDATE "nodes" AS f SET "system_role" = 'board_attachments:' || b."id"
FROM "nodes" AS b
WHERE f."type" = 'folder' AND f."deleted_at" IS NULL AND f."system_role" IS NULL
  AND b."type" = 'board' AND b."deleted_at" IS NULL
  AND b."space_id" = f."space_id"
  AND b."parent_id" IS NOT DISTINCT FROM f."parent_id"
  AND f."name" IN (b."name" || ' · Ekler', b."name" || ' · Attachments');
