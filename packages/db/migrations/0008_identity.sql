CREATE TYPE "public"."directory_status" AS ENUM('active', 'disabled', 'missing');--> statement-breakpoint
CREATE TYPE "public"."identity_provider_kind" AS ENUM('oidc', 'saml', 'ldap');--> statement-breakpoint
CREATE TYPE "public"."oidc_client_type" AS ENUM('web', 'spa', 'native');--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"dn" text,
	"email" text,
	"groups" text[] DEFAULT '{}' NOT NULL,
	"directory_status" "directory_status" DEFAULT 'active' NOT NULL,
	"suspended_by_sync" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_auth_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text,
	"code_verifier" text,
	"callback_url" text NOT NULL,
	"error_callback_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_auth_states_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "identity_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"security" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"oidc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "identity_provider_kind" NOT NULL,
	"preset" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"domains" text[] DEFAULT '{}' NOT NULL,
	"enforce_sso" boolean DEFAULT false NOT NULL,
	"jit_provisioning" boolean DEFAULT true NOT NULL,
	"default_role" text DEFAULT 'member' NOT NULL,
	"link_existing_by_email" boolean DEFAULT true NOT NULL,
	"trust_idp_mfa" boolean DEFAULT false NOT NULL,
	"sync_roles" boolean DEFAULT true NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"role_mappings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"secret_enc" text,
	"last_test_at" timestamp with time zone,
	"last_test_ok" boolean,
	"last_error" text,
	"last_sync_at" timestamp with time zone,
	"last_sync_ok" boolean,
	"last_sync" jsonb,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_sessions" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"id_token" text,
	"name_id" text,
	"session_index" text,
	"mfa" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_auth_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"redirect_uri" text NOT NULL,
	"scopes" text[] NOT NULL,
	"nonce" text,
	"code_challenge" text,
	"auth_time" timestamp with time zone NOT NULL,
	"amr" text[] DEFAULT '{}' NOT NULL,
	"consumed_at" timestamp with time zone,
	"refresh_token_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_auth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oidc_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"secret_hint" text,
	"secret_expires_at" timestamp with time zone,
	"name" text NOT NULL,
	"type" "oidc_client_type" DEFAULT 'web' NOT NULL,
	"homepage_url" text,
	"logo_url" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[] DEFAULT '{}' NOT NULL,
	"scopes" text[] NOT NULL,
	"skip_consent" boolean DEFAULT true NOT NULL,
	"access_space_id" uuid,
	"guests_allowed" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_login_user_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oidc_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"token_hash" text NOT NULL,
	"prev_token_hash" text,
	"scopes" text[] NOT NULL,
	"auth_time" timestamp with time zone NOT NULL,
	"amr" text[] DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "oidc_signing_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"alg" text DEFAULT 'RS256' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key_enc" text NOT NULL,
	"retired_at" timestamp with time zone,
	"remove_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_signing_keys_kid_unique" UNIQUE("kid")
);
--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_auth_states" ADD CONSTRAINT "identity_auth_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_auth_states" ADD CONSTRAINT "identity_auth_states_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_policies" ADD CONSTRAINT "identity_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_policies" ADD CONSTRAINT "identity_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_sessions" ADD CONSTRAINT "identity_sessions_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_auth_codes" ADD CONSTRAINT "oidc_auth_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_auth_codes" ADD CONSTRAINT "oidc_auth_codes_client_id_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_auth_codes" ADD CONSTRAINT "oidc_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_access_space_id_spaces_id_fk" FOREIGN KEY ("access_space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_last_login_user_id_users_id_fk" FOREIGN KEY ("last_login_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_clients" ADD CONSTRAINT "oidc_clients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_client_id_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_consents" ADD CONSTRAINT "oidc_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_client_id_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_refresh_tokens" ADD CONSTRAINT "oidc_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_signing_keys" ADD CONSTRAINT "oidc_signing_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_subject_uq" ON "external_identities" USING btree ("provider_id","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "external_identities_user_uq" ON "external_identities" USING btree ("provider_id","user_id");--> statement-breakpoint
CREATE INDEX "external_identities_user_idx" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_auth_states_expires_idx" ON "identity_auth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "identity_providers_org_idx" ON "identity_providers" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "oidc_auth_codes_expires_idx" ON "oidc_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oidc_clients_org_idx" ON "oidc_clients" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oidc_consents_uq" ON "oidc_consents" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "oidc_refresh_tokens_prev_idx" ON "oidc_refresh_tokens" USING btree ("prev_token_hash");--> statement-breakpoint
CREATE INDEX "oidc_refresh_tokens_user_idx" ON "oidc_refresh_tokens" USING btree ("user_id","client_id");