CREATE TYPE "public"."calendar_account_status" AS ENUM('active', 'error', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."calendar_provider" AS ENUM('google', 'microsoft');--> statement-breakpoint
ALTER TYPE "public"."calendar_kind" ADD VALUE 'external';--> statement-breakpoint
CREATE TABLE "calendar_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"email" "citext" NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token_enc" text,
	"access_expires_at" timestamp with time zone,
	"status" "calendar_account_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_integrations" (
	"org_id" uuid NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"client_id" text,
	"client_secret_enc" text,
	"tenant" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_integrations_org_id_provider_pk" PRIMARY KEY("org_id","provider")
);
--> statement-breakpoint
CREATE TABLE "calendar_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "calendar_provider" NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "external_etag" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "external" jsonb;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "external_writable" boolean;--> statement-breakpoint
ALTER TABLE "calendars" ADD COLUMN "sync_state" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD CONSTRAINT "calendar_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD CONSTRAINT "calendar_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD CONSTRAINT "calendar_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD CONSTRAINT "calendar_integrations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_accounts_uq" ON "calendar_accounts" USING btree ("org_id","user_id","provider","email");--> statement-breakpoint
CREATE INDEX "calendar_accounts_user_idx" ON "calendar_accounts" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_account_id_calendar_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_external_uq" ON "calendar_events" USING btree ("calendar_id","external_id") WHERE "calendar_events"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_external_uq" ON "calendars" USING btree ("account_id","external_id") WHERE "calendars"."account_id" is not null;