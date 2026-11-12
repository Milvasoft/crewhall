CREATE TYPE "public"."blob_status" AS ENUM('pending', 'ready', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."derivative_kind" AS ENUM('thumb_256', 'thumb_1024', 'pdf_p1', 'poster');--> statement-breakpoint
CREATE TYPE "public"."share_kind" AS ENUM('user', 'link');--> statement-breakpoint
CREATE TYPE "public"."share_role" AS ENUM('viewer', 'editor');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploading', 'completed', 'aborted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."version_source" AS ENUM('web', 'mobile', 'mcp', 'api');--> statement-breakpoint
CREATE TYPE "public"."link_status" AS ENUM('up', 'warn', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."surface_owner_type" AS ENUM('user', 'space');--> statement-breakpoint
CREATE TABLE "blob_derivatives" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"kind" "derivative_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"size" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blob_derivatives_blob_kind_uq" UNIQUE("blob_id","kind")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"sha256" text,
	"size" bigint NOT NULL,
	"mime" text,
	"storage_key" text NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"status" "blob_status" DEFAULT 'pending' NOT NULL,
	"ref_count" integer DEFAULT 0 NOT NULL,
	"preview_status" text DEFAULT 'none' NOT NULL,
	"orphaned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "node_user_state" (
	"user_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"favorite" boolean DEFAULT false NOT NULL,
	"favorite_position" text COLLATE "C",
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_user_state_user_id_node_id_pk" PRIMARY KEY("user_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "node_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"blob_id" uuid,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"mime" text,
	"label" text,
	"source" "version_source" DEFAULT 'web' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_versions_node_version_uq" UNIQUE("node_id","version")
);
--> statement-breakpoint
CREATE TABLE "share_attempts" (
	"share_id" uuid NOT NULL,
	"ip" text NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_attempts_share_id_ip_pk" PRIMARY KEY("share_id","ip")
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"kind" "share_kind" NOT NULL,
	"grantee_user_id" uuid,
	"role" "share_role" NOT NULL,
	"token_hash" text,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"allow_download" boolean DEFAULT true NOT NULL,
	"open_count" integer DEFAULT 0 NOT NULL,
	"first_opened_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"node_id" uuid,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime" text,
	"on_conflict" text NOT NULL,
	"source" "version_source" DEFAULT 'web' NOT NULL,
	"storage_key" text NOT NULL,
	"s3_upload_id" text NOT NULL,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"status" "upload_status" DEFAULT 'uploading' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_checks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "link_checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "link_status" NOT NULL,
	"http_status" integer,
	"latency_ms" integer,
	"tls_expires_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "link_opens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "link_opens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_hash" text NOT NULL,
	"host" text NOT NULL,
	"site_title" text,
	"favicon_url" text,
	"check_enabled" boolean DEFAULT true NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"status" "link_status" DEFAULT 'unknown' NOT NULL,
	"status_since" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"last_http_status" integer,
	"last_latency_ms" integer,
	"tls_expires_at" timestamp with time zone,
	"last_reason" text,
	"last_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surface_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"surface_id" uuid NOT NULL,
	"type" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"w" integer NOT NULL,
	"h" integer NOT NULL,
	"mobile_order" integer,
	"config" jsonb NOT NULL,
	"target_id" uuid,
	"pinned_from_card_id" uuid,
	"source_removed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surfaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_type" "surface_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"layout_rev" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "blob_derivatives" ADD CONSTRAINT "blob_derivatives_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob_derivatives" ADD CONSTRAINT "blob_derivatives_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_user_state" ADD CONSTRAINT "node_user_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_user_state" ADD CONSTRAINT "node_user_state_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_user_state" ADD CONSTRAINT "node_user_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_versions" ADD CONSTRAINT "node_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_attempts" ADD CONSTRAINT "share_attempts_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_checks" ADD CONSTRAINT "link_checks_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_opens" ADD CONSTRAINT "link_opens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_opens" ADD CONSTRAINT "link_opens_link_id_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_opens" ADD CONSTRAINT "link_opens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_cards" ADD CONSTRAINT "surface_cards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_cards" ADD CONSTRAINT "surface_cards_surface_id_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."surfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_cards" ADD CONSTRAINT "surface_cards_pinned_from_card_id_surface_cards_id_fk" FOREIGN KEY ("pinned_from_card_id") REFERENCES "public"."surface_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_cards" ADD CONSTRAINT "surface_cards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surfaces" ADD CONSTRAINT "surfaces_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_org_sha256_uq" ON "blobs" USING btree ("org_id","sha256") WHERE "blobs"."encrypted" = false and "blobs"."status" = 'ready' and "blobs"."sha256" is not null;--> statement-breakpoint
CREATE INDEX "blobs_orphaned_idx" ON "blobs" USING btree ("orphaned_at");--> statement-breakpoint
CREATE INDEX "node_user_state_recent_idx" ON "node_user_state" USING btree ("user_id","last_opened_at");--> statement-breakpoint
CREATE INDEX "shares_node_idx" ON "shares" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "shares_grantee_idx" ON "shares" USING btree ("grantee_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_node_user_uq" ON "shares" USING btree ("node_id","grantee_user_id") WHERE "shares"."kind" = 'user';--> statement-breakpoint
CREATE INDEX "uploads_status_expires_idx" ON "uploads" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "uploads_space_idx" ON "uploads" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "link_checks_link_at_idx" ON "link_checks" USING btree ("link_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "link_opens_link_at_idx" ON "link_opens" USING btree ("link_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "links_org_url_hash_uq" ON "links" USING btree ("org_id","url_hash");--> statement-breakpoint
CREATE INDEX "links_next_check_idx" ON "links" USING btree ("next_check_at");--> statement-breakpoint
CREATE INDEX "surface_cards_surface_idx" ON "surface_cards" USING btree ("surface_id");--> statement-breakpoint
CREATE INDEX "surface_cards_pinned_idx" ON "surface_cards" USING btree ("pinned_from_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "surfaces_owner_uq" ON "surfaces" USING btree ("org_id","owner_type","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_live_name_uq" ON "nodes" USING btree ("space_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),"name") WHERE "nodes"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "nodes_name_trgm_idx" ON "nodes" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "nodes_deleted_idx" ON "nodes" USING btree ("space_id","deleted_at");