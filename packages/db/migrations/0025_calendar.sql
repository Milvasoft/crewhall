CREATE TYPE "public"."calendar_attendee_response" AS ENUM('needs_action', 'accepted', 'declined', 'tentative');--> statement-breakpoint
CREATE TYPE "public"."calendar_event_status" AS ENUM('confirmed', 'tentative', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."calendar_kind" AS ENUM('personal', 'team', 'space');--> statement-breakpoint
CREATE TYPE "public"."calendar_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "calendar_attendees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"email" "citext" NOT NULL,
	"name" text,
	"response" "calendar_attendee_response" DEFAULT 'needs_action' NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"uid" text NOT NULL,
	"dav_name" text,
	"parent_id" uuid,
	"recurrence_id" text,
	"title" text COLLATE "tr-x-icu" NOT NULL,
	"description" text,
	"location" text,
	"all_day" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"start_date" text,
	"end_date" text,
	"time_zone" text NOT NULL,
	"rrule" text,
	"series_ends_at" timestamp with time zone,
	"exdates" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "calendar_event_status" DEFAULT 'confirmed' NOT NULL,
	"busy" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'default' NOT NULL,
	"reminders" integer[],
	"organizer_id" uuid,
	"sequence" integer DEFAULT 0 NOT NULL,
	"extra" jsonb,
	"created_by" uuid,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_members" (
	"org_id" uuid NOT NULL,
	"calendar_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "calendar_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_members_calendar_id_user_id_pk" PRIMARY KEY("calendar_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_reminder_log" (
	"org_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"occurrence" text NOT NULL,
	"minutes" integer NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_reminder_log_event_id_user_id_occurrence_minutes_pk" PRIMARY KEY("event_id","user_id","occurrence","minutes")
);
--> statement-breakpoint
CREATE TABLE "calendar_user_settings" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_user_settings_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "calendar_kind" NOT NULL,
	"owner_id" uuid,
	"space_id" uuid,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"color" text DEFAULT 's1' NOT NULL,
	"description" text,
	"change_seq" bigint DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_attendees" ADD CONSTRAINT "calendar_attendees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_attendees" ADD CONSTRAINT "calendar_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_attendees" ADD CONSTRAINT "calendar_attendees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_members" ADD CONSTRAINT "calendar_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminder_log" ADD CONSTRAINT "calendar_reminder_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminder_log" ADD CONSTRAINT "calendar_reminder_log_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reminder_log" ADD CONSTRAINT "calendar_reminder_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_user_settings" ADD CONSTRAINT "calendar_user_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_user_settings" ADD CONSTRAINT "calendar_user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_attendees_event_email_uq" ON "calendar_attendees" USING btree ("event_id","email");--> statement-breakpoint
CREATE INDEX "calendar_attendees_user_idx" ON "calendar_attendees" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_uid_uq" ON "calendar_events" USING btree ("calendar_id","uid") WHERE "calendar_events"."parent_id" is null and "calendar_events"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_dav_name_uq" ON "calendar_events" USING btree ("calendar_id","dav_name") WHERE "calendar_events"."dav_name" is not null and "calendar_events"."parent_id" is null and "calendar_events"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_override_uq" ON "calendar_events" USING btree ("parent_id","recurrence_id") WHERE "calendar_events"."parent_id" is not null and "calendar_events"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "calendar_events_range_idx" ON "calendar_events" USING btree ("calendar_id","starts_at");--> statement-breakpoint
CREATE INDEX "calendar_events_org_idx" ON "calendar_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "calendar_members_user_idx" ON "calendar_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "calendar_reminder_log_sent_idx" ON "calendar_reminder_log" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "calendars_org_idx" ON "calendars" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_personal_uq" ON "calendars" USING btree ("org_id","owner_id") WHERE "calendars"."kind" = 'personal' and "calendars"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_space_uq" ON "calendars" USING btree ("space_id") WHERE "calendars"."kind" = 'space';