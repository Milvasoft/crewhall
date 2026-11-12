CREATE TABLE "auth_lockouts" (
	"email" "citext" PRIMARY KEY NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"last_failed_at" timestamp with time zone,
	"last_failed_ip" text,
	"locked_until" timestamp with time zone,
	"lock_level" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mobile_connect_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_connect_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mobile_handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"code_challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mobile_handoffs_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "mobile_connect_tokens" ADD CONSTRAINT "mobile_connect_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_connect_tokens" ADD CONSTRAINT "mobile_connect_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_handoffs" ADD CONSTRAINT "mobile_handoffs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mobile_handoffs" ADD CONSTRAINT "mobile_handoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mobile_connect_tokens_user_idx" ON "mobile_connect_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mobile_handoffs_user_idx" ON "mobile_handoffs" USING btree ("user_id");