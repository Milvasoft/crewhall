CREATE TYPE "public"."calendar_version_source" AS ENUM('provider', 'crewhall');--> statement-breakpoint
ALTER TYPE "public"."calendar_provider" ADD VALUE 'exchange';--> statement-breakpoint
CREATE TABLE "calendar_event_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"source" "calendar_version_source" NOT NULL,
	"data" jsonb NOT NULL,
	"etag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"source" text NOT NULL,
	"data" jsonb NOT NULL,
	"etag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD COLUMN "contacts_granted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD COLUMN "contacts_state" jsonb;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "contacts_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "ews_url" text;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "ews_auth" text DEFAULT 'ntlm' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "external_etag" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "written_here" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_event_versions" ADD CONSTRAINT "calendar_event_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_versions" ADD CONSTRAINT "calendar_event_versions_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_versions" ADD CONSTRAINT "contact_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_versions" ADD CONSTRAINT "contact_versions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_event_versions_event_idx" ON "calendar_event_versions" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "contact_versions_contact_idx" ON "contact_versions" USING btree ("contact_id","created_at");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_calendar_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."calendar_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_external_uq" ON "contacts" USING btree ("account_id","external_id") WHERE "contacts"."account_id" is not null and "contacts"."deleted_at" is null;