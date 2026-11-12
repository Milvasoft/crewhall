CREATE TYPE "public"."drawing_library_owner" AS ENUM('user', 'space');--> statement-breakpoint
CREATE TABLE "board_card_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"text" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_card_attachments" (
	"card_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_card_attachments_card_id_node_id_pk" PRIMARY KEY("card_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "board_card_followers" (
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_card_followers_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "board_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"board_node_id" uuid NOT NULL,
	"column_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"title" text COLLATE "tr-x-icu" NOT NULL,
	"desc_ydoc" "bytea",
	"desc_text" text DEFAULT '' NOT NULL,
	"due_at" timestamp with time zone,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"points" integer,
	"priority" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conversation_id" uuid,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"due_notified_at" timestamp with time zone,
	"created_by" uuid,
	"updated_by" uuid,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("desc_text", ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"board_node_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"wip_limit" integer,
	"is_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"settings" jsonb NOT NULL,
	"card_seq" integer DEFAULT 0 NOT NULL,
	"rev" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_assignees" (
	"card_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_assignees_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "drawing_files" (
	"node_id" uuid NOT NULL,
	"file_id" text NOT NULL,
	"org_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"mime" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drawing_files_node_id_file_id_pk" PRIMARY KEY("node_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "drawing_libraries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_type" "drawing_library_owner" NOT NULL,
	"owner_id" uuid NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawings" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"ydoc" "bytea",
	"scene_rev" integer DEFAULT 0 NOT NULL,
	"element_count" integer DEFAULT 0 NOT NULL,
	"thumbnail_blob_id" uuid,
	"thumbnail_rev" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_card_activity" ADD CONSTRAINT "board_card_activity_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_activity" ADD CONSTRAINT "board_card_activity_card_id_board_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_activity" ADD CONSTRAINT "board_card_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_attachments" ADD CONSTRAINT "board_card_attachments_card_id_board_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_attachments" ADD CONSTRAINT "board_card_attachments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_attachments" ADD CONSTRAINT "board_card_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_attachments" ADD CONSTRAINT "board_card_attachments_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_followers" ADD CONSTRAINT "board_card_followers_card_id_board_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_followers" ADD CONSTRAINT "board_card_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_card_followers" ADD CONSTRAINT "board_card_followers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_board_node_id_boards_node_id_fk" FOREIGN KEY ("board_node_id") REFERENCES "public"."boards"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_column_id_board_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."board_columns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_cards" ADD CONSTRAINT "board_cards_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_node_id_boards_node_id_fk" FOREIGN KEY ("board_node_id") REFERENCES "public"."boards"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignees" ADD CONSTRAINT "card_assignees_card_id_board_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."board_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignees" ADD CONSTRAINT "card_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignees" ADD CONSTRAINT "card_assignees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignees" ADD CONSTRAINT "card_assignees_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_files" ADD CONSTRAINT "drawing_files_node_id_drawings_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."drawings"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_files" ADD CONSTRAINT "drawing_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_files" ADD CONSTRAINT "drawing_files_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_files" ADD CONSTRAINT "drawing_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_libraries" ADD CONSTRAINT "drawing_libraries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawing_libraries" ADD CONSTRAINT "drawing_libraries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_thumbnail_blob_id_blobs_id_fk" FOREIGN KEY ("thumbnail_blob_id") REFERENCES "public"."blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_card_activity_card_idx" ON "board_card_activity" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "board_cards_board_number_uq" ON "board_cards" USING btree ("board_node_id","number");--> statement-breakpoint
CREATE INDEX "board_cards_column_pos_idx" ON "board_cards" USING btree ("column_id","position");--> statement-breakpoint
CREATE INDEX "board_cards_due_idx" ON "board_cards" USING btree ("due_at") WHERE "board_cards"."due_at" is not null and "board_cards"."archived_at" is null and "board_cards"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "board_cards_search_idx" ON "board_cards" USING gin ("search");--> statement-breakpoint
CREATE INDEX "board_columns_board_pos_idx" ON "board_columns" USING btree ("board_node_id","position");--> statement-breakpoint
CREATE INDEX "card_assignees_user_idx" ON "card_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_libraries_owner_uq" ON "drawing_libraries" USING btree ("org_id","owner_type","owner_id");