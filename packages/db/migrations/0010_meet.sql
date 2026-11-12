CREATE TYPE "public"."meeting_lobby_status" AS ENUM('waiting', 'admitted', 'denied', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."meeting_kind" AS ENUM('chat', 'room', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."meeting_recurrence" AS ENUM('none', 'daily', 'weekdays', 'weekly');--> statement-breakpoint
CREATE TYPE "public"."meeting_role" AS ENUM('moderator', 'member', 'listener', 'guest');--> statement-breakpoint
CREATE TYPE "public"."recording_status" AS ENUM('starting', 'recording', 'processing', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "meet_space_settings" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"guests_allowed" boolean DEFAULT true NOT NULL,
	"editors_can_record" boolean DEFAULT true NOT NULL,
	"recording_retention_days" integer DEFAULT 180,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_invitees" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid,
	"email" text,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_lobby" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"secret_hash" text,
	"status" "meeting_lobby_status" DEFAULT 'waiting' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"identity" text NOT NULL,
	"participant_sid" text,
	"user_id" uuid,
	"guest_name" text,
	"role" "meeting_role" NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"room_sid" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"started_by" uuid,
	"peak_participants" integer DEFAULT 0 NOT NULL,
	"removed_identities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "meeting_kind" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"space_id" uuid,
	"conversation_id" uuid,
	"chat_conversation_id" uuid,
	"room_name" text NOT NULL,
	"join_slug" text NOT NULL,
	"host_user_id" uuid,
	"starts_at" timestamp with time zone,
	"duration_minutes" integer,
	"recurrence" "meeting_recurrence" DEFAULT 'none' NOT NULL,
	"settings" jsonb NOT NULL,
	"ics_sequence" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meetings_room_name_unique" UNIQUE("room_name"),
	CONSTRAINT "meetings_join_slug_unique" UNIQUE("join_slug")
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"session_id" uuid,
	"egress_id" text,
	"status" "recording_status" DEFAULT 'starting' NOT NULL,
	"audio_only" boolean DEFAULT false NOT NULL,
	"storage_key" text NOT NULL,
	"space_id" uuid,
	"blob_id" uuid,
	"node_id" uuid,
	"duration_s" integer,
	"size_bytes" bigint,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_egress_id_unique" UNIQUE("egress_id")
);
--> statement-breakpoint
ALTER TABLE "meet_space_settings" ADD CONSTRAINT "meet_space_settings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_space_settings" ADD CONSTRAINT "meet_space_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitees" ADD CONSTRAINT "meeting_invitees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitees" ADD CONSTRAINT "meeting_invitees_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitees" ADD CONSTRAINT "meeting_invitees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitees" ADD CONSTRAINT "meeting_invitees_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_lobby" ADD CONSTRAINT "meeting_lobby_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_lobby" ADD CONSTRAINT "meeting_lobby_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_lobby" ADD CONSTRAINT "meeting_lobby_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_lobby" ADD CONSTRAINT "meeting_lobby_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_invitees_user_uq" ON "meeting_invitees" USING btree ("meeting_id","user_id") WHERE "meeting_invitees"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_invitees_email_uq" ON "meeting_invitees" USING btree ("meeting_id",lower("email")) WHERE "meeting_invitees"."email" is not null;--> statement-breakpoint
CREATE INDEX "meeting_lobby_meeting_idx" ON "meeting_lobby" USING btree ("meeting_id","status");--> statement-breakpoint
CREATE INDEX "meeting_participants_session_idx" ON "meeting_participants" USING btree ("session_id","identity");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_participants_sid_uq" ON "meeting_participants" USING btree ("session_id","participant_sid") WHERE "meeting_participants"."participant_sid" is not null;--> statement-breakpoint
CREATE INDEX "meeting_sessions_meeting_idx" ON "meeting_sessions" USING btree ("meeting_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_sessions_live_uq" ON "meeting_sessions" USING btree ("meeting_id") WHERE "meeting_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "meetings_org_starts_idx" ON "meetings" USING btree ("org_id","starts_at");--> statement-breakpoint
CREATE INDEX "meetings_space_idx" ON "meetings" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meetings_conversation_chat_uq" ON "meetings" USING btree ("conversation_id") WHERE "meetings"."kind" = 'chat' and "meetings"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "recordings_meeting_idx" ON "recordings" USING btree ("meeting_id","started_at");--> statement-breakpoint
CREATE INDEX "recordings_status_idx" ON "recordings" USING btree ("status");