CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"scheduled_for" text,
	"snapshot_id" text,
	"db_bytes" bigint,
	"object_count" integer,
	"object_bytes" bigint,
	"error" text,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"time" text DEFAULT '03:00' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"keep" integer DEFAULT 7 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_settings_single_row" CHECK ("backup_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "compliance_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"retention" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dlp" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ediscovery_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"requested_by" uuid,
	"name" text NOT NULL,
	"scope" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"size_bytes" bigint,
	"counts" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "held_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid,
	"kind" text NOT NULL,
	"text" text,
	"body" jsonb,
	"sent_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reason" text,
	"user_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"space_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" uuid
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "member_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "space_role" text;--> statement-breakpoint
ALTER TABLE "org_members" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_settings" ADD CONSTRAINT "backup_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policies" ADD CONSTRAINT "compliance_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_policies" ADD CONSTRAINT "compliance_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ediscovery_exports" ADD CONSTRAINT "ediscovery_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ediscovery_exports" ADD CONSTRAINT "ediscovery_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_messages" ADD CONSTRAINT "held_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_runs_created_idx" ON "backup_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_nightly_uq" ON "backup_runs" USING btree ("scheduled_for") WHERE "backup_runs"."trigger" = 'nightly';--> statement-breakpoint
CREATE INDEX "ediscovery_exports_org_idx" ON "ediscovery_exports" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "held_messages_org_idx" ON "held_messages" USING btree ("org_id","sent_at");--> statement-breakpoint
CREATE INDEX "held_messages_author_idx" ON "held_messages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "legal_holds_org_idx" ON "legal_holds" USING btree ("org_id");