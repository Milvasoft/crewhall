ALTER TABLE "ai_runs" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "fast_model" text;