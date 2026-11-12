CREATE TABLE "chat_read_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"from_seq" bigint NOT NULL,
	"to_seq" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "celebration_posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "celebration_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid,
	"birthdays" boolean DEFAULT true NOT NULL,
	"anniversaries" boolean DEFAULT true NOT NULL,
	"kudos" boolean DEFAULT false NOT NULL,
	"time_zone" text DEFAULT 'Europe/Istanbul' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kudos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"from_user_id" uuid,
	"to_user_id" uuid NOT NULL,
	"badge_id" uuid,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kudos_badges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text,
	"emoji" text NOT NULL,
	"name" text,
	"position" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD COLUMN "events" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "incoming_webhooks" ADD COLUMN "secret_enc" text;--> statement-breakpoint
ALTER TABLE "read_states" ADD COLUMN "marked_unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD COLUMN "birthday" text;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD COLUMN "birthday_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_profiles" ADD COLUMN "started_on" text;--> statement-breakpoint
ALTER TABLE "chat_read_marks" ADD CONSTRAINT "chat_read_marks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_marks" ADD CONSTRAINT "chat_read_marks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_read_marks" ADD CONSTRAINT "chat_read_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "celebration_posts" ADD CONSTRAINT "celebration_posts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "celebration_posts" ADD CONSTRAINT "celebration_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "celebration_settings" ADD CONSTRAINT "celebration_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "celebration_settings" ADD CONSTRAINT "celebration_settings_channel_id_conversations_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos" ADD CONSTRAINT "kudos_badge_id_kudos_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."kudos_badges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kudos_badges" ADD CONSTRAINT "kudos_badges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_read_marks_conv_idx" ON "chat_read_marks" USING btree ("conversation_id","to_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "celebration_posts_uq" ON "celebration_posts" USING btree ("org_id","kind","user_id","day");--> statement-breakpoint
CREATE INDEX "kudos_org_idx" ON "kudos" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "kudos_to_idx" ON "kudos" USING btree ("org_id","to_user_id","created_at");--> statement-breakpoint
CREATE INDEX "kudos_badges_org_idx" ON "kudos_badges" USING btree ("org_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "kudos_badges_org_key_uq" ON "kudos_badges" USING btree ("org_id","key") WHERE "kudos_badges"."key" is not null;