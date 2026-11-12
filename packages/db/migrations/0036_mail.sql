CREATE TYPE "public"."mail_account_status" AS ENUM('ok', 'auth_failed', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."mail_auth_mode" AS ENUM('password', 'oauth_microsoft', 'oauth_google');--> statement-breakpoint
CREATE TYPE "public"."mail_security" AS ENUM('tls', 'starttls', 'none');--> statement-breakpoint
CREATE TABLE "mail_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"username" text NOT NULL,
	"auth_mode" "mail_auth_mode" NOT NULL,
	"password_enc" text,
	"oauth_access_enc" text,
	"oauth_refresh_enc" text,
	"oauth_expires_at" timestamp with time zone,
	"status" "mail_account_status" DEFAULT 'ok' NOT NULL,
	"signature_html" text DEFAULT '' NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"inbox_uid_validity" bigint,
	"inbox_last_uid" bigint,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_recent_recipients" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"use_count" integer DEFAULT 1 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_recent_recipients_org_id_user_id_address_pk" PRIMARY KEY("org_id","user_id","address")
);
--> statement-breakpoint
CREATE TABLE "mail_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"imap_security" "mail_security" NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_security" "mail_security" NOT NULL,
	"auth_mode" "mail_auth_mode" DEFAULT 'password' NOT NULL,
	"username_format" text DEFAULT 'email' NOT NULL,
	"oauth_client_id" text,
	"oauth_client_secret_enc" text,
	"oauth_tenant" text,
	"save_sent_copy" boolean DEFAULT true NOT NULL,
	"allow_remote_images" boolean DEFAULT true NOT NULL,
	"poll_minutes" integer DEFAULT 5 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_accounts" ADD CONSTRAINT "mail_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_oauth_states" ADD CONSTRAINT "mail_oauth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_oauth_states" ADD CONSTRAINT "mail_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_recent_recipients" ADD CONSTRAINT "mail_recent_recipients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_recent_recipients" ADD CONSTRAINT "mail_recent_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_settings" ADD CONSTRAINT "mail_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_accounts_org_user_idx" ON "mail_accounts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "mail_accounts_org_idx" ON "mail_accounts" USING btree ("org_id");