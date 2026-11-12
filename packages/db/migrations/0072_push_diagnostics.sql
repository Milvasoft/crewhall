ALTER TABLE "notifications" ADD COLUMN "push_skip" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "push_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "disabled_reason" text;