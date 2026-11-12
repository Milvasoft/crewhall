CREATE TYPE "public"."mail_account_kind" AS ENUM('personal', 'shared');--> statement-breakpoint
CREATE TYPE "public"."mail_conversation_status" AS ENUM('open', 'pending', 'resolved');--> statement-breakpoint
CREATE TABLE "mail_canned_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"title" text NOT NULL,
	"html" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_conversation_notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"inbox_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"customer_name" text,
	"customer_address" text,
	"status" "mail_conversation_status" DEFAULT 'open' NOT NULL,
	"assignee_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"first_message_at" timestamp with time zone NOT NULL,
	"first_inbound_at" timestamp with time zone,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"status_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_shared_inboxes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sla_first_response_minutes" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "mail_accounts_org_user_idx";--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "kind" "mail_account_kind" DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "folders" jsonb;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD COLUMN "folders_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_canned_responses" ADD CONSTRAINT "mail_canned_responses_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_canned_responses" ADD CONSTRAINT "mail_canned_responses_inbox_id_mail_shared_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."mail_shared_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_canned_responses" ADD CONSTRAINT "mail_canned_responses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_conversation_notes" ADD CONSTRAINT "mail_conversation_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_conversation_notes" ADD CONSTRAINT "mail_conversation_notes_conversation_id_mail_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."mail_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_conversation_notes" ADD CONSTRAINT "mail_conversation_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_conversations" ADD CONSTRAINT "mail_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_conversations" ADD CONSTRAINT "mail_conversations_inbox_id_mail_shared_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."mail_shared_inboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_conversations" ADD CONSTRAINT "mail_conversations_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_shared_inboxes" ADD CONSTRAINT "mail_shared_inboxes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_shared_inboxes" ADD CONSTRAINT "mail_shared_inboxes_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_shared_inboxes" ADD CONSTRAINT "mail_shared_inboxes_account_id_mail_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."mail_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_shared_inboxes" ADD CONSTRAINT "mail_shared_inboxes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_canned_responses_inbox_idx" ON "mail_canned_responses" USING btree ("inbox_id");--> statement-breakpoint
CREATE INDEX "mail_conversation_notes_conversation_idx" ON "mail_conversation_notes" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_conversations_thread_idx" ON "mail_conversations" USING btree ("inbox_id","thread_id");--> statement-breakpoint
CREATE INDEX "mail_conversations_list_idx" ON "mail_conversations" USING btree ("inbox_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "mail_conversations_assignee_idx" ON "mail_conversations" USING btree ("inbox_id","assignee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_shared_inboxes_account_idx" ON "mail_shared_inboxes" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "mail_shared_inboxes_space_idx" ON "mail_shared_inboxes" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "mail_shared_inboxes_org_idx" ON "mail_shared_inboxes" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_org_user_idx" ON "mail_accounts" USING btree ("org_id","user_id") WHERE "mail_accounts"."kind" = 'personal';