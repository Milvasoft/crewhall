CREATE TYPE "public"."meeting_call_status" AS ENUM('ringing', 'active', 'ended', 'missed', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "meeting_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"caller_id" uuid,
	"video" boolean DEFAULT false NOT NULL,
	"status" "meeting_call_status" DEFAULT 'ringing' NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"upgraded" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_calls" ADD CONSTRAINT "meeting_calls_caller_id_users_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_calls_conversation_idx" ON "meeting_calls" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "meeting_calls_meeting_idx" ON "meeting_calls" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_calls_live_uq" ON "meeting_calls" USING btree ("conversation_id") WHERE "meeting_calls"."status" in ('ringing', 'active');