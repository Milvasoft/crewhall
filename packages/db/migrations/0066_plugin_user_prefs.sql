ALTER TABLE "plugin_notification_prefs" ADD COLUMN "bell" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_notification_prefs" ADD COLUMN "desktop" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_notification_prefs" ADD COLUMN "push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plugin_notification_prefs" ADD COLUMN "show_mobile" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- API 31 modes as channels: muted = bell only, off = nothing.
UPDATE "plugin_notification_prefs" SET "desktop" = false, "push" = false WHERE "mode" = 'muted';--> statement-breakpoint
UPDATE "plugin_notification_prefs" SET "bell" = false, "desktop" = false, "push" = false WHERE "mode" = 'off';