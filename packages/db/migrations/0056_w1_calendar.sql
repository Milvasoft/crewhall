CREATE TYPE "public"."booking_kind" AS ENUM('room', 'desk');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'checked_in', 'released', 'cancelled');--> statement-breakpoint
CREATE TABLE "booking_resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "booking_kind" NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"location" text,
	"capacity" integer,
	"equipment" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text,
	"check_in_required" boolean DEFAULT false NOT NULL,
	"check_in_grace_minutes" integer DEFAULT 15 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid,
	"own_event" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_accounts" ALTER COLUMN "refresh_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD COLUMN "delegated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_accounts" ADD COLUMN "busy_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "domain_wide" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "service_account_enc" text;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "delegated_admin" text;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "directory_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "directory_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calendar_integrations" ADD COLUMN "directory_error" text;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resource_id_booking_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."booking_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_resources_org_idx" ON "booking_resources" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "bookings_resource_idx" ON "bookings" USING btree ("resource_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_user_idx" ON "bookings" USING btree ("user_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_event_idx" ON "bookings" USING btree ("event_id");