CREATE TABLE "chat_poll_votes" (
	"poll_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"option" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_poll_votes_poll_id_user_id_option_pk" PRIMARY KEY("poll_id","user_id","option")
);
--> statement-breakpoint
CREATE TABLE "chat_polls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"multiple" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_polls_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "chat_reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"text" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "whisper_to" uuid;--> statement-breakpoint
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_poll_id_chat_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."chat_polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reminders" ADD CONSTRAINT "chat_reminders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reminders" ADD CONSTRAINT "chat_reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reminders" ADD CONSTRAINT "chat_reminders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_polls_conversation_idx" ON "chat_polls" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "chat_reminders_due_idx" ON "chat_reminders" USING btree ("remind_at") WHERE "chat_reminders"."fired_at" is null;--> statement-breakpoint
CREATE INDEX "chat_reminders_user_idx" ON "chat_reminders" USING btree ("user_id","org_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_whisper_to_users_id_fk" FOREIGN KEY ("whisper_to") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;