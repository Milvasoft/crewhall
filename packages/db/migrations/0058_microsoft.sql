CREATE TYPE "public"."import_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mount_kind" AS ENUM('sharepoint', 'onedrive', 'smb');--> statement-breakpoint
CREATE TABLE "drive_mounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "mount_kind" NOT NULL,
	"config" jsonb NOT NULL,
	"secret_enc" text,
	"read_only" boolean DEFAULT false NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_ok" boolean,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"owner_id" uuid,
	"source" jsonb NOT NULL,
	"source_label" text NOT NULL,
	"target_space_id" uuid NOT NULL,
	"target_folder_id" uuid,
	"status" "import_status" DEFAULT 'queued' NOT NULL,
	"files" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "microsoft_apps" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"client_id" text,
	"secret_enc" text,
	"secret_hint" text,
	"teams_bot_app_id" text,
	"teams_app_id" uuid,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_error" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "scim_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "scim_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_name" text NOT NULL,
	"external_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"from" text,
	"sent_at" timestamp with time zone,
	"link" text,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_link_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"aad_object_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"uploads" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_requests_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD COLUMN "integration" text;--> statement-breakpoint
ALTER TABLE "drive_mounts" ADD CONSTRAINT "drive_mounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_mounts" ADD CONSTRAINT "drive_mounts_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_mounts" ADD CONSTRAINT "drive_mounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_target_space_id_spaces_id_fk" FOREIGN KEY ("target_space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_target_folder_id_nodes_id_fk" FOREIGN KEY ("target_folder_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_apps" ADD CONSTRAINT "microsoft_apps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microsoft_apps" ADD CONSTRAINT "microsoft_apps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_users" ADD CONSTRAINT "scim_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_drafts" ADD CONSTRAINT "teams_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_link_codes" ADD CONSTRAINT "teams_link_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_link_codes" ADD CONSTRAINT "teams_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_links" ADD CONSTRAINT "teams_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams_links" ADD CONSTRAINT "teams_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_folder_id_nodes_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_requests" ADD CONSTRAINT "upload_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "drive_mounts_space_idx" ON "drive_mounts" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "import_jobs_org_idx" ON "import_jobs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "scim_gm_user_idx" ON "scim_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_groups_external_uq" ON "scim_groups" USING btree ("provider_id","external_id") WHERE "scim_groups"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "scim_groups_provider_idx" ON "scim_groups" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "scim_tokens_org_idx" ON "scim_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_user_uq" ON "scim_users" USING btree ("provider_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scim_users_name_uq" ON "scim_users" USING btree ("provider_id",lower("user_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "teams_links_uq" ON "teams_links" USING btree ("org_id","tenant_id","aad_object_id");--> statement-breakpoint
CREATE INDEX "upload_requests_creator_idx" ON "upload_requests" USING btree ("created_by");