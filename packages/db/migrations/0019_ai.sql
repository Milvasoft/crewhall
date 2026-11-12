CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'openai_compatible');--> statement-breakpoint
CREATE TYPE "public"."ai_run_status" AS ENUM('ok', 'error', 'refused');--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"model" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"status" "ai_run_status" DEFAULT 'ok' NOT NULL,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider" "ai_provider" DEFAULT 'anthropic' NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"api_key_enc" text,
	"api_key_hint" text,
	"api_key_updated_at" timestamp with time zone,
	"org_monthly_tokens" integer,
	"user_monthly_tokens" integer,
	"last_test" jsonb,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_org_at_idx" ON "ai_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_user_at_idx" ON "ai_runs" USING btree ("org_id","user_id","created_at");