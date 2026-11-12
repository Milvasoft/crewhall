CREATE TABLE "delivery_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"email_mode" text DEFAULT 'env' NOT NULL,
	"smtp_host" text,
	"smtp_port" integer,
	"smtp_security" text DEFAULT 'starttls' NOT NULL,
	"smtp_username" text,
	"smtp_password_enc" text,
	"smtp_password_updated_at" timestamp with time zone,
	"smtp_from" text,
	"push_mode" text DEFAULT 'env' NOT NULL,
	"fcm_service_account_enc" text,
	"fcm_project_id" text,
	"fcm_updated_at" timestamp with time zone,
	"expo_access_token_enc" text,
	"expo_updated_at" timestamp with time zone,
	"notifike_base_url" text,
	"notifike_api_key_enc" text,
	"notifike_api_key_hint" text,
	"notifike_api_key_updated_at" timestamp with time zone,
	"notifike_auth_failed_at" timestamp with time zone,
	"last_email_test" jsonb,
	"last_push_test" jsonb,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "push_tickets" ADD COLUMN "provider" text DEFAULT 'expo' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_settings" ADD CONSTRAINT "delivery_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_settings" ADD CONSTRAINT "delivery_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;