ALTER TABLE "spaces" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "visibility" text DEFAULT 'invite_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;