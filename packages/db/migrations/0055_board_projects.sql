CREATE TABLE "board_card_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"from_card_id" uuid NOT NULL,
	"to_card_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_sprints" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"board_node_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"started_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"result" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"minutes" integer,
	"note" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "estimate_minutes" integer;--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "sprint_id" uuid;--> statement-breakpoint
ALTER TABLE "board_cards" ADD COLUMN "sprint_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "board_card_links" ADD CONSTRAINT "board_card_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_links" ADD CONSTRAINT "board_card_links_from_card_id_board_cards_id_fk" FOREIGN KEY ("from_card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_links" ADD CONSTRAINT "board_card_links_to_card_id_board_cards_id_fk" FOREIGN KEY ("to_card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_links" ADD CONSTRAINT "board_card_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_sprints" ADD CONSTRAINT "board_sprints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_sprints" ADD CONSTRAINT "board_sprints_board_node_id_boards_node_id_fk" FOREIGN KEY ("board_node_id") REFERENCES "public"."boards"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_sprints" ADD CONSTRAINT "board_sprints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_time_entries" ADD CONSTRAINT "board_time_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_time_entries" ADD CONSTRAINT "board_time_entries_card_id_board_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_time_entries" ADD CONSTRAINT "board_time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_card_links_uq" ON "board_card_links" USING btree ("from_card_id","to_card_id","kind");--> statement-breakpoint
CREATE INDEX "board_card_links_to_idx" ON "board_card_links" USING btree ("to_card_id");--> statement-breakpoint
CREATE INDEX "board_sprints_board_idx" ON "board_sprints" USING btree ("board_node_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "board_sprints_one_active_uq" ON "board_sprints" USING btree ("board_node_id") WHERE "board_sprints"."status" = 'active';--> statement-breakpoint
CREATE INDEX "board_time_entries_card_idx" ON "board_time_entries" USING btree ("card_id","started_at");--> statement-breakpoint
CREATE INDEX "board_time_entries_user_idx" ON "board_time_entries" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_time_entries_running_uq" ON "board_time_entries" USING btree ("user_id") WHERE "board_time_entries"."minutes" is null;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_sprint_id_board_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."board_sprints"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_cards_sprint_idx" ON "board_cards" USING btree ("sprint_id");--> statement-breakpoint
-- The single sprint of settings.sprint becomes the board's active sprint and holds every live
-- card (its band counted them all); settings.sprint is mirrored from that row from now on.
INSERT INTO "board_sprints" ("id", "org_id", "board_node_id", "name", "starts_on", "ends_on", "status", "started_at")
SELECT gen_random_uuid(), "org_id", "node_id", "settings"->'sprint'->>'name',
  ("settings"->'sprint'->>'startsOn')::date, ("settings"->'sprint'->>'endsOn')::date, 'active', now()
FROM "boards" WHERE jsonb_typeof("settings"->'sprint') = 'object';--> statement-breakpoint
UPDATE "board_cards" c SET "sprint_id" = s."id", "sprint_added_at" = c."created_at"
FROM "board_sprints" s WHERE s."board_node_id" = c."board_node_id" AND s."status" = 'active' AND c."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "boards" SET "settings" = jsonb_set("settings", '{sprint}', 'null'::jsonb) WHERE jsonb_typeof("settings"->'sprint') = 'object';
