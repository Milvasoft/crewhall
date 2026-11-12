CREATE TABLE "chat_gif_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"api_key_enc" text,
	"api_key_hint" text,
	"api_key_updated_at" timestamp with time zone,
	"rating" text DEFAULT 'g' NOT NULL,
	"lang" text DEFAULT 'tr' NOT NULL,
	"key_tier" text DEFAULT 'beta' NOT NULL,
	"usage_hour" timestamp with time zone,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_gif_settings" ADD CONSTRAINT "chat_gif_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_gif_settings" ADD CONSTRAINT "chat_gif_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;