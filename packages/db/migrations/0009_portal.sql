CREATE TYPE "public"."portal_category_link" AS ENUM('none', 'generated-index', 'doc');--> statement-breakpoint
CREATE TYPE "public"."portal_doc_kind" AS ENUM('doc', 'category');--> statement-breakpoint
CREATE TYPE "public"."portal_job_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."portal_publish_status" AS ENUM('queued', 'running', 'done', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."portal_version_status" AS ENUM('next', 'current', 'archived');--> statement-breakpoint
CREATE TABLE "portal_authors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"url" text,
	"image_url" text,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_docs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" "portal_doc_kind" NOT NULL,
	"node_id" uuid,
	"parent_group_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"sidebar_label" text,
	"position" double precision DEFAULT 0 NOT NULL,
	"unlisted" boolean DEFAULT false NOT NULL,
	"category_link" "portal_category_link" DEFAULT 'none' NOT NULL,
	"category_slug" text,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"source_rev" integer,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"published_rev" integer DEFAULT 0 NOT NULL,
	"pub_title" text,
	"pub_slug" text,
	"pub_description" text,
	"pub_sidebar_label" text,
	"pub_position" double precision,
	"pub_parent_group_id" uuid,
	"pub_unlisted" boolean,
	"pub_category_link" "portal_category_link",
	"pub_category_slug" text,
	"pub_front_matter" jsonb,
	"pub_seo" jsonb,
	"content_md" text,
	"pub_source_rev" integer,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector((case when locale like 'tr%' then 'turkish'::regconfig when locale like 'en%' then 'english'::regconfig else 'simple'::regconfig end), coalesce(pub_title, '') || ' ' || coalesce(pub_description, '') || ' ' || coalesce(content_md, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"actor_id" uuid,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"path" text NOT NULL,
	"file_name" text NOT NULL,
	"blob_id" uuid,
	"mime" text,
	"size" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"alt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"group_id" uuid NOT NULL,
	"node_id" uuid,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"author_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"date" timestamp with time zone,
	"scheduled_at" timestamp with time zone,
	"cover" text,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"rev" integer DEFAULT 1 NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"code_blocks" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"published_rev" integer DEFAULT 0 NOT NULL,
	"pub_title" text,
	"pub_slug" text,
	"pub_description" text,
	"pub_author_ids" uuid[],
	"pub_tags" text[],
	"pub_date" timestamp with time zone,
	"pub_cover" text,
	"pub_front_matter" jsonb,
	"pub_seo" jsonb,
	"content_md" text,
	"excerpt_md" text,
	"truncated" boolean,
	"reading_minutes" integer,
	"visible_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector((case when locale like 'tr%' then 'turkish'::regconfig when locale like 'en%' then 'english'::regconfig else 'simple'::regconfig end), coalesce(pub_title, '') || ' ' || coalesce(pub_description, '') || ' ' || coalesce(content_md, ''))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_publish_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"publish_id" uuid,
	"scope" text NOT NULL,
	"tags" text[] NOT NULL,
	"paths" text[] NOT NULL,
	"status" "portal_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"http_status" integer,
	"error" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_publishes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"note" text,
	"actor_id" uuid,
	"status" "portal_publish_status" DEFAULT 'queued' NOT NULL,
	"items" jsonb NOT NULL,
	"path_count" integer DEFAULT 0 NOT NULL,
	"revert_of" uuid,
	"reverted_by" uuid,
	"duration_ms" integer,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_redirects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"from_path" text NOT NULL,
	"to_path" text NOT NULL,
	"code" integer DEFAULT 301 NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"publish_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid,
	"snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_sites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"locales" text[] NOT NULL,
	"default_locale" text NOT NULL,
	"settings" jsonb NOT NULL,
	"content_space_id" uuid NOT NULL,
	"root_node_id" uuid,
	"token_hash" text,
	"token_hint" text,
	"nav_draft" jsonb NOT NULL,
	"nav" jsonb,
	"nav_rev" integer DEFAULT 1 NOT NULL,
	"nav_published_rev" integer DEFAULT 0 NOT NULL,
	"nav_updated_at" timestamp with time zone,
	"nav_updated_by" uuid,
	"home_draft" jsonb NOT NULL,
	"home" jsonb,
	"home_rev" integer DEFAULT 1 NOT NULL,
	"home_published_rev" integer DEFAULT 0 NOT NULL,
	"home_updated_at" timestamp with time zone,
	"home_updated_by" uuid,
	"publish_seq" integer DEFAULT 0 NOT NULL,
	"last_published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"status" "portal_version_status" NOT NULL,
	"show_in_picker" boolean DEFAULT true NOT NULL,
	"node_id" uuid,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "portal_authors" ADD CONSTRAINT "portal_authors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_authors" ADD CONSTRAINT "portal_authors_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_authors" ADD CONSTRAINT "portal_authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_version_id_portal_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."portal_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_docs" ADD CONSTRAINT "portal_docs_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_imports" ADD CONSTRAINT "portal_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_imports" ADD CONSTRAINT "portal_imports_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_imports" ADD CONSTRAINT "portal_imports_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_media" ADD CONSTRAINT "portal_media_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_media" ADD CONSTRAINT "portal_media_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_media" ADD CONSTRAINT "portal_media_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_media" ADD CONSTRAINT "portal_media_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_posts" ADD CONSTRAINT "portal_posts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_posts" ADD CONSTRAINT "portal_posts_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_posts" ADD CONSTRAINT "portal_posts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_posts" ADD CONSTRAINT "portal_posts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_posts" ADD CONSTRAINT "portal_posts_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_posts" ADD CONSTRAINT "portal_posts_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publish_jobs" ADD CONSTRAINT "portal_publish_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publish_jobs" ADD CONSTRAINT "portal_publish_jobs_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publish_jobs" ADD CONSTRAINT "portal_publish_jobs_publish_id_portal_publishes_id_fk" FOREIGN KEY ("publish_id") REFERENCES "public"."portal_publishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publish_jobs" ADD CONSTRAINT "portal_publish_jobs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publishes" ADD CONSTRAINT "portal_publishes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publishes" ADD CONSTRAINT "portal_publishes_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_publishes" ADD CONSTRAINT "portal_publishes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_redirects" ADD CONSTRAINT "portal_redirects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_redirects" ADD CONSTRAINT "portal_redirects_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_redirects" ADD CONSTRAINT "portal_redirects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_revisions" ADD CONSTRAINT "portal_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_revisions" ADD CONSTRAINT "portal_revisions_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_revisions" ADD CONSTRAINT "portal_revisions_publish_id_portal_publishes_id_fk" FOREIGN KEY ("publish_id") REFERENCES "public"."portal_publishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sites" ADD CONSTRAINT "portal_sites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sites" ADD CONSTRAINT "portal_sites_content_space_id_spaces_id_fk" FOREIGN KEY ("content_space_id") REFERENCES "public"."spaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sites" ADD CONSTRAINT "portal_sites_root_node_id_nodes_id_fk" FOREIGN KEY ("root_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sites" ADD CONSTRAINT "portal_sites_nav_updated_by_users_id_fk" FOREIGN KEY ("nav_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sites" ADD CONSTRAINT "portal_sites_home_updated_by_users_id_fk" FOREIGN KEY ("home_updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_sites" ADD CONSTRAINT "portal_sites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_versions" ADD CONSTRAINT "portal_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_versions" ADD CONSTRAINT "portal_versions_site_id_portal_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."portal_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_versions" ADD CONSTRAINT "portal_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_authors_site_key_uq" ON "portal_authors" USING btree ("site_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_docs_draft_slug_uq" ON "portal_docs" USING btree ("version_id","locale","kind","slug") WHERE "portal_docs"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_docs_group_locale_uq" ON "portal_docs" USING btree ("version_id","group_id","locale");--> statement-breakpoint
CREATE INDEX "portal_docs_site_idx" ON "portal_docs" USING btree ("site_id","version_id","locale");--> statement-breakpoint
CREATE INDEX "portal_docs_pub_slug_idx" ON "portal_docs" USING btree ("version_id","locale","pub_slug");--> statement-breakpoint
CREATE INDEX "portal_docs_search_idx" ON "portal_docs" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_media_site_path_uq" ON "portal_media" USING btree ("site_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_posts_draft_slug_uq" ON "portal_posts" USING btree ("site_id","locale","slug") WHERE "portal_posts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_posts_group_locale_uq" ON "portal_posts" USING btree ("site_id","group_id","locale");--> statement-breakpoint
CREATE INDEX "portal_posts_visible_idx" ON "portal_posts" USING btree ("site_id","locale","visible_at");--> statement-breakpoint
CREATE INDEX "portal_posts_search_idx" ON "portal_posts" USING gin ("search");--> statement-breakpoint
CREATE INDEX "portal_publish_jobs_publish_idx" ON "portal_publish_jobs" USING btree ("publish_id");--> statement-breakpoint
CREATE INDEX "portal_publish_jobs_site_idx" ON "portal_publish_jobs" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_publishes_site_number_uq" ON "portal_publishes" USING btree ("site_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_redirects_site_from_uq" ON "portal_redirects" USING btree ("site_id","from_path");--> statement-breakpoint
CREATE INDEX "portal_revisions_entity_idx" ON "portal_revisions" USING btree ("site_id","kind","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_sites_org_slug_uq" ON "portal_sites" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_sites_token_uq" ON "portal_sites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_versions_site_name_uq" ON "portal_versions" USING btree ("site_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_versions_one_current_uq" ON "portal_versions" USING btree ("site_id") WHERE "portal_versions"."status" = 'current';