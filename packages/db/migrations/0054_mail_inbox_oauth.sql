ALTER TABLE "mail_accounts" ADD COLUMN "oauth_user" text;--> statement-breakpoint
ALTER TABLE "mail_conversations" ADD COLUMN "inbound_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_oauth_states" ADD COLUMN "inbox_id" uuid;--> statement-breakpoint
ALTER TABLE "mail_oauth_states" ADD CONSTRAINT "mail_oauth_states_inbox_id_mail_shared_inboxes_id_fk" FOREIGN KEY ("inbox_id") REFERENCES "public"."mail_shared_inboxes"("id") ON DELETE cascade ON UPDATE no action;