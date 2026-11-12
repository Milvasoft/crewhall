ALTER TYPE "public"."ai_provider" ADD VALUE 'openai' BEFORE 'openai_compatible';--> statement-breakpoint
ALTER TYPE "public"."ai_provider" ADD VALUE 'gemini' BEFORE 'openai_compatible';--> statement-breakpoint
ALTER TYPE "public"."ai_provider" ADD VALUE 'mistral' BEFORE 'openai_compatible';--> statement-breakpoint
ALTER TYPE "public"."ai_provider" ADD VALUE 'azure_openai' BEFORE 'openai_compatible';--> statement-breakpoint
ALTER TYPE "public"."ai_provider" ADD VALUE 'openrouter' BEFORE 'openai_compatible';--> statement-breakpoint
ALTER TABLE "ai_settings" ADD COLUMN "api_version" text;