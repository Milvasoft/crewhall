CREATE TYPE "public"."scheduled_message_status" AS ENUM('scheduled', 'sending', 'sent', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "chat_scheduled_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"reply_to_id" uuid,
	"attachment_node_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"confirm_mention_all" boolean DEFAULT false NOT NULL,
	"send_at" timestamp with time zone NOT NULL,
	"status" "scheduled_message_status" DEFAULT 'scheduled' NOT NULL,
	"error" text,
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_scheduled_messages" ADD CONSTRAINT "chat_scheduled_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_scheduled_messages" ADD CONSTRAINT "chat_scheduled_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_scheduled_messages" ADD CONSTRAINT "chat_scheduled_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_scheduled_messages" ADD CONSTRAINT "chat_scheduled_messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_scheduled_messages" ADD CONSTRAINT "chat_scheduled_messages_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_scheduled_due_idx" ON "chat_scheduled_messages" USING btree ("send_at") WHERE "chat_scheduled_messages"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "chat_scheduled_author_idx" ON "chat_scheduled_messages" USING btree ("author_id","conversation_id");