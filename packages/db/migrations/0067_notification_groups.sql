ALTER TABLE "notification_prefs" ADD COLUMN "desktop" boolean;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "wants_desktop" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD COLUMN "muted_until" timestamp with time zone;