CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired', 'stale', 'applied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mcp_client_registration" AS ENUM('dcr', 'admin', 'builtin');--> statement-breakpoint
CREATE TYPE "public"."mcp_client_status" AS ENUM('allowed', 'pending', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."tool_call_result" AS ENUM('ok', 'error', 'pending_approval');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"space_ids" uuid[],
	"allowed_ips" text[],
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"via_grant_id" uuid,
	"via_token_id" uuid,
	"via_name" text NOT NULL,
	"tool_call_id" bigint,
	"action" text NOT NULL,
	"tool" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"preview" jsonb NOT NULL,
	"target_revs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"client_note" text,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"reject_reason" text,
	"error_code" text,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_auth_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"grant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_auth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"software_id" text,
	"software_version" text,
	"client_uri" text,
	"logo_uri" text,
	"redirect_uris" text[] NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"client_secret_hash" text,
	"registration" "mcp_client_registration" DEFAULT 'dcr' NOT NULL,
	"status" "mcp_client_status" DEFAULT 'allowed' NOT NULL,
	"registered_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"label" text,
	"scopes" text[] NOT NULL,
	"space_ids" uuid[],
	"resource" text NOT NULL,
	"refresh_hash" text,
	"prev_refresh_hash" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_grants_refresh_hash_unique" UNIQUE("refresh_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"pats_enabled" boolean DEFAULT true NOT NULL,
	"guests_allowed" boolean DEFAULT false NOT NULL,
	"client_mode" text DEFAULT 'all' NOT NULL,
	"max_token_days" integer DEFAULT 90,
	"allowed_scopes" text[] NOT NULL,
	"approval_rules" text[] NOT NULL,
	"requests_per_minute" integer DEFAULT 60 NOT NULL,
	"writes_per_minute" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_rate_buckets" (
	"org_id" uuid,
	"subject" text NOT NULL,
	"kind" text NOT NULL,
	"tokens" double precision NOT NULL,
	"allowed" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_rate_buckets_subject_kind_pk" PRIMARY KEY("subject","kind")
);
--> statement-breakpoint
CREATE TABLE "mcp_reauth" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tool_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"via_grant_id" uuid,
	"via_token_id" uuid,
	"via_name" text NOT NULL,
	"tool" text NOT NULL,
	"write" boolean DEFAULT false NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_label" text,
	"result" "tool_call_result" NOT NULL,
	"error_code" text,
	"summary" text,
	"approval_id" uuid,
	"undo" jsonb,
	"undone_at" timestamp with time zone,
	"request_id" text,
	"duration_ms" integer,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_via_grant_id_mcp_grants_id_fk" FOREIGN KEY ("via_grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_via_token_id_api_tokens_id_fk" FOREIGN KEY ("via_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_access_tokens" ADD CONSTRAINT "mcp_access_tokens_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_auth_codes" ADD CONSTRAINT "mcp_auth_codes_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_clients" ADD CONSTRAINT "mcp_clients_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_client_id_mcp_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_policies" ADD CONSTRAINT "mcp_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_rate_buckets" ADD CONSTRAINT "mcp_rate_buckets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_reauth" ADD CONSTRAINT "mcp_reauth_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_reauth" ADD CONSTRAINT "mcp_reauth_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_reauth" ADD CONSTRAINT "mcp_reauth_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_via_grant_id_mcp_grants_id_fk" FOREIGN KEY ("via_grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_via_token_id_api_tokens_id_fk" FOREIGN KEY ("via_token_id") REFERENCES "public"."api_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "api_tokens_org_idx" ON "api_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "approval_requests_user_status_idx" ON "approval_requests" USING btree ("user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_requests_expiry_idx" ON "approval_requests" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "mcp_access_tokens_grant_idx" ON "mcp_access_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "mcp_clients_org_idx" ON "mcp_clients" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "mcp_grants_user_idx" ON "mcp_grants" USING btree ("user_id","revoked_at");--> statement-breakpoint
CREATE INDEX "mcp_grants_org_idx" ON "mcp_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "mcp_grants_prev_refresh_idx" ON "mcp_grants" USING btree ("prev_refresh_hash");--> statement-breakpoint
CREATE INDEX "tool_calls_user_at_idx" ON "tool_calls" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_calls_org_at_idx" ON "tool_calls" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tool_calls_grant_idx" ON "tool_calls" USING btree ("via_grant_id","created_at" DESC NULLS LAST);