CREATE TYPE "public"."meeting_transcript_status" AS ENUM('queued', 'transcribing', 'summarizing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "meeting_transcripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"recording_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"status" "meeting_transcript_status" DEFAULT 'queued' NOT NULL,
	"error" text,
	"language" text,
	"text" text,
	"segments" jsonb,
	"summary" text,
	"decisions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_node_id" uuid,
	"run_id" uuid,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "transcription_url" text;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "transcription_model" text;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "meeting_notes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_page_node_id_nodes_id_fk" FOREIGN KEY ("page_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_transcripts" ADD CONSTRAINT "meeting_transcripts_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_transcripts_recording_uq" ON "meeting_transcripts" USING btree ("recording_id");--> statement-breakpoint
CREATE INDEX "meeting_transcripts_meeting_idx" ON "meeting_transcripts" USING btree ("meeting_id");