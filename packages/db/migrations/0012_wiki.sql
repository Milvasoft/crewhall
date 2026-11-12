CREATE TYPE "public"."page_ref_kind" AS ENUM('link', 'mention', 'embed');--> statement-breakpoint
CREATE TABLE "page_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"root_id" uuid,
	"author_id" uuid,
	"body" text NOT NULL,
	"mentions" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"anchor_start" "bytea",
	"anchor_end" "bytea",
	"quote" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"edited_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('turkish'::regconfig, body) || to_tsvector('english'::regconfig, body)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_mentions" (
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"mentioned_by" uuid,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_mentions_node_id_user_id_pk" PRIMARY KEY("node_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "page_refs" (
	"org_id" uuid NOT NULL,
	"from_node_id" uuid NOT NULL,
	"to_node_id" uuid NOT NULL,
	"kind" "page_ref_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_refs_from_node_id_to_node_id_kind_pk" PRIMARY KEY("from_node_id","to_node_id","kind")
);
--> statement-breakpoint
CREATE TABLE "page_snapshots" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"ydoc" "bytea" NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"editor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"restored_from" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid,
	"owner_user_id" uuid,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'team' NOT NULL,
	"markdown" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"ydoc" "bytea",
	"markdown" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"search" "tsvector",
	"word_count" integer DEFAULT 0 NOT NULL,
	"icon" text,
	"cover" text,
	"full_width" boolean DEFAULT false NOT NULL,
	"small_text" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"snapshot_rev" integer DEFAULT 0 NOT NULL,
	"derived_rev" integer DEFAULT 0 NOT NULL,
	"versioned_rev" integer DEFAULT 0 NOT NULL,
	"pending_editors" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"last_source" "version_source",
	"edited_at" timestamp with time zone,
	"edited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_root_id_page_comments_id_fk" FOREIGN KEY ("root_id") REFERENCES "public"."page_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_mentions" ADD CONSTRAINT "page_mentions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_mentions" ADD CONSTRAINT "page_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_mentions" ADD CONSTRAINT "page_mentions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_mentions" ADD CONSTRAINT "page_mentions_mentioned_by_users_id_fk" FOREIGN KEY ("mentioned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_refs" ADD CONSTRAINT "page_refs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_refs" ADD CONSTRAINT "page_refs_from_node_id_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_refs" ADD CONSTRAINT "page_refs_to_node_id_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_version_id_node_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."node_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_templates" ADD CONSTRAINT "page_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_templates" ADD CONSTRAINT "page_templates_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_templates" ADD CONSTRAINT "page_templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_templates" ADD CONSTRAINT "page_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_comments_node_idx" ON "page_comments" USING btree ("node_id","root_id");--> statement-breakpoint
CREATE INDEX "page_comments_search_gin" ON "page_comments" USING gin ("search");--> statement-breakpoint
CREATE INDEX "page_refs_to_idx" ON "page_refs" USING btree ("to_node_id");--> statement-breakpoint
CREATE INDEX "page_snapshots_node_idx" ON "page_snapshots" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "page_templates_space_idx" ON "page_templates" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "page_templates_owner_idx" ON "page_templates" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "pages_search_gin" ON "pages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "pages_org_idx" ON "pages" USING btree ("org_id");