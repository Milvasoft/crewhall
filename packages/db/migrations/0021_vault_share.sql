CREATE TABLE "vault_policies" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"breach_check" boolean DEFAULT true NOT NULL,
	"breach_range_url" text,
	"share_links" boolean DEFAULT true NOT NULL,
	"share_max_hours" integer DEFAULT 720 NOT NULL,
	"share_max_views" integer DEFAULT 20 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"max_views" integer NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vault_policies" ADD CONSTRAINT "vault_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_policies" ADD CONSTRAINT "vault_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_vault_id_vault_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vault_vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_shares" ADD CONSTRAINT "vault_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_shares_token_uq" ON "vault_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "vault_shares_item_idx" ON "vault_shares" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "vault_shares_expires_idx" ON "vault_shares" USING btree ("expires_at");