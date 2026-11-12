CREATE TYPE "public"."conversation_type" AS ENUM('direct', 'group', 'space', 'meeting', 'alert', 'card');--> statement-breakpoint
CREATE TYPE "public"."digest_frequency" AS ENUM('off', 'hourly', 'daily');--> statement-breakpoint
CREATE TYPE "public"."mention_kind" AS ENUM('user', 'all', 'here');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('user', 'webhook', 'system');--> statement-breakpoint
CREATE TYPE "public"."notify_level" AS ENUM('all', 'critical', 'mentions', 'none');--> statement-breakpoint
CREATE TYPE "public"."push_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."status_visibility" AS ENUM('online', 'busy', 'dnd', 'away', 'invisible');--> statement-breakpoint
CREATE TABLE "chat_user_settings" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_receipts" boolean DEFAULT true NOT NULL,
	"timezone" text,
	"visibility" "status_visibility" DEFAULT 'online' NOT NULL,
	"visibility_until" timestamp with time zone,
	"status_text" text,
	"status_emoji" text,
	"status_expires_at" timestamp with time zone,
	"auto_meeting" boolean DEFAULT true NOT NULL,
	"digest" "digest_frequency" DEFAULT 'daily' NOT NULL,
	"quiet_from" text,
	"quiet_to" text,
	"last_digest_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_user_settings_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"history_from_seq" bigint,
	"pinned_at" timestamp with time zone,
	"pin_position" integer,
	"notify" "notify_level" NOT NULL,
	"muted_until" timestamp with time zone,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"type" "conversation_type" NOT NULL,
	"space_id" uuid,
	"meeting_id" uuid,
	"name" text COLLATE "tr-x-icu",
	"avatar_blob_id" uuid,
	"attachments_node_id" uuid,
	"direct_key" text,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incoming_webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"name" text COLLATE "tr-x-icu" NOT NULL,
	"avatar_blob_id" uuid,
	"token_hash" text NOT NULL,
	"rate_limit" integer DEFAULT 60 NOT NULL,
	"last_used_at" timestamp with time zone,
	"muted_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"failing_notified_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mentions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" "mention_kind" NOT NULL,
	"user_id" uuid,
	"notified_user_id" uuid,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"message_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_attachments_message_id_node_id_pk" PRIMARY KEY("message_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"kind" "message_kind" DEFAULT 'user' NOT NULL,
	"author_id" uuid,
	"webhook_id" uuid,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"reply_to_id" uuid,
	"client_msg_id" uuid,
	"pinned_at" timestamp with time zone,
	"pinned_by" uuid,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', case when "messages"."deleted_at" is null then "messages"."text" else '' end)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"in_app" boolean NOT NULL,
	"push" boolean NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_org_id_user_id_category_pk" PRIMARY KEY("org_id","user_id","category")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"category" text NOT NULL,
	"actor_id" uuid,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"conversation_id" uuid,
	"seq" bigint,
	"space_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"url" text NOT NULL,
	"group_key" text,
	"count" integer DEFAULT 1 NOT NULL,
	"wants_push" boolean DEFAULT false NOT NULL,
	"wants_email" boolean DEFAULT false NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"pushed_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expo_token" text NOT NULL,
	"platform" "push_platform" NOT NULL,
	"app_version" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_expo_token_unique" UNIQUE("expo_token")
);
--> statement-breakpoint
CREATE TABLE "push_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"ticket_id" text NOT NULL,
	"notification_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"emoji" text NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "read_states" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_states_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"ip" text,
	"latency_ms" integer NOT NULL,
	"error" text,
	"body_excerpt" text,
	"message_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ws_tickets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "chat_user_settings" ADD CONSTRAINT "chat_user_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_user_settings" ADD CONSTRAINT "chat_user_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_avatar_blob_id_blobs_id_fk" FOREIGN KEY ("avatar_blob_id") REFERENCES "public"."blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_attachments_node_id_nodes_id_fk" FOREIGN KEY ("attachments_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD CONSTRAINT "incoming_webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD CONSTRAINT "incoming_webhooks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD CONSTRAINT "incoming_webhooks_avatar_blob_id_blobs_id_fk" FOREIGN KEY ("avatar_blob_id") REFERENCES "public"."blobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD CONSTRAINT "incoming_webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_notified_user_id_users_id_fk" FOREIGN KEY ("notified_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_webhook_id_incoming_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."incoming_webhooks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_device_id_push_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."push_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reactions" ADD CONSTRAINT "reactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_states" ADD CONSTRAINT "read_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_incoming_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."incoming_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ws_tickets" ADD CONSTRAINT "ws_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_members_user_idx" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_org_last_idx" ON "conversations" USING btree ("org_id","last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_space_idx" ON "conversations" USING btree ("space_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_direct_uq" ON "conversations" USING btree ("org_id","direct_key") WHERE "conversations"."direct_key" is not null;--> statement-breakpoint
CREATE INDEX "incoming_webhooks_conversation_idx" ON "incoming_webhooks" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "mentions_message_idx" ON "mentions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mentions_notified_idx" ON "mentions" USING btree ("notified_user_id","conversation_id","seq");--> statement-breakpoint
CREATE INDEX "message_attachments_conversation_idx" ON "message_attachments" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "message_attachments_node_idx" ON "message_attachments" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_seq_uq" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_author_client_uq" ON "messages" USING btree ("author_id","client_msg_id") WHERE "messages"."client_msg_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_conversation_updated_idx" ON "messages" USING btree ("conversation_id","updated_at");--> statement-breakpoint
CREATE INDEX "messages_pinned_idx" ON "messages" USING btree ("conversation_id","pinned_at") WHERE "messages"."pinned_at" is not null;--> statement-breakpoint
CREATE INDEX "messages_search_gin" ON "messages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","org_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_group_uq" ON "notifications" USING btree ("user_id","org_id","group_key") WHERE "notifications"."group_key" is not null and "notifications"."read_at" is null and "notifications"."dismissed_at" is null;--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id","org_id") WHERE "notifications"."read_at" is null and "notifications"."dismissed_at" is null;--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "push_tickets_pending_idx" ON "push_tickets" USING btree ("created_at") WHERE "push_tickets"."checked_at" is null;--> statement-breakpoint
CREATE INDEX "reactions_user_idx" ON "reactions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "read_states_user_idx" ON "read_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_idx" ON "webhook_deliveries" USING btree ("webhook_id","received_at");--> statement-breakpoint
CREATE INDEX "ws_tickets_expires_idx" ON "ws_tickets" USING btree ("expires_at");